//! Disk-first 16 kHz mono analysis spools for admitted live transcription.
//!
//! Each physical capture source owns one raw little-endian PCM16 file. The
//! fixed per-track files avoid inventing another media container while still
//! giving SpeechRecognitionManager durable, independently replayable offsets.

use ringbuf::traits::*;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use zeroize::Zeroize;

use super::audio::{
    create_realtime_ring, RealtimeTrackSink, SourceFormat, StreamingAudioResampler,
};
use crate::record::AudioTrackKind;

pub const ANALYSIS_SAMPLE_RATE: u32 = 16_000;
const ANALYSIS_RING_SECONDS: usize = 8;
const ANALYSIS_SYNC_SAMPLES: u64 = ANALYSIS_SAMPLE_RATE as u64;
const MAX_ANALYSIS_SAMPLES: u64 = ANALYSIS_SAMPLE_RATE as u64 * 60 * 60 * 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AnalysisProgressSnapshot {
    pub committed_samples: u64,
    pub finished: bool,
    pub error_code: Option<String>,
}

#[derive(Debug, Default)]
struct AnalysisProgress {
    committed_samples: u64,
    finished: bool,
    error_code: Option<String>,
}

#[derive(Clone)]
pub(crate) struct AnalysisSpoolSource {
    track: AudioTrackKind,
    path: PathBuf,
    progress: Arc<Mutex<AnalysisProgress>>,
}

impl AnalysisSpoolSource {
    pub fn track(&self) -> AudioTrackKind {
        self.track
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn snapshot(&self) -> AnalysisProgressSnapshot {
        match self.progress.lock() {
            Ok(progress) => AnalysisProgressSnapshot {
                committed_samples: progress.committed_samples,
                finished: progress.finished,
                error_code: progress.error_code.clone(),
            },
            Err(_) => AnalysisProgressSnapshot {
                committed_samples: 0,
                finished: true,
                error_code: Some("SPEECH_ANALYSIS_UNAVAILABLE".to_string()),
            },
        }
    }

    pub fn read_samples(
        &self,
        start_sample: u64,
        max_samples: usize,
    ) -> Result<Vec<i16>, &'static str> {
        if max_samples == 0 || start_sample > MAX_ANALYSIS_SAMPLES {
            return Err("SPEECH_ANALYSIS_SOURCE_INVALID");
        }
        let snapshot = self.snapshot();
        if snapshot.error_code.is_some() || start_sample > snapshot.committed_samples {
            return Err("SPEECH_ANALYSIS_SOURCE_UNAVAILABLE");
        }
        let sample_count = usize::try_from(
            snapshot
                .committed_samples
                .saturating_sub(start_sample)
                .min(max_samples as u64),
        )
        .map_err(|_| "SPEECH_ANALYSIS_SOURCE_INVALID")?;
        if sample_count == 0 {
            return Ok(Vec::new());
        }
        let byte_offset = start_sample
            .checked_mul(2)
            .ok_or("SPEECH_ANALYSIS_SOURCE_INVALID")?;
        let byte_count = sample_count
            .checked_mul(2)
            .ok_or("SPEECH_ANALYSIS_SOURCE_INVALID")?;
        let metadata =
            fs::symlink_metadata(&self.path).map_err(|_| "SPEECH_ANALYSIS_SOURCE_UNAVAILABLE")?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() < byte_offset.saturating_add(byte_count as u64)
            || metadata.len() > MAX_ANALYSIS_SAMPLES.saturating_mul(2)
        {
            return Err("SPEECH_ANALYSIS_SOURCE_INVALID");
        }
        let mut bytes = vec![0_u8; byte_count];
        let read_result = (|| {
            let mut file =
                File::open(&self.path).map_err(|_| "SPEECH_ANALYSIS_SOURCE_UNAVAILABLE")?;
            file.seek(SeekFrom::Start(byte_offset))
                .and_then(|_| file.read_exact(&mut bytes))
                .map_err(|_| "SPEECH_ANALYSIS_SOURCE_UNAVAILABLE")?;
            Ok::<Vec<i16>, &'static str>(
                bytes
                    .chunks_exact(2)
                    .map(|sample| i16::from_le_bytes([sample[0], sample[1]]))
                    .collect(),
            )
        })();
        bytes.zeroize();
        read_result
    }
}

