use myagents_media_worker::attachment_audio::{AttachmentAudioDecoder, AttachmentAudioError};
use myagents_media_worker::diarization::{
    BoundedDiarizationConfig, DiarizationError, LocalSpeakerObservation, WindowObservation,
    WindowSpec, consolidate_diarization,
};
use myagents_media_worker::model_pack_source::verify_installed_pack;
use myagents_media_worker::native_adapter::{AsrEngine, VadEngine};
use myagents_media_worker::native_bundle::{LoadedNativeAdapter, verify_native_bundle};
use myagents_media_worker::protocol::{
    Checkpoint, ManagerFrame, PROTOCOL_VERSION, PcmFrame, PcmStreamCheckpoint, PcmStreamEnd,
    PcmStreamStart, RecordArtifactInput, TrackKind, WorkerCommand, WorkerMetrics, WorkerResponse,
    WorkerStage, WorkloadIdentity, WorkloadInput, WorkloadKind, read_manager_frame,
    write_control_frame,
};
use myagents_media_worker::record_opus::{RecordOpusError, RecordOpusMixer};
use std::io::{self, BufReader, BufWriter, StdinLock, StdoutLock, Write};
use std::path::Path;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};
use zeroize::{Zeroize, Zeroizing};

fn main() {
    if let Err(code) = run() {
        eprintln!("myagents-media-worker terminated: {code}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), &'static str> {
    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    let first = {
        let stdin = io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        read_manager_frame(&mut reader).map_err(|_| "SPEECH_WORKER_PROTOCOL_ERROR")?
    };
    let Some(ManagerFrame::Control(WorkerCommand::Start(start))) = first else {
        return Err("SPEECH_WORKER_PROTOCOL_ERROR");
    };
    if !start.has_valid_shape() {
        return Err("SPEECH_WORKER_PROTOCOL_ERROR");
    }
    let identity = start.identity.clone();
    if let Err(code) = run_started(start, &mut writer) {
        write_response(
            &mut writer,
            WorkerResponse::Failed {
                protocol_version: PROTOCOL_VERSION,
                identity,
                code: code.into(),
            },
        )?;
    }
    Ok(())
}

fn run_started(
    start: myagents_media_worker::protocol::StartRequest,
    writer: &mut BufWriter<StdoutLock<'_>>,
) -> Result<(), &'static str> {
    if let (WorkloadKind::AttachmentProbe, WorkloadInput::Attachment { input_path }) =
        (&start.workload_kind, &start.input)
    {
        return run_attachment_probe(&start.identity, input_path, writer);
    }
    let current_worker =
        std::env::current_exe().map_err(|_| "SPEECH_NATIVE_RUNTIME_UNAVAILABLE")?;
    let native = verify_native_bundle(
        Path::new(&start.native_manifest_path),
        Path::new(&start.onnx_runtime_path),
        &current_worker,
    )
    .map_err(|_| "SPEECH_NATIVE_RUNTIME_UNAVAILABLE")?;
    let models = verify_installed_pack(Path::new(&start.model_pack_manifest_path))
        .map_err(|_| "SPEECH_MODEL_PACK_UNAVAILABLE")?;
    let adapter =
        LoadedNativeAdapter::load(&native).map_err(|_| "SPEECH_NATIVE_RUNTIME_UNAVAILABLE")?;
    match (&start.workload_kind, &start.input) {
        (WorkloadKind::ModelPackProbe, WorkloadInput::ModelPackProbe) => {
            run_model_pack_probe(&start.identity, &adapter, &models, writer)
        }
        (WorkloadKind::RecordLiveAsr, WorkloadInput::LivePcm { streams }) => {
            let stdin = io::stdin();
            let mut reader = BufReader::new(stdin.lock());
            run_live(
                &start.identity,
                streams,
                &adapter,
                &models,
                &mut reader,
                writer,
            )
        }
        (WorkloadKind::RecordBackfillAsr, WorkloadInput::RecordArtifacts { inputs }) => {
            run_record_backfill(&start.identity, inputs, &adapter, &models, writer)
        }
        (WorkloadKind::RecordDiarization, WorkloadInput::RecordArtifacts { inputs }) => {
            run_record_diarization(&start.identity, inputs, &adapter, &models, writer)
        }
        (WorkloadKind::AttachmentAsr, WorkloadInput::Attachment { input_path }) => {
            run_attachment_asr(&start.identity, input_path, &adapter, &models, writer)
        }
        _ => Err("SPEECH_WORKLOAD_NOT_READY"),
    }
}

fn run_attachment_probe(
    identity: &WorkloadIdentity,
    input_path: &str,
    writer: &mut BufWriter<StdoutLock<'_>>,
) -> Result<(), &'static str> {
    let decoder =
        AttachmentAudioDecoder::open(Path::new(input_path)).map_err(map_attachment_decode_error)?;
    let info = decoder.info();
    write_response(
        writer,
        WorkerResponse::Ready {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
        },
    )?;
    write_response(
        writer,
        WorkerResponse::MediaProbed {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            media_kind: info.media_kind.into(),
            codec: info.codec.into(),
            duration_ms: info.duration_ms,
            used_default_track: info.used_default_track,
        },
    )
}

