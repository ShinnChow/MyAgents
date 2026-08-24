//! Bounded decoder for MyAgents-owned Record Ogg Opus artifacts.
//!
//! This is intentionally separate from the untrusted attachment media probe.
//! Record artifacts have one frozen Ogg Opus profile, so a small checked page
//! parser plus the same bundled libopus revision as the archive writer gives
//! us deterministic 16 kHz mono PCM without allowing an attacker-controlled
//! packet to grow across an unbounded number of Ogg pages.

use opus2::{Channels, Decoder};
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read};
use std::path::Path;
use zeroize::Zeroize;

const OPUS_CLOCK_RATE: u64 = 48_000;
const OUTPUT_SAMPLE_RATE: u64 = crate::protocol::SAMPLE_RATE as u64;
const MAX_RECORD_DURATION_SECONDS: u64 = 8 * 60 * 60;
const MAX_RECORD_SAMPLES_48K: u64 = MAX_RECORD_DURATION_SECONDS * OPUS_CLOCK_RATE;
const MAX_SOURCE_BYTES: u64 = 4 * 1024 * 1024 * 1024 - 1;
const MAX_OGG_PAGE_BODY_BYTES: usize = 255 * 255;
const MAX_OPUS_PACKET_BYTES: usize = 4_000;
const RECORD_OPUS_FRAME_SAMPLES_48K: u64 = 960;
const MAX_RECORD_DATA_PACKET_COUNT: u64 = MAX_RECORD_DURATION_SECONDS * 50 + 1;
const MAX_OGG_PAGE_COUNT: u64 = 60_000;
const RECORD_OPUS_FRAME_SAMPLES_16K: usize = 320;
const MAX_PRE_SKIP_SAMPLES_48K: u64 = OPUS_CLOCK_RATE;
const MAX_TAG_VENDOR_BYTES: usize = 512;
const MAX_TAG_COMMENTS: usize = 128;
const MAX_TAG_COMMENT_BYTES: usize = 1_024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordOpusError {
    SourceUnavailable,
    UnsafeSource,
    SourceTooLarge,
    CorruptContainer,
    UnsupportedStream,
    DecodeFailed,
    DurationExceeded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordOpusSummary {
    pub source_samples_48k: u64,
    pub output_samples_16k: u64,
    pub channels: u8,
    pub packets: u64,
}

pub struct DecodedPcmChunk {
    start_sample: u64,
    samples: Vec<f32>,
}

impl DecodedPcmChunk {
    pub fn start_sample(&self) -> u64 {
        self.start_sample
    }

    pub fn samples(&self) -> &[f32] {
        &self.samples
    }
}

impl std::fmt::Debug for DecodedPcmChunk {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DecodedPcmChunk")
            .field("start_sample", &self.start_sample)
            .field("sample_count", &self.samples.len())
            .finish()
    }
}

impl Drop for DecodedPcmChunk {
    fn drop(&mut self) {
        self.samples.zeroize();
    }
}

pub struct RecordOpusDecoder {
    packets: BoundedOggPackets<BufReader<File>>,
    decoder: Decoder,
    channels: usize,
    pre_skip_48k: u64,
    decoded_samples_48k: u64,
    output_samples_16k: u64,
    final_granule: Option<u64>,
    scratch: Vec<f32>,
    finished: bool,
}

impl std::fmt::Debug for RecordOpusDecoder {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RecordOpusDecoder")
            .field("channels", &self.channels)
            .field("decoded_samples_48k", &self.decoded_samples_48k)
            .field("output_samples_16k", &self.output_samples_16k)
            .field("finished", &self.finished)
            .finish()
    }
}

