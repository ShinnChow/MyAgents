//! Disk-first Ogg Opus archive pipeline.
//!
//! OS callbacks only convert samples into a preallocated SPSC ring and send a
//! best-effort wake signal. Encoding, muxing, flushing and fsync all happen on
//! the dedicated archive thread.

use ogg::{PacketWriteEndInfo, PacketWriter};
use opus2::{Application, Bitrate, Channels, Encoder};
use ringbuf::traits::*;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::audio::{
    create_realtime_ring, RealtimeTrackSink, SourceFormat, StreamingAudioResampler,
};
use crate::record::AudioTrackKind;

pub const ARCHIVE_SAMPLE_RATE: u32 = 48_000;
const OPUS_FRAME_SAMPLES: usize = 960;
const OPUS_MAX_PACKET_BYTES: usize = 4_000;
const ARCHIVE_RING_SECONDS: usize = 4;
const PAGE_FRAME_COUNT: u64 = 50;
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
        let ring = create_realtime_ring(format, ARCHIVE_RING_SECONDS)?;
        let sink = ring.sink;
        let stop = ring.stop;
        let overrun_samples = ring.overrun_samples;
        let consumer = ring.consumer;
        let wake_rx = ring.wake_rx;
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
        self.sink.wake_worker();
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
    let mut resampler = StreamingAudioResampler::new(format, ARCHIVE_SAMPLE_RATE, output_channels)?;
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