fn run_model_pack_probe(
    identity: &WorkloadIdentity,
    adapter: &LoadedNativeAdapter,
    models: &myagents_media_worker::model_pack_source::VerifiedModelPack,
    writer: &mut BufWriter<StdoutLock<'_>>,
) -> Result<(), &'static str> {
    {
        let _asr = adapter
            .create_asr(models)
            .map_err(|_| "SPEECH_ASR_MODEL_LOAD_FAILED")?;
    }
    {
        let _vad = adapter
            .create_vad(models)
            .map_err(|_| "SPEECH_VAD_MODEL_LOAD_FAILED")?;
    }
    {
        let _diarizer = adapter
            .create_diarizer(models)
            .map_err(|_| "SPEECH_DIARIZATION_MODEL_LOAD_FAILED")?;
    }
    write_response(
        writer,
        WorkerResponse::Ready {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
        },
    )
}

fn run_record_diarization(
    identity: &WorkloadIdentity,
    inputs: &[RecordArtifactInput],
    adapter: &LoadedNativeAdapter,
    models: &myagents_media_worker::model_pack_source::VerifiedModelPack,
    writer: &mut BufWriter<StdoutLock<'_>>,
) -> Result<(), &'static str> {
    let started_at = Instant::now();
    let controls = start_batch_control_reader()?;
    let mut diarizer = adapter
        .create_diarizer(models)
        .map_err(|_| "SPEECH_MODEL_LOAD_FAILED")?;
    let mut checkpoints = inputs
        .iter()
        .map(|input| PcmStreamCheckpoint {
            track: input.track,
            last_ack_sequence: None,
            analysis_sample: 0,
        })
        .collect::<Vec<_>>();
    write_response(
        writer,
        WorkerResponse::Ready {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
        },
    )?;
    write_response(
        writer,
        WorkerResponse::Heartbeat {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            stage: WorkerStage::Decoding,
            checkpoint: batch_checkpoint(&checkpoints),
        },
    )?;

    let config = BoundedDiarizationConfig::default();
    let window_samples =
        usize::try_from(config.window_samples).map_err(|_| "SPEECH_RESOURCE_LIMIT")?;
    let step_samples = usize::try_from(config.window_samples - config.overlap_samples)
        .map_err(|_| "SPEECH_RESOURCE_LIMIT")?;
    let paths = inputs
        .iter()
        .map(|input| Path::new(&input.input_path))
        .collect::<Vec<_>>();
    let mut decoder = RecordOpusMixer::open(&paths).map_err(map_record_decode_error)?;
    let mut pcm = Zeroizing::new(Vec::with_capacity(window_samples));
    let mut observations = SensitiveObservations::default();
    let mut window_start = 0_u64;
    let mut window_index = 0_u32;
    let mut total_samples = 0_u64;
    while let Some(chunk) = decoder.read_chunk().map_err(map_record_decode_error)? {
        if poll_batch_control(identity, &controls, &checkpoints, writer)? {
            return Ok(());
        }
        if chunk.start_sample() != total_samples {
            return Err("SPEECH_CORRUPT_MEDIA");
        }
        let chunk_end = total_samples
            .checked_add(chunk.samples().len() as u64)
            .ok_or("SPEECH_RESOURCE_LIMIT")?;
        let mut consumed = 0_usize;
        while consumed < chunk.samples().len() {
            let available = window_samples - pcm.len();
            let take = available.min(chunk.samples().len() - consumed);
            pcm.extend_from_slice(&chunk.samples()[consumed..consumed + take]);
            consumed += take;
            if pcm.len() == window_samples {
                write_response(
                    writer,
                    WorkerResponse::Heartbeat {
                        protocol_version: PROTOCOL_VERSION,
                        identity: identity.clone(),
                        stage: WorkerStage::SegmentingSpeakers,
                        checkpoint: batch_checkpoint(&checkpoints),
                    },
                )?;
                let end_sample = window_start
                    .checked_add(config.window_samples)
                    .ok_or("SPEECH_RESOURCE_LIMIT")?;
                let window = WindowSpec {
                    index: window_index,
                    start_sample: window_start,
                    end_sample,
                };
                let mut embedding_heartbeat_error = None;
                let observation = diarizer
                    .diarize_window(window, &pcm, || {
                        embedding_heartbeat_error = write_response(
                            writer,
                            WorkerResponse::Heartbeat {
                                protocol_version: PROTOCOL_VERSION,
                                identity: identity.clone(),
                                stage: WorkerStage::EmbeddingSpeakers,
                                checkpoint: batch_checkpoint(&checkpoints),
                            },
                        )
                        .err();
                    })
                    .map_err(|_| "SPEECH_INFERENCE_FAILED")?;
                if let Some(error) = embedding_heartbeat_error {
                    return Err(error);
                }
                observations.0.push(observation);
                pcm[..step_samples].zeroize();
                pcm.drain(..step_samples);
                window_start = window_start
                    .checked_add(step_samples as u64)
                    .ok_or("SPEECH_RESOURCE_LIMIT")?;
                window_index = window_index.checked_add(1).ok_or("SPEECH_RESOURCE_LIMIT")?;
                for (checkpoint, stream_position) in
                    checkpoints.iter_mut().zip(decoder.stream_positions())
                {
                    checkpoint.analysis_sample = stream_position.min(window_start);
                }
                write_response(
                    writer,
                    WorkerResponse::Heartbeat {
                        protocol_version: PROTOCOL_VERSION,
                        identity: identity.clone(),
                        stage: WorkerStage::Decoding,
                        checkpoint: batch_checkpoint(&checkpoints),
                    },
                )?;
                if poll_batch_control(identity, &controls, &checkpoints, writer)? {
                    return Ok(());
                }
            }
        }
        total_samples = chunk_end;
    }
    let summary = decoder.summary().ok_or("SPEECH_CORRUPT_MEDIA")?;
    if summary.output_samples_16k != total_samples
        || summary.track_output_samples_16k.len() != checkpoints.len()
        || pcm.len() as u64 != total_samples.saturating_sub(window_start)
    {
        return Err("SPEECH_CORRUPT_MEDIA");
    }
    if total_samples == 0 {
        return Err("SPEECH_NO_AUDIO_TRACK");
    }
    let last_observation_end = observations
        .0
        .last()
        .map_or(0, |observation| observation.window.end_sample);
    if last_observation_end < total_samples {
        let window = WindowSpec {
            index: window_index,
            start_sample: window_start,
            end_sample: total_samples,
        };
        write_response(
            writer,
            WorkerResponse::Heartbeat {
                protocol_version: PROTOCOL_VERSION,
                identity: identity.clone(),
                stage: WorkerStage::SegmentingSpeakers,
                checkpoint: batch_checkpoint(&checkpoints),
            },
        )?;
        let mut embedding_heartbeat_error = None;
        let observation = diarizer
            .diarize_window(window, &pcm, || {
                embedding_heartbeat_error = write_response(
                    writer,
                    WorkerResponse::Heartbeat {
                        protocol_version: PROTOCOL_VERSION,
                        identity: identity.clone(),
                        stage: WorkerStage::EmbeddingSpeakers,
                        checkpoint: batch_checkpoint(&checkpoints),
                    },
                )
                .err();
            })
            .map_err(|_| "SPEECH_INFERENCE_FAILED")?;
        if let Some(error) = embedding_heartbeat_error {
            return Err(error);
        }
        observations.0.push(observation);
    }
    pcm.zeroize();
    for (checkpoint, stream_samples) in checkpoints.iter_mut().zip(summary.track_output_samples_16k)
    {
        checkpoint.analysis_sample = stream_samples;
    }
    if poll_batch_control(identity, &controls, &checkpoints, writer)? {
        return Ok(());
    }
    write_response(
        writer,
        WorkerResponse::Heartbeat {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            stage: WorkerStage::ClusteringSpeakers,
            checkpoint: batch_checkpoint(&checkpoints),
        },
    )?;
    let mut reconciliation_heartbeat_error = None;
    let projection = consolidate_diarization(
        total_samples,
        &observations.0,
        config,
        |embeddings, distance_threshold| {
            adapter
                .cluster_embeddings(embeddings, distance_threshold)
                .map_err(|_| DiarizationError::InvalidClusterLabels)
        },
        || {
            reconciliation_heartbeat_error = write_response(
                writer,
                WorkerResponse::Heartbeat {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    stage: WorkerStage::ReconcilingSpeakers,
                    checkpoint: batch_checkpoint(&checkpoints),
                },
            )
            .err();
        },
    )
    .map_err(map_diarization_error)?;
    if let Some(error) = reconciliation_heartbeat_error {
        return Err(error);
    }
    let turns = projection
        .segments
        .iter()
        .map(|segment| myagents_media_worker::protocol::SpeakerTurn {
            start_sample: segment.start_sample,
            end_sample: segment.end_sample,
            global_speaker: segment.global_speaker,
        })
        .collect::<Vec<_>>();
    let batch_count = turns.len().max(1).div_ceil(1_000);
    for batch_index in 0..batch_count {
        if poll_batch_control(identity, &controls, &checkpoints, writer)? {
            return Ok(());
        }
        let start = (batch_index * 1_000).min(turns.len());
        let end = (start + 1_000).min(turns.len());
        write_response(
            writer,
            WorkerResponse::SpeakerTurnBatch {
                protocol_version: PROTOCOL_VERSION,
                identity: identity.clone(),
                revision: 1,
                batch_index: batch_index as u32,
                is_last: batch_index + 1 == batch_count,
                turns: turns[start..end].to_vec(),
            },
        )?;
    }
    write_response(
        writer,
        WorkerResponse::Completed {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            metrics: WorkerMetrics {
                source_samples: total_samples,
                segments: projection.segments.len() as u32,
                speakers: projection.speaker_count,
                elapsed_ms: started_at.elapsed().as_millis() as u64,
                peak_working_bytes: None,
            },
        },
    )
}

