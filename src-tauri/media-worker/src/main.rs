use myagents_media_worker::model_pack_source::verify_installed_pack;
use myagents_media_worker::native_adapter::{AsrEngine, VadEngine};
use myagents_media_worker::native_bundle::{LoadedNativeAdapter, verify_native_bundle};
use myagents_media_worker::protocol::{
    Checkpoint, ManagerFrame, PROTOCOL_VERSION, PcmFrame, PcmStreamCheckpoint, PcmStreamEnd,
    PcmStreamStart, TrackKind, WorkerCommand, WorkerMetrics, WorkerResponse, WorkerStage,
    WorkloadIdentity, WorkloadInput, WorkloadKind, read_manager_frame, write_control_frame,
};
use std::io::{self, BufReader, BufWriter, StdinLock, StdoutLock, Write};
use std::path::Path;
use std::time::Instant;
use zeroize::Zeroize;

fn main() {
    if let Err(code) = run() {
        eprintln!("myagents-media-worker terminated: {code}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), &'static str> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    let first = read_manager_frame(&mut reader).map_err(|_| "SPEECH_WORKER_PROTOCOL_ERROR")?;
    let Some(ManagerFrame::Control(WorkerCommand::Start(start))) = first else {
        return Err("SPEECH_WORKER_PROTOCOL_ERROR");
    };
    if !start.has_valid_shape() {
        return Err("SPEECH_WORKER_PROTOCOL_ERROR");
    }
    let identity = start.identity.clone();
    if let Err(code) = run_started(start, &mut reader, &mut writer) {
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
    reader: &mut BufReader<StdinLock<'_>>,
    writer: &mut BufWriter<StdoutLock<'_>>,
) -> Result<(), &'static str> {
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
        (WorkloadKind::RecordLiveAsr, WorkloadInput::LivePcm { streams }) => {
            run_live(&start.identity, streams, &adapter, &models, reader, writer)
        }
        _ => Err("SPEECH_WORKLOAD_NOT_READY"),
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
                    WorkerCommand::Yield { .. } | WorkerCommand::Start(_) => {
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
