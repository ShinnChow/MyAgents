//! Disk-first Ogg Opus archive pipeline.
//!
//! OS callbacks only convert samples into a preallocated SPSC ring and send a
//! best-effort wake signal. Encoding, muxing, flushing and fsync all happen on
//! the dedicated archive thread.

use ogg::{PacketWriteEndInfo, PacketWriter};
use opus2::{Application, Bitrate, Channels, Encoder};
use ringbuf::{traits::*, HeapRb};
use rubato::{
    calculate_cutoff, Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType,
    WindowFunction,
};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use crate::record::AudioTrackKind;

pub const ARCHIVE_SAMPLE_RATE: u32 = 48_000;
const OPUS_FRAME_SAMPLES: usize = 960;
const OPUS_MAX_PACKET_BYTES: usize = 4_000;
const ARCHIVE_RING_SECONDS: usize = 4;
const PAGE_FRAME_COUNT: u64 = 50;
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

#[derive(Debug)]
pub struct ArchiveResult {
    pub track: AudioTrackKind,
    pub media_samples_48k: u64,
    pub size_bytes: u64,
    pub overrun_samples: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoveredArchive {
    pub media_samples_48k: u64,
    pub size_bytes: u64,
    pub repaired: bool,
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
        let _ = self.wake.try_send(());
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
        let _ = self.wake.try_send(());
    }
}

pub struct TrackArchiveHandle {
    pub track: AudioTrackKind,
    pub sink: RealtimeTrackSink,
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<Result<ArchiveResult, String>>>,
}

impl TrackArchiveHandle {
    pub fn start(
        track: AudioTrackKind,
        path: PathBuf,
        format: SourceFormat,
    ) -> Result<Self, String> {
        let format = format.validate()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create archive directory: {error}"))?;
        }
        let capacity =
            format.sample_rate as usize * format.channels as usize * ARCHIVE_RING_SECONDS;
        let (producer, consumer) = HeapRb::<f32>::new(capacity).split();
        let producer = Arc::new(Mutex::new(producer));
        let accepting = Arc::new(AtomicBool::new(true));
        let overrun_samples = Arc::new(AtomicU64::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (wake, wake_rx) = mpsc::sync_channel(1);
        let sink = RealtimeTrackSink {
            producer,
            channels: format.channels,
            accepting,
            overrun_samples: overrun_samples.clone(),
            wake,
        };
        let stop_for_worker = stop.clone();
        let path_for_worker = path.clone();
        let worker = thread::Builder::new()
            .name(format!("record-archive-{track:?}"))
            .spawn(move || {
                run_archive_worker(
                    track,
                    path_for_worker,
                    format,
                    consumer,
                    stop_for_worker,
                    overrun_samples,
                    wake_rx,
                )
            })
            .map_err(|error| format!("spawn archive worker: {error}"))?;
        Ok(Self {
            track,
            sink,
            stop,
            worker: Some(worker),
        })
    }

    pub fn finish(mut self) -> Result<ArchiveResult, String> {
        self.sink.set_accepting(false);
        self.stop.store(true, Ordering::Release);
        let _ = self.sink.wake.try_send(());
        self.worker
            .take()
            .ok_or_else(|| "archive worker already joined".to_string())?
            .join()
            .map_err(|_| "archive worker panicked".to_string())?
    }
}