#[derive(Default)]
struct SensitiveObservations(Vec<WindowObservation>);

impl Drop for SensitiveObservations {
    fn drop(&mut self) {
        for observation in &mut self.0 {
            for LocalSpeakerObservation { embedding, .. } in &mut observation.speakers {
                embedding.zeroize();
            }
        }
    }
}

fn run_record_backfill(
    identity: &WorkloadIdentity,
    inputs: &[RecordArtifactInput],
    adapter: &LoadedNativeAdapter,
    models: &myagents_media_worker::model_pack_source::VerifiedModelPack,
    writer: &mut BufWriter<StdoutLock<'_>>,
) -> Result<(), &'static str> {
    let started_at = Instant::now();
    let controls = start_batch_control_reader()?;
    let mut asr = adapter
        .create_asr(models)
        .map_err(|_| "SPEECH_MODEL_LOAD_FAILED")?;
    let mut checkpoints = inputs
        .iter()
        .map(|input| PcmStreamCheckpoint {
            track: input.track,
            last_ack_sequence: None,
            analysis_sample: 0,
        })
        .collect::<Vec<_>>();
    write_response(
        writer,
        WorkerResponse::Ready {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
        },
    )?;
    write_response(
        writer,
        WorkerResponse::Heartbeat {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            stage: WorkerStage::Decoding,
            checkpoint: batch_checkpoint(&checkpoints),
        },
    )?;

    let mut revision = 0_u64;
    let mut emitted_segments = 0_u32;
    let mut source_samples = 0_u64;
    let output_track = record_backfill_output_track(inputs)?;
    let paths = inputs
        .iter()
        .map(|input| Path::new(&input.input_path))
        .collect::<Vec<_>>();
    let mut decoder = RecordOpusMixer::open(&paths).map_err(map_record_decode_error)?;
    let mut vad = adapter
        .create_vad(models)
        .map_err(|_| "SPEECH_MODEL_LOAD_FAILED")?;
    let mut last_heartbeat_at = Instant::now();
    while let Some(chunk) = decoder.read_chunk().map_err(map_record_decode_error)? {
        if poll_batch_control(identity, &controls, &checkpoints, writer)? {
            return Ok(());
        }
        if chunk.start_sample() != source_samples {
            return Err("SPEECH_CORRUPT_MEDIA");
        }
        vad.accept(chunk.samples())
            .map_err(|_| "SPEECH_INFERENCE_FAILED")?;
        source_samples = source_samples
            .checked_add(chunk.samples().len() as u64)
            .ok_or("SPEECH_RESOURCE_LIMIT")?;
        for (checkpoint, stream_position) in checkpoints.iter_mut().zip(decoder.stream_positions())
        {
            checkpoint.analysis_sample = stream_position;
        }
        emitted_segments = emitted_segments.saturating_add(drain_batch_vad(
            &mut vad,
            output_track,
            source_samples,
            &mut asr,
            identity,
            &mut revision,
            writer,
        )?);
        if last_heartbeat_at.elapsed() >= Duration::from_secs(2) {
            last_heartbeat_at = Instant::now();
            write_response(
                writer,
                WorkerResponse::Heartbeat {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    stage: WorkerStage::Transcribing,
                    checkpoint: batch_checkpoint(&checkpoints),
                },
            )?;
        }
    }
    let summary = decoder.summary().ok_or("SPEECH_CORRUPT_MEDIA")?;
    if summary.output_samples_16k != source_samples
        || summary.track_output_samples_16k.len() != checkpoints.len()
    {
        return Err("SPEECH_CORRUPT_MEDIA");
    }
    for (checkpoint, stream_samples) in checkpoints.iter_mut().zip(summary.track_output_samples_16k)
    {
        checkpoint.analysis_sample = stream_samples;
    }
    vad.flush().map_err(|_| "SPEECH_INFERENCE_FAILED")?;
    emitted_segments = emitted_segments.saturating_add(drain_batch_vad(
        &mut vad,
        output_track,
        source_samples,
        &mut asr,
        identity,
        &mut revision,
        writer,
    )?);
    write_response(
        writer,
        WorkerResponse::Heartbeat {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            stage: WorkerStage::Finalizing,
            checkpoint: batch_checkpoint(&checkpoints),
        },
    )?;
    if poll_batch_control(identity, &controls, &checkpoints, writer)? {
        return Ok(());
    }
    write_response(
        writer,
        WorkerResponse::Completed {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            metrics: WorkerMetrics {
                source_samples,
                segments: emitted_segments,
                speakers: 0,
                elapsed_ms: started_at.elapsed().as_millis() as u64,
                peak_working_bytes: None,
            },
        },
    )
}

