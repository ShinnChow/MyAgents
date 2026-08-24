//! Callback-safe audio buffering and the one shared recording resampler.
//!
//! Capture callbacks only convert into a preallocated SPSC ring. Archive and
//! analysis workers both use the same Rubato-backed adapter off the callback
//! thread; domain modules remain responsible for persistence and lifecycle.

use ringbuf::{traits::*, HeapRb};
use rubato::{
    calculate_cutoff, Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType,
    WindowFunction,
};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

const RESAMPLER_CHUNK_FRAMES: usize = 1_024;
const RESAMPLER_SINC_LENGTH: usize = 128;
const RESAMPLER_OVERSAMPLING_FACTOR: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceFormat {
    pub sample_rate: u32,
    pub channels: u16,
}

impl SourceFormat {
    pub fn validate(self) -> Result<Self, String> {
        if !(8_000..=384_000).contains(&self.sample_rate) {
            return Err(format!(
                "unsupported capture sample rate: {}",
                self.sample_rate
            ));
        }
        if self.channels == 0 || self.channels > 32 {
            return Err(format!(
                "unsupported capture channel count: {}",
                self.channels
            ));
        }
        Ok(self)
    }
}

#[derive(Clone)]
pub struct RealtimeTrackSink {
    producer: Arc<Mutex<ringbuf::HeapProd<f32>>>,
    channels: u16,
    accepting: Arc<AtomicBool>,
    overrun_samples: Arc<AtomicU64>,
    wake: mpsc::SyncSender<()>,
}

impl RealtimeTrackSink {
    pub fn set_accepting(&self, accepting: bool) {
        self.accepting.store(accepting, Ordering::Release);
    }

    pub(super) fn wake_worker(&self) {
        let _ = self.wake.try_send(());
    }

    pub fn push_f32(&self, samples: &[f32]) {
        self.push_converted(samples.iter().copied());
    }

    pub fn push_i16(&self, samples: &[i16]) {
        self.push_converted(
            samples
                .iter()
                .map(|sample| *sample as f32 / i16::MAX as f32),
        );
    }

    pub fn push_i32(&self, samples: &[i32]) {
        self.push_converted(
            samples
                .iter()
                .map(|sample| *sample as f32 / i32::MAX as f32),
        );
    }

    pub fn push_i8(&self, samples: &[i8]) {
        self.push_converted(samples.iter().map(|sample| *sample as f32 / i8::MAX as f32));
    }

    pub fn push_planar_f32(&self, planes: &[&[f32]]) {
        if !self.accepting.load(Ordering::Acquire)
            || planes.len() != self.channels as usize
            || planes.is_empty()
        {
            return;
        }
        let frames = planes.iter().map(|plane| plane.len()).min().unwrap_or(0);
        let Ok(mut producer) = self.producer.try_lock() else {
            self.overrun_samples
                .fetch_add((frames * self.channels as usize) as u64, Ordering::Relaxed);
            return;
        };
        let channels = self.channels as usize;
        let accepted_frames = frames.min(producer.vacant_len() / channels);
        for frame in 0..accepted_frames {
            for plane in planes {
                let pushed = producer.try_push(plane[frame].clamp(-1.0, 1.0));
                debug_assert!(pushed.is_ok());
            }
        }
        let dropped = ((frames - accepted_frames) * channels) as u64;
        drop(producer);
        if dropped > 0 {
            self.overrun_samples.fetch_add(dropped, Ordering::Relaxed);
        }
        self.wake_worker();
    }

    fn push_converted(&self, samples: impl ExactSizeIterator<Item = f32>) {
        if !self.accepting.load(Ordering::Acquire) {
            return;
        }
        let sample_count = samples.len();
        let Ok(mut producer) = self.producer.try_lock() else {
            self.overrun_samples
                .fetch_add(sample_count as u64, Ordering::Relaxed);
            return;
        };
        let channels = self.channels as usize;
        let aligned_samples = sample_count - sample_count % channels;
        let accepted_samples = aligned_samples.min(producer.vacant_len() / channels * channels);
        for (index, sample) in samples.enumerate() {
            if index < accepted_samples {
                let pushed = producer.try_push(sample.clamp(-1.0, 1.0));
                debug_assert!(pushed.is_ok());
            }
        }
        let dropped = sample_count.saturating_sub(accepted_samples) as u64;
        drop(producer);
        if dropped > 0 {
            self.overrun_samples.fetch_add(dropped, Ordering::Relaxed);
        }
        self.wake_worker();
    }
}