enum AnalysisCommand {
    Checkpoint(mpsc::SyncSender<Result<u64, String>>),
    Finish,
}

#[derive(Clone)]
pub(crate) struct AnalysisControl {
    sink: RealtimeTrackSink,
    commands: mpsc::SyncSender<AnalysisCommand>,
}

impl AnalysisControl {
    pub fn set_accepting(&self, accepting: bool) {
        self.sink.set_accepting(accepting);
    }

    pub fn checkpoint(&self) -> Result<u64, String> {
        self.sink.set_accepting(false);
        let (reply, response) = mpsc::sync_channel(1);
        self.commands
            .send(AnalysisCommand::Checkpoint(reply))
            .map_err(|_| "analysis worker stopped before checkpoint".to_string())?;
        self.sink.wake_worker();
        response
            .recv()
            .map_err(|_| "analysis worker dropped checkpoint response".to_string())?
    }
}

pub(crate) struct AnalysisResult {
    pub track: AudioTrackKind,
    pub samples_16k: u64,
    pub overrun_samples: u64,
    pub path: PathBuf,
}

pub(crate) struct TrackAnalysisHandle {
    pub track: AudioTrackKind,
    pub sink: RealtimeTrackSink,
    control: AnalysisControl,
    source: AnalysisSpoolSource,
    worker: Option<JoinHandle<Result<AnalysisResult, String>>>,
}