fn record_backfill_output_track(inputs: &[RecordArtifactInput]) -> Result<TrackKind, &'static str> {
    match inputs {
        [input] => Ok(input.track),
        [_, _] => Ok(TrackKind::Mixed),
        _ => Err("SPEECH_WORKER_PROTOCOL_ERROR"),
    }
}

fn run_attachment_asr(
    identity: &WorkloadIdentity,
    input_path: &str,
    adapter: &LoadedNativeAdapter,
    models: &myagents_media_worker::model_pack_source::VerifiedModelPack,
    writer: &mut BufWriter<StdoutLock<'_>>,
) -> Result<(), &'static str> {
    let started_at = Instant::now();
    let controls = start_batch_control_reader()?;
    let mut decoder =
        AttachmentAudioDecoder::open(Path::new(input_path)).map_err(map_attachment_decode_error)?;
    let info = decoder.info();
    let mut asr = adapter
        .create_asr(models)
        .map_err(|_| "SPEECH_MODEL_LOAD_FAILED")?;
    let mut vad = adapter
        .create_vad(models)
        .map_err(|_| "SPEECH_MODEL_LOAD_FAILED")?;
    let mut checkpoints = vec![PcmStreamCheckpoint {
        track: TrackKind::Attachment,
        last_ack_sequence: None,
        analysis_sample: 0,
    }];
    write_response(
        writer,
        WorkerResponse::Ready {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
        },
    )?;
    write_response(
        writer,
        WorkerResponse::MediaProbed {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            media_kind: info.media_kind.into(),
            codec: info.codec.into(),
            duration_ms: info.duration_ms,
            used_default_track: info.used_default_track,
        },
    )?;

    let mut revision = 0_u64;
    let mut emitted_segments = 0_u32;
    let mut last_heartbeat_at = Instant::now();
    while let Some(chunk) = decoder.read_chunk().map_err(map_attachment_decode_error)? {
        if poll_batch_control(identity, &controls, &checkpoints, writer)? {
            return Ok(());
        }
        if chunk.start_sample() != checkpoints[0].analysis_sample {
            return Err("SPEECH_CORRUPT_MEDIA");
        }
        vad.accept(chunk.samples())
            .map_err(|_| "SPEECH_INFERENCE_FAILED")?;
        checkpoints[0].analysis_sample = checkpoints[0]
            .analysis_sample
            .checked_add(chunk.samples().len() as u64)
            .ok_or("SPEECH_RESOURCE_LIMIT")?;
        emitted_segments = emitted_segments.saturating_add(drain_batch_vad(
            &mut vad,
            TrackKind::Attachment,
            checkpoints[0].analysis_sample,
            &mut asr,
            identity,
            &mut revision,
            writer,
        )?);
        if last_heartbeat_at.elapsed() >= Duration::from_secs(2) {
            last_heartbeat_at = Instant::now();
            write_response(
                writer,
                WorkerResponse::Heartbeat {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    stage: WorkerStage::Transcribing,
                    checkpoint: batch_checkpoint(&checkpoints),
                },
            )?;
        }
    }
    if decoder.output_samples() != checkpoints[0].analysis_sample {
        return Err("SPEECH_CORRUPT_MEDIA");
    }
    vad.flush().map_err(|_| "SPEECH_INFERENCE_FAILED")?;
    emitted_segments = emitted_segments.saturating_add(drain_batch_vad(
        &mut vad,
        TrackKind::Attachment,
        checkpoints[0].analysis_sample,
        &mut asr,
        identity,
        &mut revision,
        writer,
    )?);
    if poll_batch_control(identity, &controls, &checkpoints, writer)? {
        return Ok(());
    }
    write_response(
        writer,
        WorkerResponse::Heartbeat {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            stage: WorkerStage::Finalizing,
            checkpoint: batch_checkpoint(&checkpoints),
        },
    )?;
    write_response(
        writer,
        WorkerResponse::Completed {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            metrics: WorkerMetrics {
                source_samples: checkpoints[0].analysis_sample,
                segments: emitted_segments,
                speakers: 0,
                elapsed_ms: started_at.elapsed().as_millis() as u64,
                peak_working_bytes: None,
            },
        },
    )
}