impl RecordOpusDecoder {
    pub fn open(path: &Path) -> Result<Self, RecordOpusError> {
        let file = open_source(path)?;
        let mut packets = BoundedOggPackets::new(BufReader::with_capacity(64 * 1024, file));
        let head = packets
            .next_packet()?
            .ok_or(RecordOpusError::CorruptContainer)?;
        let (channels, pre_skip_48k) = parse_opus_head(&head)?;
        let tags = packets
            .next_packet()?
            .ok_or(RecordOpusError::CorruptContainer)?;
        parse_opus_tags(&tags)?;
        let channel_kind = if channels == 1 {
            Channels::Mono
        } else {
            Channels::Stereo
        };
        let decoder = Decoder::new(OUTPUT_SAMPLE_RATE as u32, channel_kind)
            .map_err(|_| RecordOpusError::DecodeFailed)?;
        Ok(Self {
            packets,
            decoder,
            channels,
            pre_skip_48k,
            decoded_samples_48k: 0,
            output_samples_16k: 0,
            final_granule: None,
            scratch: vec![0.0; RECORD_OPUS_FRAME_SAMPLES_16K * channels],
            finished: false,
        })
    }

    pub fn read_chunk(&mut self) -> Result<Option<DecodedPcmChunk>, RecordOpusError> {
        if self.finished {
            return Ok(None);
        }
        loop {
            let Some(packet) = self.packets.next_packet()? else {
                let final_granule = self
                    .final_granule
                    .ok_or(RecordOpusError::CorruptContainer)?;
                let expected_output = final_granule
                    .checked_sub(self.pre_skip_48k)
                    .ok_or(RecordOpusError::CorruptContainer)?
                    / (OPUS_CLOCK_RATE / OUTPUT_SAMPLE_RATE);
                if self.output_samples_16k != expected_output {
                    return Err(RecordOpusError::CorruptContainer);
                }
                self.finished = true;
                return Ok(None);
            };
            if packet.first_in_stream || self.final_granule.is_some() || packet.data.is_empty() {
                return Err(RecordOpusError::CorruptContainer);
            }
            let packet_samples_48k =
                opus2::packet::get_nb_samples(&packet.data, OPUS_CLOCK_RATE as u32)
                    .map_err(|_| RecordOpusError::DecodeFailed)? as u64;
            if packet_samples_48k == 0 || packet_samples_48k != RECORD_OPUS_FRAME_SAMPLES_48K {
                return Err(RecordOpusError::CorruptContainer);
            }
            let decoded_frames_16k =
                match self
                    .decoder
                    .decode_float(&packet.data, &mut self.scratch, false)
                {
                    Ok(frames) => frames,
                    Err(_) => {
                        self.scratch.as_mut_slice().zeroize();
                        return Err(RecordOpusError::DecodeFailed);
                    }
                };
            if decoded_frames_16k as u64
                != packet_samples_48k / (OPUS_CLOCK_RATE / OUTPUT_SAMPLE_RATE)
            {
                self.scratch.as_mut_slice().zeroize();
                return Err(RecordOpusError::DecodeFailed);
            }
            let packet_start_48k = self.decoded_samples_48k;
            let packet_end_48k = packet_start_48k
                .checked_add(packet_samples_48k)
                .ok_or(RecordOpusError::DurationExceeded)?;
            if packet_end_48k
                > self.pre_skip_48k + MAX_RECORD_SAMPLES_48K + RECORD_OPUS_FRAME_SAMPLES_48K
            {
                self.scratch.as_mut_slice().zeroize();
                return Err(RecordOpusError::DurationExceeded);
            }
            let valid_end_48k = if packet.last_in_stream {
                let granule = packet.granule.ok_or(RecordOpusError::CorruptContainer)?;
                if granule < self.pre_skip_48k
                    || granule < packet_start_48k
                    || granule > packet_end_48k
                {
                    self.scratch.as_mut_slice().zeroize();
                    return Err(RecordOpusError::CorruptContainer);
                }
                if granule - self.pre_skip_48k > MAX_RECORD_SAMPLES_48K {
                    self.scratch.as_mut_slice().zeroize();
                    return Err(RecordOpusError::DurationExceeded);
                }
                self.final_granule = Some(granule);
                granule
            } else {
                packet_end_48k
            };
            self.decoded_samples_48k = packet_end_48k;
            let valid_start_48k = packet_start_48k.max(self.pre_skip_48k);
            if valid_end_48k <= valid_start_48k {
                self.scratch.as_mut_slice().zeroize();
                continue;
            }
            let divisor = OPUS_CLOCK_RATE / OUTPUT_SAMPLE_RATE;
            let start_frame = ((valid_start_48k - packet_start_48k) / divisor) as usize;
            let end_frame = ((valid_end_48k - packet_start_48k) / divisor) as usize;
            if end_frame > decoded_frames_16k || start_frame > end_frame {
                self.scratch.as_mut_slice().zeroize();
                return Err(RecordOpusError::CorruptContainer);
            }
            let mut samples = Vec::with_capacity(end_frame - start_frame);
            if self.channels == 1 {
                samples.extend_from_slice(&self.scratch[start_frame..end_frame]);
            } else {
                for frame in self.scratch[start_frame * 2..end_frame * 2].chunks_exact(2) {
                    samples.push((frame[0] + frame[1]) * 0.5);
                }
            }
            self.scratch.as_mut_slice().zeroize();
            if samples.iter().any(|sample| !sample.is_finite()) {
                samples.zeroize();
                return Err(RecordOpusError::DecodeFailed);
            }
            let start_sample = self.output_samples_16k;
            self.output_samples_16k = self
                .output_samples_16k
                .checked_add(samples.len() as u64)
                .ok_or(RecordOpusError::DurationExceeded)?;
            if self.output_samples_16k > MAX_RECORD_DURATION_SECONDS * OUTPUT_SAMPLE_RATE {
                samples.zeroize();
                return Err(RecordOpusError::DurationExceeded);
            }
            if samples.is_empty() {
                continue;
            }
            return Ok(Some(DecodedPcmChunk {
                start_sample,
                samples,
            }));
        }
    }