pub(super) struct RealtimeRingParts {
    pub sink: RealtimeTrackSink,
    pub consumer: ringbuf::HeapCons<f32>,
    pub stop: Arc<AtomicBool>,
    pub overrun_samples: Arc<AtomicU64>,
    pub wake_rx: mpsc::Receiver<()>,
}

pub(super) fn create_realtime_ring(
    format: SourceFormat,
    seconds: usize,
) -> Result<RealtimeRingParts, String> {
    let format = format.validate()?;
    if seconds == 0 || seconds > 60 {
        return Err("realtime ring duration is invalid".to_string());
    }
    let capacity = (format.sample_rate as usize)
        .checked_mul(format.channels as usize)
        .and_then(|samples| samples.checked_mul(seconds))
        .ok_or_else(|| "realtime ring capacity overflow".to_string())?;
    let (producer, consumer) = HeapRb::<f32>::new(capacity).split();
    let producer = Arc::new(Mutex::new(producer));
    let accepting = Arc::new(AtomicBool::new(true));
    let overrun_samples = Arc::new(AtomicU64::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let (wake, wake_rx) = mpsc::sync_channel(1);
    Ok(RealtimeRingParts {
        sink: RealtimeTrackSink {
            producer,
            channels: format.channels,
            accepting,
            overrun_samples: overrun_samples.clone(),
            wake,
        },
        consumer,
        stop,
        overrun_samples,
        wake_rx,
    })
}

pub(super) struct StreamingAudioResampler {
    input_sample_rate: u32,
    output_sample_rate: u32,
    input_channels: usize,
    output_channels: usize,
    resampler: Option<SincFixedIn<f32>>,
    input_planes: Vec<Vec<f32>>,
    output_planes: Vec<Vec<f32>>,
    pending_frames: usize,
    input_frames: u64,
    emitted_frames: u64,
    delay_frames: usize,
}

impl StreamingAudioResampler {
    pub fn new(
        format: SourceFormat,
        output_sample_rate: u32,
        output_channels: usize,
    ) -> Result<Self, String> {
        let format = format.validate()?;
        if !(8_000..=384_000).contains(&output_sample_rate) {
            return Err("audio output sample rate is invalid".to_string());
        }
        if output_channels == 0 || output_channels > 2 {
            return Err("audio resampler supports one or two output channels".to_string());
        }
        let input_channels = format.channels as usize;
        if format.sample_rate == output_sample_rate {
            return Ok(Self {
                input_sample_rate: format.sample_rate,
                output_sample_rate,
                input_channels,
                output_channels,
                resampler: None,
                input_planes: Vec::new(),
                output_planes: Vec::new(),
                pending_frames: 0,
                input_frames: 0,
                emitted_frames: 0,
                delay_frames: 0,
            });
        }

        let window = WindowFunction::BlackmanHarris2;
        let parameters = SincInterpolationParameters {
            sinc_len: RESAMPLER_SINC_LENGTH,
            f_cutoff: calculate_cutoff(RESAMPLER_SINC_LENGTH, window),
            oversampling_factor: RESAMPLER_OVERSAMPLING_FACTOR,
            interpolation: SincInterpolationType::Cubic,
            window,
        };
        let ratio = output_sample_rate as f64 / format.sample_rate as f64;
        let resampler = SincFixedIn::<f32>::new(
            ratio,
            1.0,
            parameters,
            RESAMPLER_CHUNK_FRAMES,
            output_channels,
        )
        .map_err(|error| format!("create audio resampler: {error}"))?;
        let input_planes = resampler.input_buffer_allocate(true);
        let output_planes = resampler.output_buffer_allocate(true);
        let delay_frames = resampler.output_delay();
        Ok(Self {
            input_sample_rate: format.sample_rate,
            output_sample_rate,
            input_channels,
            output_channels,
            resampler: Some(resampler),
            input_planes,
            output_planes,
            pending_frames: 0,
            input_frames: 0,
            emitted_frames: 0,
            delay_frames,
        })
    }

    pub fn process(&mut self, input: &[f32], output: &mut Vec<f32>) -> Result<(), String> {
        if input.len() % self.input_channels != 0 {
            return Err("audio input is not aligned to source channels".to_string());
        }
        for frame in input.chunks_exact(self.input_channels) {
            let mixed = mix_frame(frame, self.output_channels);
            self.input_frames = self.input_frames.saturating_add(1);
            if self.resampler.is_none() {
                output.extend_from_slice(&mixed[..self.output_channels]);
                self.emitted_frames = self.emitted_frames.saturating_add(1);
                continue;
            }
            for (channel, value) in mixed[..self.output_channels].iter().enumerate() {
                self.input_planes[channel][self.pending_frames] = *value;
            }
            self.pending_frames += 1;
            if self.pending_frames == RESAMPLER_CHUNK_FRAMES {
                self.process_full_chunk(output, None)?;
            }
        }
        Ok(())
    }

    pub fn finish(&mut self, output: &mut Vec<f32>) -> Result<(), String> {
        let target_frames = self.expected_output_frames();
        if self.resampler.is_none() {
            return if self.emitted_frames == target_frames {
                Ok(())
            } else {
                Err("audio passthrough duration drifted".to_string())
            };
        }

        if self.pending_frames > 0 {
            for plane in &mut self.input_planes {
                plane[self.pending_frames..RESAMPLER_CHUNK_FRAMES].fill(0.0);
            }
            self.process_full_chunk(output, Some(target_frames))?;
        }
        for plane in &mut self.input_planes {
            plane[..RESAMPLER_CHUNK_FRAMES].fill(0.0);
        }
        let mut flush_count = 0;
        while self.emitted_frames < target_frames {
            self.process_full_chunk(output, Some(target_frames))?;
            flush_count += 1;
            if flush_count > 8 {
                return Err("audio resampler failed to flush its bounded delay".to_string());
            }
        }
        if self.emitted_frames != target_frames {
            return Err("audio resampler duration drifted".to_string());
        }
        Ok(())
    }

    fn process_full_chunk(
        &mut self,
        output: &mut Vec<f32>,
        target_frames: Option<u64>,
    ) -> Result<(), String> {
        let (_, produced_frames) = self
            .resampler
            .as_mut()
            .expect("resampling chunks require a resampler")
            .process_into_buffer(&self.input_planes, &mut self.output_planes, None)
            .map_err(|error| format!("resample audio: {error}"))?;
        self.pending_frames = 0;
        let first_frame = self.delay_frames.min(produced_frames);
        self.delay_frames -= first_frame;
        let available_frames = produced_frames - first_frame;
        let emitted_now = target_frames.map_or(available_frames, |target| {
            available_frames.min(target.saturating_sub(self.emitted_frames) as usize)
        });
        for frame in first_frame..first_frame + emitted_now {
            for channel in 0..self.output_channels {
                output.push(self.output_planes[channel][frame]);
            }
        }
        self.emitted_frames = self.emitted_frames.saturating_add(emitted_now as u64);
        Ok(())
    }

    fn expected_output_frames(&self) -> u64 {
        let numerator = self.input_frames as u128 * self.output_sample_rate as u128
            + self.input_sample_rate as u128 / 2;
        (numerator / self.input_sample_rate as u128) as u64
    }

    #[cfg(test)]
    fn buffered_input_frames(&self) -> usize {
        self.pending_frames
    }
}

fn mix_frame(frame: &[f32], output_channels: usize) -> [f32; 2] {
    if output_channels == 1 {
        return [frame.iter().copied().sum::<f32>() / frame.len() as f32, 0.0];
    }
    if frame.len() == 1 {
        return [frame[0], frame[0]];
    }
    let left_count = frame.len().div_ceil(2);
    let right_count = frame.len() / 2;
    [
        frame.iter().step_by(2).copied().sum::<f32>() / left_count as f32,
        frame.iter().skip(1).step_by(2).copied().sum::<f32>() / right_count as f32,
    ]
}

impl Drop for StreamingAudioResampler {
    fn drop(&mut self) {
        for plane in &mut self.input_planes {
            plane.fill(0.0);
        }
        for plane in &mut self.output_planes {
            plane.fill(0.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mature_resampler_preserves_exact_media_time_with_bounded_input() {
        for sample_rate in [8_000, 16_000, 44_100, 48_000, 96_000, 192_000, 384_000] {
            for output_rate in [16_000, 48_000] {
                let format = SourceFormat {
                    sample_rate,
                    channels: 1,
                };
                let mut resampler = StreamingAudioResampler::new(format, output_rate, 1).unwrap();
                let source = vec![0.25_f32; sample_rate as usize + 137];
                let mut output = Vec::new();
                for chunk in source.chunks(777) {
                    resampler.process(chunk, &mut output).unwrap();
                    assert!(resampler.buffered_input_frames() < RESAMPLER_CHUNK_FRAMES);
                }
                resampler.finish(&mut output).unwrap();
                let expected = ((source.len() as u128 * output_rate as u128
                    + sample_rate as u128 / 2)
                    / sample_rate as u128) as usize;
                assert_eq!(
                    output.len(),
                    expected,
                    "input {sample_rate}, output {output_rate}"
                );
            }
        }
    }

    #[test]
    fn sinc_resampler_suppresses_downsampling_aliases() {
        fn resample_tone(frequency: f32) -> Vec<f32> {
            let sample_rate = 96_000_u32;
            let source = (0..sample_rate)
                .map(|index| {
                    (std::f32::consts::TAU * frequency * index as f32 / sample_rate as f32).sin()
                })
                .collect::<Vec<_>>();
            let mut resampler = StreamingAudioResampler::new(
                SourceFormat {
                    sample_rate,
                    channels: 1,
                },
                48_000,
                1,
            )
            .unwrap();
            let mut output = Vec::new();
            for chunk in source.chunks(613) {
                resampler.process(chunk, &mut output).unwrap();
            }
            resampler.finish(&mut output).unwrap();
            output
        }

        fn rms(samples: &[f32]) -> f32 {
            (samples.iter().map(|sample| sample * sample).sum::<f32>() / samples.len() as f32)
                .sqrt()
        }

        let passband = resample_tone(1_000.0);
        let stopband = resample_tone(30_000.0);
        let settled = 4_800;
        let passband_rms = rms(&passband[settled..passband.len() - settled]);
        let stopband_rms = rms(&stopband[settled..stopband.len() - settled]);
        assert!(passband_rms > 0.6, "passband RMS was {passband_rms}");
        assert!(
            stopband_rms < passband_rms * 0.02,
            "stopband RMS {stopband_rms} was not suppressed relative to {passband_rms}"
        );
    }

    #[test]
    fn callback_ring_reports_overrun_instead_of_blocking() {
        let parts = create_realtime_ring(
            SourceFormat {
                sample_rate: 8_000,
                channels: 1,
            },
            1,
        )
        .unwrap();
        let oversized = vec![0.1; 8_002];
        parts.sink.push_f32(&oversized);
        assert_eq!(parts.overrun_samples.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn callback_overrun_never_splits_a_multichannel_frame() {
        let format = SourceFormat {
            sample_rate: 8_000,
            channels: 2,
        };
        let parts = create_realtime_ring(format, 1).unwrap();
        let mut source = vec![0.1; 16_002];
        source[16_001] = 0.2;
        parts.sink.push_f32(&source);
        assert_eq!(parts.overrun_samples.load(Ordering::Relaxed), 2);
        assert_eq!(parts.consumer.occupied_len() % 2, 0);
    }
}