enum BatchControl {
    Command(WorkerCommand),
    ProtocolError,
    Disconnected,
}

fn start_batch_control_reader() -> Result<Receiver<BatchControl>, &'static str> {
    let (sender, receiver) = mpsc::sync_channel(16);
    thread::Builder::new()
        .name("media-worker-control".into())
        .spawn(move || {
            let stdin = io::stdin();
            let mut reader = BufReader::new(stdin.lock());
            loop {
                let control = match read_manager_frame(&mut reader) {
                    Ok(Some(ManagerFrame::Control(command))) => BatchControl::Command(command),
                    Ok(Some(ManagerFrame::Pcm(mut pcm))) => {
                        pcm.samples.zeroize();
                        BatchControl::ProtocolError
                    }
                    Ok(None) => BatchControl::Disconnected,
                    Err(_) => BatchControl::ProtocolError,
                };
                let terminal = matches!(
                    control,
                    BatchControl::ProtocolError | BatchControl::Disconnected
                );
                if sender.send(control).is_err() || terminal {
                    break;
                }
            }
        })
        .map_err(|_| "SPEECH_WORKER_IO_ERROR")?;
    Ok(receiver)
}

fn poll_batch_control(
    identity: &WorkloadIdentity,
    controls: &Receiver<BatchControl>,
    checkpoints: &[PcmStreamCheckpoint],
    writer: &mut BufWriter<StdoutLock<'_>>,
) -> Result<bool, &'static str> {
    loop {
        let control = match controls.try_recv() {
            Ok(control) => control,
            Err(TryRecvError::Empty) => return Ok(false),
            Err(TryRecvError::Disconnected) => return Err("SPEECH_WORKER_DISCONNECTED"),
        };
        let BatchControl::Command(command) = control else {
            return Err(match control {
                BatchControl::ProtocolError => "SPEECH_WORKER_PROTOCOL_ERROR",
                BatchControl::Disconnected => "SPEECH_WORKER_DISCONNECTED",
                BatchControl::Command(_) => unreachable!(),
            });
        };
        if !command.has_valid_shape() || command.identity() != identity {
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        }
        match command {
            WorkerCommand::Yield { .. } => {
                write_response(
                    writer,
                    WorkerResponse::Yielded {
                        protocol_version: PROTOCOL_VERSION,
                        identity: identity.clone(),
                        checkpoint: batch_checkpoint(checkpoints),
                    },
                )?;
                return Ok(true);
            }
            WorkerCommand::Cancel { .. } => return Err("SPEECH_CANCELLED"),
            WorkerCommand::Ping { nonce, .. } => write_response(
                writer,
                WorkerResponse::Pong {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    nonce,
                },
            )?,
            WorkerCommand::Start(_)
            | WorkerCommand::Finalize { .. }
            | WorkerCommand::Flush { .. } => {
                return Err("SPEECH_WORKER_PROTOCOL_ERROR");
            }
        }
    }
}

fn batch_checkpoint(checkpoints: &[PcmStreamCheckpoint]) -> Checkpoint {
    Checkpoint {
        streams: checkpoints.to_vec(),
        analysis_sample: checkpoints
            .iter()
            .map(|checkpoint| checkpoint.analysis_sample)
            .max()
            .unwrap_or(0),
    }
}