    pub fn summary(&self) -> Option<RecordOpusSummary> {
        self.finished.then_some(RecordOpusSummary {
            source_samples_48k: self.final_granule?.checked_sub(self.pre_skip_48k)?,
            output_samples_16k: self.output_samples_16k,
            channels: self.channels as u8,
            packets: self.packets.packet_count().saturating_sub(2),
        })
    }
}

impl Drop for RecordOpusDecoder {
    fn drop(&mut self) {
        self.scratch.zeroize();
    }
}

fn parse_opus_head(packet: &BoundedPacket) -> Result<(usize, u64), RecordOpusError> {
    if !packet.first_in_stream
        || packet.last_in_stream
        || packet.data.len() != 19
        || &packet.data[..8] != b"OpusHead"
        || packet.data[8] != 1
        || !matches!(packet.data[9], 1 | 2)
        || u32::from_le_bytes(packet.data[12..16].try_into().unwrap()) != OPUS_CLOCK_RATE as u32
        || i16::from_le_bytes(packet.data[16..18].try_into().unwrap()) != 0
        || packet.data[18] != 0
    {
        return Err(RecordOpusError::UnsupportedStream);
    }
    let pre_skip = u16::from_le_bytes(packet.data[10..12].try_into().unwrap()) as u64;
    if pre_skip > MAX_PRE_SKIP_SAMPLES_48K
        || !pre_skip.is_multiple_of(OPUS_CLOCK_RATE / OUTPUT_SAMPLE_RATE)
    {
        return Err(RecordOpusError::UnsupportedStream);
    }
    Ok((packet.data[9] as usize, pre_skip))
}