fn run_archive_worker(
    track: AudioTrackKind,
    path: PathBuf,
    format: SourceFormat,
    mut consumer: ringbuf::HeapCons<f32>,
    stop: Arc<AtomicBool>,
    overrun_samples: Arc<AtomicU64>,
    wake_rx: mpsc::Receiver<()>,
) -> Result<ArchiveResult, String> {
    let output_channels = if format.channels == 1 { 1 } else { 2 };
    let mut writer = OggOpusWriter::create(&path, output_channels)?;
    let mut resampler = StreamingArchiveResampler::new(format, output_channels)?;
    let input_channels = format.channels as usize;
    let input_samples = (8_192 / input_channels).max(1) * input_channels;
    let mut input = vec![0.0_f32; input_samples];
    let mut encoded = Vec::with_capacity(16_384);

    loop {
        let count = consumer.pop_slice(&mut input);
        if count > 0 {
            resampler.process(&input[..count], &mut encoded)?;
            writer.push_interleaved(&encoded)?;
            encoded.clear();
            continue;
        }
        if stop.load(Ordering::Acquire) && consumer.is_empty() {
            break;
        }
        let _ = wake_rx.recv_timeout(Duration::from_millis(20));
    }

    resampler.finish(&mut encoded)?;
    writer.push_interleaved(&encoded)?;
    let media_samples_48k = writer.finish()?;
    let size_bytes = fs::symlink_metadata(&path)
        .map_err(|error| format!("inspect finalized archive: {error}"))?
        .len();
    Ok(ArchiveResult {
        track,
        media_samples_48k,
        size_bytes,
        overrun_samples: overrun_samples.load(Ordering::Relaxed),
    })
}

/// Recovers a crash-truncated archive to the last complete, CRC-valid Ogg
/// page and marks that page as EOS. The scan is page-bounded and never reads
/// the full recording into memory.
pub fn recover_ogg_opus_archive(path: &Path) -> Result<Option<RecoveredArchive>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect Ogg Opus recovery source: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Ogg Opus recovery source is not a regular file".to_string());
    }
    let original_len = metadata.len();
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("open Ogg Opus recovery source: {error}"))?;
    let mut offset = 0_u64;
    let mut serial = None;
    let mut expected_sequence = 0_u32;
    let mut pre_skip = None;
    let mut last_data_page: Option<(u64, Vec<u8>, u64, bool)> = None;

    while offset < original_len {
        if original_len - offset < 27 {
            break;
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| format!("seek Ogg recovery page: {error}"))?;
        let mut header = [0_u8; 27];
        file.read_exact(&mut header)
            .map_err(|error| format!("read Ogg recovery header: {error}"))?;
        if &header[..4] != b"OggS" || header[4] != 0 {
            if offset == 0 {
                return Err("invalid Ogg capture pattern/version".to_string());
            }
            break;
        }
        let segment_count = header[26] as usize;
        let mut lacing = vec![0_u8; segment_count];
        if file.read_exact(&mut lacing).is_err() {
            break;
        }
        let body_len = lacing.iter().map(|value| *value as usize).sum::<usize>();
        let page_len = 27_usize
            .checked_add(segment_count)
            .and_then(|length| length.checked_add(body_len))
            .ok_or_else(|| "Ogg recovery page length overflow".to_string())?;
        if original_len - offset < page_len as u64 {
            break;
        }
        let mut page = Vec::with_capacity(page_len);
        page.extend_from_slice(&header);
        page.extend_from_slice(&lacing);
        page.resize(page_len, 0);
        file.read_exact(&mut page[27 + segment_count..])
            .map_err(|error| format!("read Ogg recovery page body: {error}"))?;
        let stored_crc = u32::from_le_bytes(page[22..26].try_into().unwrap());
        page[22..26].fill(0);
        let computed_crc = ogg_crc(&page);
        page[22..26].copy_from_slice(&stored_crc.to_le_bytes());
        if stored_crc != computed_crc {
            if offset == 0 {
                return Err("invalid first Ogg page checksum".to_string());
            }
            break;
        }
        let page_serial = u32::from_le_bytes(page[14..18].try_into().unwrap());
        let page_sequence = u32::from_le_bytes(page[18..22].try_into().unwrap());
        if serial.is_some_and(|known| known != page_serial) || page_sequence != expected_sequence {
            if offset == 0 {
                return Err("invalid first Ogg stream identity".to_string());
            }
            break;
        }
        serial = Some(page_serial);
        expected_sequence = expected_sequence.saturating_add(1);
        let body_start = 27 + segment_count;
        if page_sequence == 0 {
            let body = &page[body_start..];
            if body.len() < 12 || &body[..8] != b"OpusHead" {
                return Err("Ogg recovery source is not Opus".to_string());
            }
            pre_skip = Some(u16::from_le_bytes([body[10], body[11]]) as u64);
        }
        let granule = u64::from_le_bytes(page[6..14].try_into().unwrap());
        if page_sequence >= 2 && granule > 0 {
            last_data_page = Some((offset, page, granule, header[5] & 0x04 != 0));
        }
        offset = offset.saturating_add(page_len as u64);
    }

    let Some((last_page_offset, mut last_page, granule, had_eos)) = last_data_page else {
        return Ok(None);
    };
    let valid_len = last_page_offset.saturating_add(last_page.len() as u64);
    let needs_repair = valid_len != original_len || !had_eos;
    if needs_repair {
        file.set_len(valid_len)
            .map_err(|error| format!("truncate torn Ogg tail: {error}"))?;
        if !had_eos {
            last_page[5] |= 0x04;
            last_page[22..26].fill(0);
            let checksum = ogg_crc(&last_page);
            last_page[22..26].copy_from_slice(&checksum.to_le_bytes());
            file.seek(SeekFrom::Start(last_page_offset))
                .and_then(|_| file.write_all(&last_page))
                .map_err(|error| format!("commit recovered Ogg EOS page: {error}"))?;
        }
        file.sync_all()
            .map_err(|error| format!("sync recovered Ogg archive: {error}"))?;
    }
    Ok(Some(RecoveredArchive {
        media_samples_48k: granule.saturating_sub(pre_skip.unwrap_or(0)),
        size_bytes: valid_len,
        repaired: needs_repair,
    }))
}