fn drain_batch_vad(
    vad: &mut VadEngine<'_>,
    track: TrackKind,
    analysis_sample: u64,
    asr: &mut AsrEngine<'_>,
    identity: &WorkloadIdentity,
    revision: &mut u64,
    writer: &mut BufWriter<StdoutLock<'_>>,
) -> Result<u32, &'static str> {
    let mut emitted = 0_u32;
    loop {
        let Some(mut segment) = vad.pop().map_err(|_| "SPEECH_INFERENCE_FAILED")? else {
            break;
        };
        let end_sample = segment
            .start_sample
            .checked_add(segment.samples.len() as u64)
            .ok_or("SPEECH_RESOURCE_LIMIT")?;
        if end_sample > analysis_sample {
            segment.samples.zeroize();
            return Err("SPEECH_INFERENCE_FAILED");
        }
        let transcript = asr.transcribe(&segment.samples);
        segment.samples.zeroize();
        let mut transcript = transcript.map_err(|_| "SPEECH_INFERENCE_FAILED")?;
        if transcript.text.trim().is_empty() {
            transcript.zeroize_sensitive();
            continue;
        }
        let Some(next_revision) = revision.checked_add(1) else {
            transcript.zeroize_sensitive();
            return Err("SPEECH_RESOURCE_LIMIT");
        };
        *revision = next_revision;
        let (text, language) = transcript.into_publication();
        write_response(
            writer,
            WorkerResponse::TranscriptSegment {
                protocol_version: PROTOCOL_VERSION,
                identity: identity.clone(),
                segment_id: format!("segment-{revision}"),
                track,
                start_sample: segment.start_sample,
                end_sample,
                text,
                language,
                revision: *revision,
            },
        )?;
        emitted = emitted.saturating_add(1);
    }
    Ok(emitted)
}

fn map_record_decode_error(error: RecordOpusError) -> &'static str {
    match error {
        RecordOpusError::SourceUnavailable => "SPEECH_SOURCE_UNAVAILABLE",
        RecordOpusError::UnsafeSource => "SPEECH_SOURCE_UNSAFE",
        RecordOpusError::SourceTooLarge | RecordOpusError::DurationExceeded => {
            "SPEECH_MEDIA_LIMIT_EXCEEDED"
        }
        RecordOpusError::CorruptContainer | RecordOpusError::DecodeFailed => "SPEECH_CORRUPT_MEDIA",
        RecordOpusError::UnsupportedStream => "SPEECH_UNSUPPORTED_CODEC",
    }
}

fn map_attachment_decode_error(error: AttachmentAudioError) -> &'static str {
    match error {
        AttachmentAudioError::SourceUnavailable => "SPEECH_SOURCE_UNAVAILABLE",
        AttachmentAudioError::UnsafeSource => "SPEECH_SOURCE_UNSAFE",
        AttachmentAudioError::SourceTooLarge
        | AttachmentAudioError::DurationExceeded
        | AttachmentAudioError::ResourceLimit => "SPEECH_MEDIA_LIMIT_EXCEEDED",
        AttachmentAudioError::UnsupportedContainer | AttachmentAudioError::UnsupportedCodec => {
            "SPEECH_UNSUPPORTED_CODEC"
        }
        AttachmentAudioError::EncryptedMedia => "SPEECH_ENCRYPTED_MEDIA",
        AttachmentAudioError::NoAudioTrack => "SPEECH_NO_AUDIO_TRACK",
        AttachmentAudioError::CorruptMedia => "SPEECH_CORRUPT_MEDIA",
    }
}

fn map_diarization_error(error: DiarizationError) -> &'static str {
    match error {
        DiarizationError::InvalidDuration => "SPEECH_NO_AUDIO_TRACK",
        DiarizationError::ResourceLimit => "SPEECH_MEDIA_LIMIT_EXCEEDED",
        DiarizationError::InvalidConfiguration
        | DiarizationError::WindowPlanMismatch
        | DiarizationError::DuplicateLocalSpeaker
        | DiarizationError::InvalidEmbedding
        | DiarizationError::InvalidSegment
        | DiarizationError::InvalidClusterLabels => "SPEECH_INFERENCE_FAILED",
    }
}