impl TrackAnalysisHandle {
    pub fn start(
        track: AudioTrackKind,
        path: PathBuf,
        format: SourceFormat,
    ) -> Result<Self, String> {
        let format = format.validate()?;
        if !matches!(track, AudioTrackKind::Microphone | AudioTrackKind::System) {
            return Err("analysis spool requires a physical source track".to_string());
        }
        let parent = path
            .parent()
            .ok_or_else(|| "analysis spool has no parent directory".to_string())?;
        let parent_metadata = fs::symlink_metadata(parent)
            .map_err(|error| format!("inspect analysis directory: {error}"))?;
        if parent_metadata.file_type().is_symlink() || !parent_metadata.is_dir() {
            return Err("analysis directory is not a plain directory".to_string());
        }
        let file = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|error| format!("create analysis spool: {error}"))?;
        let ring = create_realtime_ring(format, ANALYSIS_RING_SECONDS)?;
        let progress = Arc::new(Mutex::new(AnalysisProgress::default()));
        let source = AnalysisSpoolSource {
            track,
            path: path.clone(),
            progress: progress.clone(),
        };
        let (commands, command_rx) = mpsc::sync_channel(8);
        let control = AnalysisControl {
            sink: ring.sink.clone(),
            commands,
        };
        let stop = ring.stop.clone();
        let overrun_samples = ring.overrun_samples.clone();
        let path_for_worker = path.clone();
        let worker = match thread::Builder::new()
            .name(format!("record-analysis-{track:?}"))
            .spawn(move || {
                let result = run_analysis_worker(
                    track,
                    path_for_worker,
                    file,
                    format,
                    ring.consumer,
                    stop,
                    overrun_samples,
                    ring.wake_rx,
                    command_rx,
                    progress.clone(),
                );
                if let Ok(mut state) = progress.lock() {
                    state.finished = true;
                    if result.is_err() && state.error_code.is_none() {
                        state.error_code = Some("SPEECH_ANALYSIS_FAILED".to_string());
                    }
                }
                result
            }) {
            Ok(worker) => worker,
            Err(error) => {
                let _ = cleanup_analysis_spool(&path);
                return Err(format!("spawn analysis worker: {error}"));
            }
        };
        Ok(Self {
            track,
            sink: ring.sink,
            control,
            source,
            worker: Some(worker),
        })
    }

    pub fn control(&self) -> AnalysisControl {
        self.control.clone()
    }

    pub fn source(&self) -> AnalysisSpoolSource {
        self.source.clone()
    }

    pub fn finish(mut self) -> Result<AnalysisResult, String> {
        self.sink.set_accepting(false);
        let command_sent = self.control.commands.send(AnalysisCommand::Finish).is_ok();
        self.sink.wake_worker();
        let result = self
            .worker
            .take()
            .ok_or_else(|| "analysis worker already joined".to_string())?
            .join()
            .map_err(|_| "analysis worker panicked".to_string())?;
        if command_sent {
            result
        } else {
            result.map_err(|error| format!("analysis worker stopped before finish: {error}"))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn run_analysis_worker(
    track: AudioTrackKind,
    path: PathBuf,
    mut file: File,
    format: SourceFormat,
    mut consumer: ringbuf::HeapCons<f32>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    overrun_samples: Arc<std::sync::atomic::AtomicU64>,
    wake_rx: mpsc::Receiver<()>,
    command_rx: mpsc::Receiver<AnalysisCommand>,
    progress: Arc<Mutex<AnalysisProgress>>,
) -> Result<AnalysisResult, String> {
    let mut resampler = StreamingAudioResampler::new(format, ANALYSIS_SAMPLE_RATE, 1)?;
    let input_channels = format.channels as usize;
    let input_samples = (8_192 / input_channels).max(1) * input_channels;
    let mut buffers = SensitiveAnalysisBuffers {
        input: vec![0.0_f32; input_samples],
        resampled: Vec::with_capacity(4_096),
        encoded: Vec::with_capacity(8_192),
    };
    let mut written_samples = 0_u64;
    let mut committed_samples = 0_u64;
    let mut finish_requested = false;

    loop {
        let count = consumer.pop_slice(&mut buffers.input);
        if count > 0 {
            resampler.process(&buffers.input[..count], &mut buffers.resampled)?;
            write_resampled(
                &mut file,
                &mut buffers,
                &mut written_samples,
                &mut committed_samples,
                &progress,
                false,
            )?;
            if overrun_samples.load(Ordering::Acquire) > 0 {
                set_analysis_error(&progress, "SPEECH_ANALYSIS_OVERRUN");
                return Err("analysis ring overrun".to_string());
            }
            continue;
        }

        match command_rx.try_recv() {
            Ok(AnalysisCommand::Checkpoint(reply)) => {
                let checkpoint = checkpoint_resampler(
                    &mut resampler,
                    format,
                    &mut file,
                    &mut buffers,
                    &mut written_samples,
                    &mut committed_samples,
                    &progress,
                );
                let _ = reply.send(checkpoint);
            }
            Ok(AnalysisCommand::Finish) => finish_requested = true,
            Err(mpsc::TryRecvError::Disconnected) => finish_requested = true,
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if (finish_requested || stop.load(Ordering::Acquire)) && consumer.is_empty() {
            resampler.finish(&mut buffers.resampled)?;
            write_resampled(
                &mut file,
                &mut buffers,
                &mut written_samples,
                &mut committed_samples,
                &progress,
                true,
            )?;
            break;
        }
        let _ = wake_rx.recv_timeout(Duration::from_millis(20));
    }

    Ok(AnalysisResult {
        track,
        samples_16k: written_samples,
        overrun_samples: overrun_samples.load(Ordering::Relaxed),
        path,
    })
}

#[allow(clippy::too_many_arguments)]
fn checkpoint_resampler(
    resampler: &mut StreamingAudioResampler,
    format: SourceFormat,
    file: &mut File,
    buffers: &mut SensitiveAnalysisBuffers,
    written_samples: &mut u64,
    committed_samples: &mut u64,
    progress: &Arc<Mutex<AnalysisProgress>>,
) -> Result<u64, String> {
    resampler.finish(&mut buffers.resampled)?;
    write_resampled(
        file,
        buffers,
        written_samples,
        committed_samples,
        progress,
        true,
    )?;
    *resampler = StreamingAudioResampler::new(format, ANALYSIS_SAMPLE_RATE, 1)?;
    Ok(*committed_samples)
}

fn write_resampled(
    file: &mut File,
    buffers: &mut SensitiveAnalysisBuffers,
    written_samples: &mut u64,
    committed_samples: &mut u64,
    progress: &Arc<Mutex<AnalysisProgress>>,
    force_sync: bool,
) -> Result<(), String> {
    if !buffers.resampled.is_empty() {
        let next_samples = written_samples
            .checked_add(buffers.resampled.len() as u64)
            .filter(|samples| *samples <= MAX_ANALYSIS_SAMPLES)
            .ok_or_else(|| "analysis spool exceeds eight-hour limit".to_string())?;
        buffers.encoded.reserve(buffers.resampled.len() * 2);
        for sample in &buffers.resampled {
            let pcm = (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16;
            buffers.encoded.extend_from_slice(&pcm.to_le_bytes());
        }
        file.write_all(&buffers.encoded)
            .map_err(|error| format!("append analysis spool: {error}"))?;
        *written_samples = next_samples;
        buffers.resampled.zeroize();
        buffers.resampled.clear();
        buffers.encoded.zeroize();
        buffers.encoded.clear();
    }
    if force_sync || written_samples.saturating_sub(*committed_samples) >= ANALYSIS_SYNC_SAMPLES {
        file.flush()
            .and_then(|()| file.sync_data())
            .map_err(|error| format!("sync analysis spool: {error}"))?;
        *committed_samples = *written_samples;
        let mut state = progress
            .lock()
            .map_err(|_| "analysis progress lock poisoned".to_string())?;
        state.committed_samples = *committed_samples;
    }
    Ok(())
}

fn set_analysis_error(progress: &Arc<Mutex<AnalysisProgress>>, code: &str) {
    if let Ok(mut state) = progress.lock() {
        state.error_code = Some(code.to_string());
    }
}

struct SensitiveAnalysisBuffers {
    input: Vec<f32>,
    resampled: Vec<f32>,
    encoded: Vec<u8>,
}

impl Drop for SensitiveAnalysisBuffers {
    fn drop(&mut self) {
        self.input.zeroize();
        self.resampled.zeroize();
        self.encoded.zeroize();
    }
}

pub(crate) fn analysis_spool_relative_path(track: AudioTrackKind) -> Result<&'static str, String> {
    match track {
        AudioTrackKind::Microphone => Ok("analysis/microphone.pcm16"),
        AudioTrackKind::System => Ok("analysis/system.pcm16"),
        AudioTrackKind::Mixed => Err("mixed track has no analysis spool".to_string()),
    }
}

pub(crate) fn cleanup_analysis_spool(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
            fs::remove_file(path).map_err(|error| format!("remove analysis spool: {error}"))
        }
        Ok(_) => Err("analysis spool cleanup target is not a file".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("inspect analysis spool cleanup target: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn analysis_spool_reuses_resampler_and_commits_pcm16() {
        let root = tempdir().unwrap();
        let analysis = root.path().join("analysis");
        fs::create_dir(&analysis).unwrap();
        let path = analysis.join("microphone.pcm16");
        let handle = TrackAnalysisHandle::start(
            AudioTrackKind::Microphone,
            path.clone(),
            SourceFormat {
                sample_rate: 48_000,
                channels: 2,
            },
        )
        .unwrap();
        let source = handle.source();
        handle.sink.push_f32(&vec![0.25; 48_000 * 2]);
        let result = handle.finish().unwrap();

        assert_eq!(result.samples_16k, 16_000);
        assert_eq!(result.overrun_samples, 0);
        assert_eq!(path.metadata().unwrap().len(), 32_000);
        assert_eq!(source.snapshot().committed_samples, 16_000);
        let samples = source.read_samples(0, 16_000).unwrap();
        assert_eq!(samples.len(), 16_000);
        let settled_mean = samples[1_000..15_000]
            .iter()
            .map(|sample| i64::from(*sample))
            .sum::<i64>()
            / 14_000;
        assert!((7_500..=8_500).contains(&settled_mean));
    }

    #[test]
    fn pause_checkpoint_is_durable_and_continuation_remains_append_only() {
        let root = tempdir().unwrap();
        let analysis = root.path().join("analysis");
        fs::create_dir(&analysis).unwrap();
        let handle = TrackAnalysisHandle::start(
            AudioTrackKind::System,
            analysis.join("system.pcm16"),
            SourceFormat {
                sample_rate: 16_000,
                channels: 1,
            },
        )
        .unwrap();
        let control = handle.control();
        handle.sink.push_i16(&vec![1_000; 8_000]);
        assert_eq!(control.checkpoint().unwrap(), 8_000);
        control.set_accepting(true);
        handle.sink.push_i16(&vec![2_000; 8_000]);
        let result = handle.finish().unwrap();
        assert_eq!(result.samples_16k, 16_000);
    }
}