fn parse_opus_tags(packet: &BoundedPacket) -> Result<(), RecordOpusError> {
    if packet.first_in_stream
        || packet.last_in_stream
        || packet.data.len() < 16
        || &packet.data[..8] != b"OpusTags"
    {
        return Err(RecordOpusError::CorruptContainer);
    }
    let vendor_len = read_u32(&packet.data, 8)? as usize;
    if vendor_len > MAX_TAG_VENDOR_BYTES {
        return Err(RecordOpusError::CorruptContainer);
    }
    let mut offset = 12_usize
        .checked_add(vendor_len)
        .ok_or(RecordOpusError::CorruptContainer)?;
    let comment_count = read_u32(&packet.data, offset)? as usize;
    offset = offset
        .checked_add(4)
        .ok_or(RecordOpusError::CorruptContainer)?;
    if comment_count > MAX_TAG_COMMENTS {
        return Err(RecordOpusError::CorruptContainer);
    }
    for _ in 0..comment_count {
        let length = read_u32(&packet.data, offset)? as usize;
        if length > MAX_TAG_COMMENT_BYTES {
            return Err(RecordOpusError::CorruptContainer);
        }
        offset = offset
            .checked_add(4)
            .and_then(|value| value.checked_add(length))
            .filter(|value| *value <= packet.data.len())
            .ok_or(RecordOpusError::CorruptContainer)?;
    }
    (offset == packet.data.len())
        .then_some(())
        .ok_or(RecordOpusError::CorruptContainer)
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32, RecordOpusError> {
    let end = offset
        .checked_add(4)
        .ok_or(RecordOpusError::CorruptContainer)?;
    let value = bytes
        .get(offset..end)
        .ok_or(RecordOpusError::CorruptContainer)?;
    Ok(u32::from_le_bytes(value.try_into().unwrap()))
}

fn open_source(path: &Path) -> Result<File, RecordOpusError> {
    if !path.is_absolute() {
        return Err(RecordOpusError::UnsafeSource);
    }
    let lexical = fs::symlink_metadata(path).map_err(|_| RecordOpusError::SourceUnavailable)?;
    if !lexical.file_type().is_file() || lexical.file_type().is_symlink() {
        return Err(RecordOpusError::UnsafeSource);
    }
    if lexical.len() == 0 || lexical.len() > MAX_SOURCE_BYTES {
        return Err(RecordOpusError::SourceTooLarge);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|_| RecordOpusError::SourceUnavailable)?;
    let opened = file
        .metadata()
        .map_err(|_| RecordOpusError::SourceUnavailable)?;
    if !opened.is_file() || opened.len() != lexical.len() {
        return Err(RecordOpusError::UnsafeSource);
    }
    Ok(file)
}

struct BoundedPacket {
    data: Vec<u8>,
    first_in_stream: bool,
    last_in_stream: bool,
    granule: Option<u64>,
}

impl Drop for BoundedPacket {
    fn drop(&mut self) {
        self.data.zeroize();
    }
}

struct BoundedOggPackets<R: Read> {
    reader: R,
    queue: VecDeque<BoundedPacket>,
    partial: Vec<u8>,
    serial: Option<u32>,
    next_sequence: u32,
    packet_count: u64,
    page_count: u64,
    last_granule: Option<u64>,
    saw_eos: bool,
    verified_eof: bool,
}

impl<R: Read> BoundedOggPackets<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            queue: VecDeque::new(),
            partial: Vec::with_capacity(MAX_OPUS_PACKET_BYTES),
            serial: None,
            next_sequence: 0,
            packet_count: 0,
            page_count: 0,
            last_granule: None,
            saw_eos: false,
            verified_eof: false,
        }
    }

    fn packet_count(&self) -> u64 {
        self.packet_count
    }

    fn next_packet(&mut self) -> Result<Option<BoundedPacket>, RecordOpusError> {
        loop {
            if let Some(packet) = self.queue.pop_front() {
                return Ok(Some(packet));
            }
            if self.saw_eos {
                if !self.verified_eof {
                    let mut trailing = [0_u8; 1];
                    if self
                        .reader
                        .read(&mut trailing)
                        .map_err(|_| RecordOpusError::CorruptContainer)?
                        != 0
                    {
                        return Err(RecordOpusError::CorruptContainer);
                    }
                    self.verified_eof = true;
                }
                return Ok(None);
            }
            self.read_page()?;
        }
    }

    fn read_page(&mut self) -> Result<(), RecordOpusError> {
        self.page_count = self
            .page_count
            .checked_add(1)
            .filter(|count| *count <= MAX_OGG_PAGE_COUNT)
            .ok_or(RecordOpusError::DurationExceeded)?;
        let mut header = [0_u8; 27];
        if self
            .reader
            .read(&mut header[..1])
            .map_err(|_| RecordOpusError::CorruptContainer)?
            == 0
        {
            return Err(RecordOpusError::CorruptContainer);
        }
        self.reader
            .read_exact(&mut header[1..])
            .map_err(|_| RecordOpusError::CorruptContainer)?;
        if &header[..4] != b"OggS" || header[4] != 0 || header[5] & !0x07 != 0 {
            return Err(RecordOpusError::CorruptContainer);
        }
        let flags = header[5];
        let continuation = flags & 0x01 != 0;
        let bos = flags & 0x02 != 0;
        let eos = flags & 0x04 != 0;
        if continuation == self.partial.is_empty() {
            return Err(RecordOpusError::CorruptContainer);
        }
        let serial = u32::from_le_bytes(header[14..18].try_into().unwrap());
        let sequence = u32::from_le_bytes(header[18..22].try_into().unwrap());
        match self.serial {
            None if bos && !continuation && sequence == 0 => self.serial = Some(serial),
            Some(expected) if !bos && expected == serial && sequence == self.next_sequence => {}
            _ => return Err(RecordOpusError::UnsupportedStream),
        }
        self.next_sequence = sequence
            .checked_add(1)
            .ok_or(RecordOpusError::CorruptContainer)?;
        let segment_count = header[26] as usize;
        let mut lacing = vec![0_u8; segment_count];
        self.reader
            .read_exact(&mut lacing)
            .map_err(|_| RecordOpusError::CorruptContainer)?;
        let body_len = lacing.iter().map(|length| *length as usize).sum::<usize>();
        if body_len > MAX_OGG_PAGE_BODY_BYTES {
            return Err(RecordOpusError::CorruptContainer);
        }
        let mut body = vec![0_u8; body_len];
        if self.reader.read_exact(&mut body).is_err() {
            body.zeroize();
            return Err(RecordOpusError::CorruptContainer);
        }
        let expected_crc = u32::from_le_bytes(header[22..26].try_into().unwrap());
        header[22..26].fill(0);
        let actual_crc = ogg_crc(&[&header, &lacing, &body]);
        if expected_crc != actual_crc {
            body.zeroize();
            return Err(RecordOpusError::CorruptContainer);
        }
        let granule = u64::from_le_bytes(header[6..14].try_into().unwrap());
        if granule != u64::MAX {
            if self.last_granule.is_some_and(|previous| granule < previous) {
                body.zeroize();
                return Err(RecordOpusError::CorruptContainer);
            }
            self.last_granule = Some(granule);
        }
        let parsed = (|| {
            let mut offset = 0_usize;
            for (index, length) in lacing.iter().copied().enumerate() {
                let length = length as usize;
                let end = offset
                    .checked_add(length)
                    .filter(|end| *end <= body.len())
                    .ok_or(RecordOpusError::CorruptContainer)?;
                if self.partial.len().saturating_add(length) > MAX_OPUS_PACKET_BYTES {
                    return Err(RecordOpusError::CorruptContainer);
                }
                self.partial.extend_from_slice(&body[offset..end]);
                offset = end;
                if length < 255 {
                    self.packet_count = self
                        .packet_count
                        .checked_add(1)
                        .filter(|count| *count <= MAX_RECORD_DATA_PACKET_COUNT + 2)
                        .ok_or(RecordOpusError::DurationExceeded)?;
                    let last_in_stream = eos && index + 1 == lacing.len();
                    self.queue.push_back(BoundedPacket {
                        data: std::mem::take(&mut self.partial),
                        first_in_stream: self.packet_count == 1,
                        last_in_stream,
                        granule: (index + 1 == lacing.len() && granule != u64::MAX)
                            .then_some(granule),
                    });
                }
            }
            if offset != body.len()
                || (eos
                    && (!self.partial.is_empty()
                        || self
                            .queue
                            .back()
                            .is_none_or(|packet| !packet.last_in_stream)))
            {
                return Err(RecordOpusError::CorruptContainer);
            }
            if eos {
                self.saw_eos = true;
            }
            Ok(())
        })();
        body.zeroize();
        parsed
    }
}