fn run_live(
    identity: &WorkloadIdentity,
    stream_starts: &[PcmStreamStart],
    adapter: &LoadedNativeAdapter,
    models: &myagents_media_worker::model_pack_source::VerifiedModelPack,
    reader: &mut BufReader<StdinLock<'_>>,
    writer: &mut BufWriter<StdoutLock<'_>>,
) -> Result<(), &'static str> {
    let started_at = Instant::now();
    let mut asr = adapter
        .create_asr(models)
        .map_err(|_| "SPEECH_MODEL_LOAD_FAILED")?;
    let mut tracks = stream_starts
        .iter()
        .map(|stream| LiveTrack::new(stream, adapter, models))
        .collect::<Result<Vec<_>, _>>()?;
    write_response(
        writer,
        WorkerResponse::Ready {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
        },
    )?;

    let mut revision = 0_u64;
    let mut emitted_segments = 0_u32;
    let mut source_samples = 0_u64;
    loop {
        let frame = read_manager_frame(reader).map_err(|_| "SPEECH_WORKER_PROTOCOL_ERROR")?;
        match frame {
            Some(ManagerFrame::Pcm(mut pcm)) => {
                if pcm.protocol_version != PROTOCOL_VERSION
                    || pcm.worker_generation != identity.worker_generation
                {
                    pcm.samples.zeroize();
                    return Err("SPEECH_WORKER_PROTOCOL_ERROR");
                }
                let processed = (|| {
                    let track_index = tracks
                        .iter()
                        .position(|track| track.track == pcm.track)
                        .ok_or("SPEECH_WORKER_PROTOCOL_ERROR")?;
                    let mut newly_emitted = 0_u32;
                    if tracks[track_index].requires_gap_flush(&pcm)? {
                        tracks[track_index]
                            .vad
                            .flush()
                            .map_err(|_| "SPEECH_INFERENCE_FAILED")?;
                        newly_emitted = newly_emitted.saturating_add(drain_track(
                            track_index,
                            &mut tracks,
                            &mut asr,
                            identity,
                            &mut revision,
                            writer,
                        )?);
                        tracks[track_index]
                            .vad
                            .reset()
                            .map_err(|_| "SPEECH_INFERENCE_FAILED")?;
                        tracks[track_index].vad_base_sample = pcm.start_sample;
                    }
                    let mut samples = pcm
                        .samples
                        .iter()
                        .map(|sample| f32::from(*sample) / 32_768.0)
                        .collect::<Vec<_>>();
                    let accepted = tracks[track_index].vad.accept(&samples);
                    samples.zeroize();
                    accepted.map_err(|_| "SPEECH_INFERENCE_FAILED")?;
                    let end_sample = pcm
                        .start_sample
                        .checked_add(pcm.samples.len() as u64)
                        .ok_or("SPEECH_WORKER_PROTOCOL_ERROR")?;
                    source_samples = source_samples
                        .checked_add(pcm.samples.len() as u64)
                        .ok_or("SPEECH_RESOURCE_LIMIT")?;
                    tracks[track_index].accept_frame(&pcm, end_sample)?;
                    write_response(
                        writer,
                        WorkerResponse::InputAck {
                            protocol_version: PROTOCOL_VERSION,
                            identity: identity.clone(),
                            track: pcm.track,
                            sequence: pcm.sequence,
                            end_sample,
                        },
                    )?;
                    newly_emitted = newly_emitted.saturating_add(drain_track(
                        track_index,
                        &mut tracks,
                        &mut asr,
                        identity,
                        &mut revision,
                        writer,
                    )?);
                    write_response(
                        writer,
                        WorkerResponse::Heartbeat {
                            protocol_version: PROTOCOL_VERSION,
                            identity: identity.clone(),
                            stage: WorkerStage::Vad,
                            checkpoint: checkpoint(&tracks),
                        },
                    )?;
                    Ok::<u32, &'static str>(newly_emitted)
                })();
                pcm.samples.zeroize();
                emitted_segments = emitted_segments.saturating_add(processed?);
            }
            Some(ManagerFrame::Control(command)) => {
                if !command.has_valid_shape() || command.identity() != identity {
                    return Err("SPEECH_WORKER_PROTOCOL_ERROR");
                }
                match command {
                    WorkerCommand::Flush { .. } => {
                        for index in 0..tracks.len() {
                            tracks[index]
                                .vad
                                .flush()
                                .map_err(|_| "SPEECH_INFERENCE_FAILED")?;
                            emitted_segments = emitted_segments.saturating_add(drain_track(
                                index,
                                &mut tracks,
                                &mut asr,
                                identity,
                                &mut revision,
                                writer,
                            )?);
                            tracks[index]
                                .vad
                                .reset()
                                .map_err(|_| "SPEECH_INFERENCE_FAILED")?;
                            tracks[index].vad_base_sample = tracks[index].last_end_sample;
                        }
                        write_response(
                            writer,
                            WorkerResponse::Heartbeat {
                                protocol_version: PROTOCOL_VERSION,
                                identity: identity.clone(),
                                stage: WorkerStage::Vad,
                                checkpoint: checkpoint(&tracks),
                            },
                        )?;
                    }
                    WorkerCommand::Finalize { streams, .. } => {
                        validate_final_streams(&tracks, &streams)?;
                        for index in 0..tracks.len() {
                            tracks[index]
                                .vad
                                .flush()
                                .map_err(|_| "SPEECH_INFERENCE_FAILED")?;
                            emitted_segments = emitted_segments.saturating_add(drain_track(
                                index,
                                &mut tracks,
                                &mut asr,
                                identity,
                                &mut revision,
                                writer,
                            )?);
                        }
                        write_response(
                            writer,
                            WorkerResponse::Completed {
                                protocol_version: PROTOCOL_VERSION,
                                identity: identity.clone(),
                                metrics: WorkerMetrics {
                                    source_samples,
                                    segments: emitted_segments,
                                    speakers: 0,
                                    elapsed_ms: started_at.elapsed().as_millis() as u64,
                                    peak_working_bytes: None,
                                },
                            },
                        )?;
                        return Ok(());
                    }
                    WorkerCommand::Cancel { .. } => return Err("SPEECH_CANCELLED"),
                    WorkerCommand::Ping { nonce, .. } => write_response(
                        writer,
                        WorkerResponse::Pong {
                            protocol_version: PROTOCOL_VERSION,
                            identity: identity.clone(),
                            nonce,
                        },
                    )?,
                    WorkerCommand::Yield { .. } => {
                        write_response(
                            writer,
                            WorkerResponse::Yielded {
                                protocol_version: PROTOCOL_VERSION,
                                identity: identity.clone(),
                                checkpoint: checkpoint(&tracks),
                            },
                        )?;
                        return Ok(());
                    }
                    WorkerCommand::Start(_) => {
                        return Err("SPEECH_WORKER_PROTOCOL_ERROR");
                    }
                }
            }
            None => return Err("SPEECH_WORKER_DISCONNECTED"),
        }
    }
}

struct LiveTrack<'adapter> {
    track: TrackKind,
    next_sequence: u64,
    received_frames: u64,
    first_sample: u64,
    last_end_sample: u64,
    vad_base_sample: u64,
    vad: VadEngine<'adapter>,
}