fn ogg_crc(bytes: &[u8]) -> u32 {
    let mut crc = 0_u32;
    for byte in bytes {
        crc ^= (*byte as u32) << 24;
        for _ in 0..8 {
            crc = if crc & 0x8000_0000 != 0 {
                (crc << 1) ^ 0x04c1_1db7
            } else {
                crc << 1
            };
        }
    }
    crc
}

struct StreamingArchiveResampler {
    input_sample_rate: u32,
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

impl StreamingArchiveResampler {
    fn new(format: SourceFormat, output_channels: usize) -> Result<Self, String> {
        if output_channels == 0 || output_channels > 2 {
            return Err("Opus archive supports one or two channels".to_string());
        }
        let input_channels = format.channels as usize;
        if format.sample_rate == ARCHIVE_SAMPLE_RATE {
            return Ok(Self {
                input_sample_rate: format.sample_rate,
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
        let ratio = ARCHIVE_SAMPLE_RATE as f64 / format.sample_rate as f64;
        let resampler = SincFixedIn::<f32>::new(
            ratio,
            1.0,
            parameters,
            RESAMPLER_CHUNK_FRAMES,
            output_channels,
        )
        .map_err(|error| format!("create archive resampler: {error}"))?;
        let input_planes = resampler.input_buffer_allocate(true);
        let output_planes = resampler.output_buffer_allocate(true);
        let delay_frames = resampler.output_delay();
        Ok(Self {
            input_sample_rate: format.sample_rate,
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

    fn process(&mut self, input: &[f32], output: &mut Vec<f32>) -> Result<(), String> {
        if input.len() % self.input_channels != 0 {
            return Err("archive input is not aligned to source channels".to_string());
        }
        for frame in input.chunks_exact(self.input_channels) {
            let mixed = mix_archive_frame(frame, self.output_channels);
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

    fn finish(&mut self, output: &mut Vec<f32>) -> Result<(), String> {
        let target_frames = self.expected_output_frames();
        if self.resampler.is_none() {
            return if self.emitted_frames == target_frames {
                Ok(())
            } else {
                Err("archive passthrough duration drifted".to_string())
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
                return Err("archive resampler failed to flush its bounded delay".to_string());
            }
        }
        if self.emitted_frames != target_frames {
            return Err("archive resampler duration drifted".to_string());
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
            .map_err(|error| format!("resample archive audio: {error}"))?;
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
        let numerator = self.input_frames as u128 * ARCHIVE_SAMPLE_RATE as u128
            + self.input_sample_rate as u128 / 2;
        (numerator / self.input_sample_rate as u128) as u64
    }

    #[cfg(test)]
    fn buffered_input_frames(&self) -> usize {
        self.pending_frames
    }
}

fn mix_archive_frame(frame: &[f32], output_channels: usize) -> [f32; 2] {
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

impl Drop for StreamingArchiveResampler {
    fn drop(&mut self) {
        for plane in &mut self.input_planes {
            plane.fill(0.0);
        }
        for plane in &mut self.output_planes {
            plane.fill(0.0);
        }
    }
}

struct OggOpusWriter {
    writer: PacketWriter<'static, File>,
    encoder: Encoder,
    serial: u32,
    channels: usize,
    pre_skip: u16,
    pending_pcm: Vec<f32>,
    frame_buffer: Vec<f32>,
    packet_buffer: Vec<u8>,
    media_samples: u64,
    encoded_frames: u64,
}

impl OggOpusWriter {
    fn create(path: &Path, channels: usize) -> Result<Self, String> {
        let opus_channels = match channels {
            1 => Channels::Mono,
            2 => Channels::Stereo,
            _ => return Err("Opus archive supports one or two channels".to_string()),
        };
        let mut encoder = Encoder::new(ARCHIVE_SAMPLE_RATE, opus_channels, Application::Audio)
            .map_err(|error| format!("create Opus encoder: {error}"))?;
        encoder
            .set_bitrate(Bitrate::Bits(if channels == 1 { 64_000 } else { 96_000 }))
            .map_err(|error| format!("configure Opus bitrate: {error}"))?;
        encoder
            .set_vbr(true)
            .map_err(|error| format!("configure Opus VBR: {error}"))?;
        let pre_skip = u16::try_from(
            encoder
                .get_lookahead()
                .map_err(|error| format!("read Opus lookahead: {error}"))?,
        )
        .map_err(|_| "invalid Opus lookahead".to_string())?;
        let file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)
            .map_err(|error| format!("create Ogg Opus archive: {error}"))?;
        let serial = random_serial(path);
        let mut writer = PacketWriter::new(file);
        writer
            .write_packet(
                opus_head(channels as u8, pre_skip),
                serial,
                PacketWriteEndInfo::EndPage,
                0,
            )
            .and_then(|()| writer.write_packet(opus_tags(), serial, PacketWriteEndInfo::EndPage, 0))
            .map_err(|error| format!("write Ogg Opus headers: {error}"))?;
        writer
            .inner_mut()
            .sync_data()
            .map_err(|error| format!("sync Ogg Opus headers: {error}"))?;
        Ok(Self {
            writer,
            encoder,
            serial,
            channels,
            pre_skip,
            pending_pcm: Vec::with_capacity(OPUS_FRAME_SAMPLES * channels * 2),
            frame_buffer: vec![0.0; OPUS_FRAME_SAMPLES * channels],
            packet_buffer: vec![0_u8; OPUS_MAX_PACKET_BYTES],
            media_samples: 0,
            encoded_frames: 0,
        })
    }

    fn push_interleaved(&mut self, samples: &[f32]) -> Result<(), String> {
        self.pending_pcm.extend_from_slice(samples);
        let frame_len = OPUS_FRAME_SAMPLES * self.channels;
        let mut consumed = 0_usize;
        while self.pending_pcm.len() - consumed >= frame_len {
            self.frame_buffer
                .copy_from_slice(&self.pending_pcm[consumed..consumed + frame_len]);
            let frame = std::mem::take(&mut self.frame_buffer);
            self.encode_packet(&frame, OPUS_FRAME_SAMPLES as u64, false)?;
            self.frame_buffer = frame;
            consumed += frame_len;
        }
        if consumed > 0 {
            self.pending_pcm.drain(..consumed);
        }
        Ok(())
    }

    fn encode_packet(
        &mut self,
        pcm: &[f32],
        media_samples: u64,
        end_stream: bool,
    ) -> Result<(), String> {
        let packet_len = self
            .encoder
            .encode_float(pcm, &mut self.packet_buffer)
            .map_err(|error| format!("encode Opus packet: {error}"))?;
        self.media_samples = self.media_samples.saturating_add(media_samples);
        self.encoded_frames = self.encoded_frames.saturating_add(1);
        let end = if end_stream {
            PacketWriteEndInfo::EndStream
        } else if self.encoded_frames % PAGE_FRAME_COUNT == 0 {
            PacketWriteEndInfo::EndPage
        } else {
            PacketWriteEndInfo::NormalPacket
        };
        let granule = self.pre_skip as u64 + self.media_samples;
        self.writer
            .write_packet(
                self.packet_buffer[..packet_len].to_vec(),
                self.serial,
                end,
                granule,
            )
            .map_err(|error| format!("mux Opus packet: {error}"))?;
        if end != PacketWriteEndInfo::NormalPacket {
            self.writer
                .inner_mut()
                .flush()
                .and_then(|()| self.writer.inner_mut().sync_data())
                .map_err(|error| format!("checkpoint Ogg Opus archive: {error}"))?;
        }
        Ok(())
    }

    fn finish(mut self) -> Result<u64, String> {
        let frame_len = OPUS_FRAME_SAMPLES * self.channels;
        let remaining_frames = self.pending_pcm.len() / self.channels;
        self.frame_buffer.fill(0.0);
        let remaining_samples = self.pending_pcm.len().min(frame_len);
        self.frame_buffer[..remaining_samples]
            .copy_from_slice(&self.pending_pcm[..remaining_samples]);
        self.pending_pcm.clear();
        let final_pcm = std::mem::take(&mut self.frame_buffer);
        self.encode_packet(&final_pcm, remaining_frames as u64, true)?;
        let mut file = self.writer.into_inner();
        file.flush()
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("finalize Ogg Opus archive: {error}"))?;
        Ok(self.media_samples)
    }
}

fn opus_head(channels: u8, pre_skip: u16) -> Vec<u8> {
    let mut packet = Vec::with_capacity(19);
    packet.extend_from_slice(b"OpusHead");
    packet.push(1);
    packet.push(channels);
    packet.extend_from_slice(&pre_skip.to_le_bytes());
    packet.extend_from_slice(&ARCHIVE_SAMPLE_RATE.to_le_bytes());
    packet.extend_from_slice(&0_i16.to_le_bytes());
    packet.push(0);
    packet
}

fn opus_tags() -> Vec<u8> {
    const VENDOR: &[u8] = b"MyAgents bundled libopus (libopus_sys 0.3.3)";
    let mut packet = Vec::with_capacity(16 + VENDOR.len());
    packet.extend_from_slice(b"OpusTags");
    packet.extend_from_slice(&(VENDOR.len() as u32).to_le_bytes());
    packet.extend_from_slice(VENDOR);
    packet.extend_from_slice(&0_u32.to_le_bytes());
    packet
}

fn random_serial(path: &Path) -> u32 {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(path.as_os_str().as_encoded_bytes());
    hasher.update(uuid::Uuid::new_v4().as_bytes());
    let digest = hasher.finalize();
    u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]])
}

#[cfg(test)]
mod tests {
    use super::*;
    use ogg::PacketReader;
    use tempfile::tempdir;

    #[test]
    fn writes_bounded_valid_ogg_opus_archive() {
        let root = tempdir().unwrap();
        let path = root.path().join("microphone.opus");
        let mut writer = OggOpusWriter::create(&path, 1).unwrap();
        let samples: Vec<f32> = (0..ARCHIVE_SAMPLE_RATE / 2)
            .map(|index| ((index as f32 / 80.0).sin()) * 0.1)
            .collect();
        writer.push_interleaved(&samples).unwrap();
        assert_eq!(writer.finish().unwrap(), samples.len() as u64);

        let file = File::open(&path).unwrap();
        let mut reader = PacketReader::new(file);
        let mut packets = Vec::new();
        while let Some(packet) = reader.read_packet().unwrap() {
            packets.push(packet);
        }
        assert!(packets.len() > 3);
        assert_eq!(&packets[0].data[..8], b"OpusHead");
        assert_eq!(&packets[1].data[..8], b"OpusTags");
        assert!(packets.last().unwrap().last_in_stream());
        assert!(path.metadata().unwrap().len() < 128 * 1024);
    }

    #[test]
    fn mature_resampler_preserves_exact_media_time_with_bounded_input() {
        for sample_rate in [8_000, 16_000, 44_100, 48_000, 96_000, 192_000, 384_000] {
            let format = SourceFormat {
                sample_rate,
                channels: 1,
            };
            let mut resampler = StreamingArchiveResampler::new(format, 1).unwrap();
            let source = vec![0.25_f32; sample_rate as usize + 137];
            let mut output = Vec::new();
            for chunk in source.chunks(777) {
                resampler.process(chunk, &mut output).unwrap();
                assert!(resampler.buffered_input_frames() < RESAMPLER_CHUNK_FRAMES);
            }
            resampler.finish(&mut output).unwrap();
            let expected = ((source.len() as u128 * ARCHIVE_SAMPLE_RATE as u128
                + sample_rate as u128 / 2)
                / sample_rate as u128) as usize;
            assert_eq!(output.len(), expected, "sample rate {sample_rate}");
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
            let mut resampler = StreamingArchiveResampler::new(
                SourceFormat {
                    sample_rate,
                    channels: 1,
                },
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
        let settled = ARCHIVE_SAMPLE_RATE as usize / 10;
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
        let (producer, _consumer) = HeapRb::<f32>::new(2).split();
        let (wake, _wake_rx) = mpsc::sync_channel(1);
        let dropped = Arc::new(AtomicU64::new(0));
        let sink = RealtimeTrackSink {
            producer: Arc::new(Mutex::new(producer)),
            channels: 1,
            accepting: Arc::new(AtomicBool::new(true)),
            overrun_samples: dropped.clone(),
            wake,
        };
        sink.push_f32(&[0.0, 0.1, 0.2, 0.3]);
        assert_eq!(dropped.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn callback_overrun_never_splits_a_multichannel_frame() {
        let (producer, mut consumer) = HeapRb::<f32>::new(2).split();
        let (wake, _wake_rx) = mpsc::sync_channel(1);
        let dropped = Arc::new(AtomicU64::new(0));
        let sink = RealtimeTrackSink {
            producer: Arc::new(Mutex::new(producer)),
            channels: 2,
            accepting: Arc::new(AtomicBool::new(true)),
            overrun_samples: dropped.clone(),
            wake,
        };
        sink.push_f32(&[0.1, 0.2, 0.3, 0.4]);

        let mut accepted = [0.0; 2];
        assert_eq!(consumer.pop_slice(&mut accepted), 2);
        assert_eq!(accepted, [0.1, 0.2]);
        assert_eq!(dropped.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn recovery_truncates_torn_tail_and_marks_last_checkpoint_eos() {
        let root = tempdir().unwrap();
        let path = root.path().join("system.opus");
        let mut writer = OggOpusWriter::create(&path, 1).unwrap();
        writer
            .push_interleaved(&vec![0.02; ARCHIVE_SAMPLE_RATE as usize * 2 + 9_600])
            .unwrap();
        writer.finish().unwrap();
        let original = fs::read(&path).unwrap();
        let last_page = original
            .windows(4)
            .rposition(|window| window == b"OggS")
            .unwrap();
        assert!(last_page > 0);
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(last_page as u64 + 12)
            .unwrap();

        let recovered = recover_ogg_opus_archive(&path).unwrap().unwrap();
        assert!(recovered.repaired);
        assert!(recovered.media_samples_48k >= ARCHIVE_SAMPLE_RATE as u64 * 2);
        assert!(recovered.size_bytes < original.len() as u64);
        let mut reader = PacketReader::new(File::open(&path).unwrap());
        let mut last = None;
        while let Some(packet) = reader.read_packet().unwrap() {
            last = Some(packet);
        }
        assert!(last.unwrap().last_in_stream());
    }
}