impl<R: Read> Drop for BoundedOggPackets<R> {
    fn drop(&mut self) {
        self.partial.zeroize();
    }
}

fn ogg_crc(chunks: &[&[u8]]) -> u32 {
    let mut crc = 0_u32;
    for byte in chunks.iter().flat_map(|chunk| chunk.iter().copied()) {
        crc ^= (byte as u32) << 24;
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

#[cfg(test)]
mod tests {
    use super::*;
    use ogg::{PacketWriteEndInfo, PacketWriter};
    use opus2::{Application, Encoder};
    use std::io::{Seek, SeekFrom, Write};

    fn write_fixture(path: &Path, channels: usize, frames: usize) -> u64 {
        let channel_kind = if channels == 1 {
            Channels::Mono
        } else {
            Channels::Stereo
        };
        let mut encoder =
            Encoder::new(OPUS_CLOCK_RATE as u32, channel_kind, Application::Audio).unwrap();
        let pre_skip = encoder.get_lookahead().unwrap() as u16;
        assert_eq!(pre_skip as u64 % 3, 0);
        let file = File::create(path).unwrap();
        let mut writer = PacketWriter::new(file);
        writer
            .write_packet(
                opus_head(channels as u8, pre_skip),
                7,
                PacketWriteEndInfo::EndPage,
                0,
            )
            .unwrap();
        writer
            .write_packet(opus_tags(), 7, PacketWriteEndInfo::EndPage, 0)
            .unwrap();
        let mut packet_buffer = vec![0_u8; MAX_OPUS_PACKET_BYTES];
        let mut pcm = vec![0.0_f32; 960 * channels];
        for frame in 0..frames {
            for sample in 0..960 {
                let value = ((frame * 960 + sample) as f32 * 0.017).sin() * 0.25;
                for channel in 0..channels {
                    pcm[sample * channels + channel] =
                        if channel == 0 { value } else { value * 0.5 };
                }
            }
            let packet_len = encoder.encode_float(&pcm, &mut packet_buffer).unwrap();
            let media_samples = ((frame + 1) * 960) as u64;
            writer
                .write_packet(
                    packet_buffer[..packet_len].to_vec(),
                    7,
                    PacketWriteEndInfo::NormalPacket,
                    pre_skip as u64 + media_samples,
                )
                .unwrap();
        }
        pcm.fill(0.0);
        let packet_len = encoder.encode_float(&pcm, &mut packet_buffer).unwrap();
        writer
            .write_packet(
                packet_buffer[..packet_len].to_vec(),
                7,
                PacketWriteEndInfo::EndStream,
                pre_skip as u64 + (frames * 960) as u64,
            )
            .unwrap();
        writer.into_inner().sync_all().unwrap();
        (frames * 960) as u64
    }

    fn opus_head(channels: u8, pre_skip: u16) -> Vec<u8> {
        let mut packet = Vec::new();
        packet.extend_from_slice(b"OpusHead");
        packet.extend_from_slice(&[1, channels]);
        packet.extend_from_slice(&pre_skip.to_le_bytes());
        packet.extend_from_slice(&(OPUS_CLOCK_RATE as u32).to_le_bytes());
        packet.extend_from_slice(&0_i16.to_le_bytes());
        packet.push(0);
        packet
    }

    fn opus_tags() -> Vec<u8> {
        let vendor = b"MyAgents record decoder fixture";
        let mut packet = Vec::new();
        packet.extend_from_slice(b"OpusTags");
        packet.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        packet.extend_from_slice(vendor);
        packet.extend_from_slice(&0_u32.to_le_bytes());
        packet
    }

    #[test]
    fn decodes_internal_mono_and_stereo_to_bounded_16k_mono() {
        for channels in [1, 2] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join(format!("{channels}.opus"));
            let source_samples = write_fixture(&path, channels, 100);
            let mut decoder = RecordOpusDecoder::open(&path).unwrap();
            let mut next_sample = 0_u64;
            let mut non_silent = false;
            while let Some(chunk) = decoder.read_chunk().unwrap() {
                assert_eq!(chunk.start_sample(), next_sample);
                assert!(chunk.samples().len() <= RECORD_OPUS_FRAME_SAMPLES_16K);
                assert!(chunk.samples().iter().all(|sample| sample.is_finite()));
                non_silent |= chunk.samples().iter().any(|sample| sample.abs() > 0.01);
                next_sample += chunk.samples().len() as u64;
            }
            assert!(non_silent);
            assert_eq!(next_sample, source_samples / 3);
            assert_eq!(
                decoder.summary(),
                Some(RecordOpusSummary {
                    source_samples_48k: source_samples,
                    output_samples_16k: source_samples / 3,
                    channels: channels as u8,
                    packets: 101,
                })
            );
        }
    }

    #[test]
    fn rejects_checksum_drift_and_truncated_streams() {
        let root = tempfile::tempdir().unwrap();
        let corrupt = root.path().join("corrupt.opus");
        write_fixture(&corrupt, 1, 2);
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&corrupt)
            .unwrap();
        file.seek(SeekFrom::Start(30)).unwrap();
        file.write_all(&[0xff]).unwrap();
        assert!(matches!(
            RecordOpusDecoder::open(&corrupt),
            Err(RecordOpusError::CorruptContainer)
        ));

        let truncated = root.path().join("truncated.opus");
        write_fixture(&truncated, 1, 2);
        let file = OpenOptions::new().write(true).open(&truncated).unwrap();
        let len = file.metadata().unwrap().len();
        file.set_len(len - 5).unwrap();
        let mut decoder = RecordOpusDecoder::open(&truncated).unwrap();
        assert!(matches!(
            decoder.read_chunk(),
            Err(RecordOpusError::CorruptContainer)
        ));
    }

    #[test]
    fn rejects_oversized_packet_before_cross_page_accumulation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("packet-bomb.opus");
        let file = File::create(&path).unwrap();
        let mut writer = PacketWriter::new(file);
        writer
            .write_packet(opus_head(1, 312), 9, PacketWriteEndInfo::EndPage, 0)
            .unwrap();
        writer
            .write_packet(opus_tags(), 9, PacketWriteEndInfo::EndPage, 0)
            .unwrap();
        writer
            .write_packet(
                vec![0_u8; MAX_OPUS_PACKET_BYTES + 1],
                9,
                PacketWriteEndInfo::EndStream,
                312,
            )
            .unwrap();
        writer.into_inner().sync_all().unwrap();

        let mut decoder = RecordOpusDecoder::open(&path).unwrap();
        assert!(matches!(
            decoder.read_chunk(),
            Err(RecordOpusError::CorruptContainer)
        ));
    }

    #[test]
    fn rejects_sparse_4gib_and_symlink_sources() {
        let root = tempfile::tempdir().unwrap();
        let sparse = root.path().join("huge.opus");
        let file = File::create(&sparse).unwrap();
        file.set_len(MAX_SOURCE_BYTES + 1).unwrap();
        assert!(matches!(
            RecordOpusDecoder::open(&sparse),
            Err(RecordOpusError::SourceTooLarge)
        ));

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let real = root.path().join("real.opus");
            write_fixture(&real, 1, 1);
            let link = root.path().join("link.opus");
            symlink(&real, &link).unwrap();
            assert!(matches!(
                RecordOpusDecoder::open(&link),
                Err(RecordOpusError::UnsafeSource)
            ));
        }
    }
}