impl<'adapter> LiveTrack<'adapter> {
    fn new(
        stream: &PcmStreamStart,
        adapter: &'adapter LoadedNativeAdapter,
        models: &myagents_media_worker::model_pack_source::VerifiedModelPack,
    ) -> Result<Self, &'static str> {
        Ok(Self {
            track: stream.track,
            next_sequence: stream.first_sequence,
            received_frames: 0,
            first_sample: stream.first_sample,
            last_end_sample: stream.first_sample,
            vad_base_sample: stream.first_sample,
            vad: adapter
                .create_vad(models)
                .map_err(|_| "SPEECH_MODEL_LOAD_FAILED")?,
        })
    }

    fn requires_gap_flush(&self, frame: &PcmFrame) -> Result<bool, &'static str> {
        if frame.sequence != self.next_sequence
            || (self.received_frames == 0 && frame.start_sample != self.first_sample)
            || frame.start_sample < self.last_end_sample
        {
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        }
        Ok(self.received_frames > 0 && frame.start_sample > self.last_end_sample)
    }

    fn accept_frame(&mut self, frame: &PcmFrame, end_sample: u64) -> Result<(), &'static str> {
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or("SPEECH_RESOURCE_LIMIT")?;
        self.received_frames = self
            .received_frames
            .checked_add(1)
            .ok_or("SPEECH_RESOURCE_LIMIT")?;
        self.last_end_sample = end_sample;
        if frame.track != self.track {
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        }
        Ok(())
    }

    fn last_sequence(&self) -> Option<u64> {
        (self.received_frames > 0).then(|| self.next_sequence - 1)
    }
}

fn drain_track(
    track_index: usize,
    tracks: &mut [LiveTrack<'_>],
    asr: &mut AsrEngine<'_>,
    identity: &WorkloadIdentity,
    revision: &mut u64,
    writer: &mut BufWriter<StdoutLock<'_>>,
) -> Result<u32, &'static str> {
    let mut emitted = 0_u32;
    loop {
        let Some(mut segment) = tracks[track_index]
            .vad
            .pop()
            .map_err(|_| "SPEECH_INFERENCE_FAILED")?
        else {
            break;
        };
        let start_sample = tracks[track_index]
            .vad_base_sample
            .checked_add(segment.start_sample)
            .ok_or("SPEECH_RESOURCE_LIMIT")?;
        let end_sample = start_sample
            .checked_add(segment.samples.len() as u64)
            .ok_or("SPEECH_RESOURCE_LIMIT")?;
        if end_sample > tracks[track_index].last_end_sample {
            segment.samples.zeroize();
            return Err("SPEECH_INFERENCE_FAILED");
        }
        let transcript = asr.transcribe(&segment.samples);
        segment.samples.zeroize();
        let mut transcript = transcript.map_err(|_| "SPEECH_INFERENCE_FAILED")?;
        if transcript.text.trim().is_empty() {
            transcript.zeroize_sensitive();
            continue;
        }
        let Some(next_revision) = revision.checked_add(1) else {
            transcript.zeroize_sensitive();
            return Err("SPEECH_RESOURCE_LIMIT");
        };
        *revision = next_revision;
        let (text, language) = transcript.into_publication();
        write_response(
            writer,
            WorkerResponse::TranscriptSegment {
                protocol_version: PROTOCOL_VERSION,
                identity: identity.clone(),
                segment_id: format!("segment-{revision}"),
                track: tracks[track_index].track,
                start_sample,
                end_sample,
                text,
                language,
                revision: *revision,
            },
        )?;
        emitted = emitted.saturating_add(1);
    }
    Ok(emitted)
}

fn validate_final_streams(
    tracks: &[LiveTrack<'_>],
    ends: &[PcmStreamEnd],
) -> Result<(), &'static str> {
    if tracks.len() != ends.len() {
        return Err("SPEECH_WORKER_PROTOCOL_ERROR");
    }
    for track in tracks {
        let end = ends
            .iter()
            .find(|end| end.track == track.track)
            .ok_or("SPEECH_WORKER_PROTOCOL_ERROR")?;
        if end.last_sequence != track.last_sequence() || end.final_sample < track.last_end_sample {
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        }
    }
    Ok(())
}

fn checkpoint(tracks: &[LiveTrack<'_>]) -> Checkpoint {
    Checkpoint {
        streams: tracks
            .iter()
            .map(|track| PcmStreamCheckpoint {
                track: track.track,
                last_ack_sequence: track.last_sequence(),
                analysis_sample: track.last_end_sample,
            })
            .collect(),
        analysis_sample: tracks
            .iter()
            .map(|track| track.last_end_sample)
            .max()
            .unwrap_or(0),
    }
}

fn write_response(
    writer: &mut BufWriter<StdoutLock<'_>>,
    mut response: WorkerResponse,
) -> Result<(), &'static str> {
    let result = write_control_frame(writer, &response)
        .and_then(|()| writer.flush())
        .map_err(|_| "SPEECH_WORKER_IO_ERROR");
    response.zeroize_sensitive();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record_input(track: TrackKind) -> RecordArtifactInput {
        RecordArtifactInput {
            input_path: format!("/{track:?}.opus"),
            track,
        }
    }

    #[test]
    fn record_backfill_publishes_one_record_wide_track() {
        assert_eq!(
            record_backfill_output_track(&[record_input(TrackKind::Microphone)]),
            Ok(TrackKind::Microphone)
        );
        assert_eq!(
            record_backfill_output_track(&[
                record_input(TrackKind::Microphone),
                record_input(TrackKind::System),
            ]),
            Ok(TrackKind::Mixed)
        );
    }
}
