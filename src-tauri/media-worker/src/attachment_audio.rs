//! Bounded adapter from the product's attachment whitelist to mature media crates.
//!
//! Symphonia owns container probing, demuxing, and codec decoding. Rubato owns
//! sample-rate conversion. This module only applies MyAgents' container/codec
//! admission table, resource limits, mono projection, and stable 16 kHz sample
//! timeline.

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
    calculate_cutoff,
};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use symphonia::core::audio::sample::Sample;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::codecs::audio::well_known::profiles::CODEC_PROFILE_AAC_LC;
use symphonia::core::codecs::audio::well_known::*;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, Track, TrackFlags, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use zeroize::Zeroize;

const MAX_SOURCE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_DURATION_SECONDS: u64 = 8 * 60 * 60;
const MAX_OUTPUT_SAMPLES: u64 = 16_000 * MAX_DURATION_SECONDS;
const MAX_TRACKS: usize = 64;
const MAX_PACKETS: u64 = 10_000_000;
const MAX_DECODED_FRAMES_PER_PACKET: usize = 1_048_576;
const MAX_CHANNELS: usize = 32;
const MIN_SAMPLE_RATE: u32 = 8_000;
const MAX_SAMPLE_RATE: u32 = 384_000;
const OUTPUT_SAMPLE_RATE: u32 = 16_000;
const RESAMPLER_CHUNK_FRAMES: usize = 1_024;
const RESAMPLER_SINC_LENGTH: usize = 128;
const RESAMPLER_OVERSAMPLING_FACTOR: usize = 128;
const MAX_FTYP_BYTES: u64 = 4 * 1024;
const MAX_TOP_LEVEL_ATOMS_TO_FTYP: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentAudioError {
    SourceUnavailable,
    UnsafeSource,
    SourceTooLarge,
    UnsupportedContainer,
    UnsupportedCodec,
    EncryptedMedia,
    NoAudioTrack,
    CorruptMedia,
    DurationExceeded,
    ResourceLimit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttachmentAudioInfo {
    pub media_kind: &'static str,
    pub codec: &'static str,
    pub duration_ms: Option<u64>,
    pub used_default_track: bool,
}

#[derive(Debug)]
pub struct AttachmentPcmChunk {
    start_sample: u64,
    samples: Vec<f32>,
}

impl AttachmentPcmChunk {
    pub fn start_sample(&self) -> u64 {
        self.start_sample
    }

    pub fn samples(&self) -> &[f32] {
        &self.samples
    }
}

impl Drop for AttachmentPcmChunk {
    fn drop(&mut self) {
        self.samples.zeroize();
    }
}

pub struct AttachmentAudioDecoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn symphonia::core::codecs::audio::AudioDecoder>,
    track_id: u32,
    source_sample_rate: u32,
    source_channels: usize,
    resampler: MonoResampler,
    interleaved: Vec<f32>,
    info: AttachmentAudioInfo,
    packet_count: u64,
    source_frames: u64,
    emitted_samples: u64,
    finished: bool,
}

impl AttachmentAudioDecoder {
    pub fn open(path: &Path) -> Result<Self, AttachmentAudioError> {
        let metadata =
            fs::symlink_metadata(path).map_err(|_| AttachmentAudioError::SourceUnavailable)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(AttachmentAudioError::UnsafeSource);
        }
        if metadata.len() == 0 || metadata.len() > MAX_SOURCE_BYTES {
            return Err(AttachmentAudioError::SourceTooLarge);
        }

        let iso_brand = probe_iso_bmff_brand(path)?;
        let file = open_regular_file_no_follow(path)?;
        let stream = MediaSourceStream::new(Box::new(file), Default::default());
        let format = symphonia::default::get_probe()
            .probe(
                &Hint::new(),
                stream,
                FormatOptions::default(),
                MetadataOptions::default(),
            )
            .map_err(|error| map_probe_error(error, iso_brand))?;
        if format.tracks().len() > MAX_TRACKS {
            return Err(AttachmentAudioError::ResourceLimit);
        }
        let container = container_kind(format.format_info().short_name, iso_brand)?;
        let (track, codec, used_default_track) = select_audio_track(format.as_ref(), container)?;
        let CodecParameters::Audio(codec_params) = track
            .codec_params
            .as_ref()
            .ok_or(AttachmentAudioError::UnsupportedCodec)?
        else {
            return Err(AttachmentAudioError::UnsupportedCodec);
        };
        let source_sample_rate = codec_params
            .sample_rate
            .filter(|rate| (MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(rate))
            .ok_or(AttachmentAudioError::UnsupportedCodec)?;
        let source_channels = codec_params
            .channels
            .as_ref()
            .map(|channels| channels.count())
            .filter(|channels| (1..=MAX_CHANNELS).contains(channels))
            .ok_or(AttachmentAudioError::UnsupportedCodec)?;
        let duration_ms = track_duration_ms(track, source_sample_rate)?;
        if duration_ms.is_some_and(|duration| duration > MAX_DURATION_SECONDS * 1_000) {
            return Err(AttachmentAudioError::DurationExceeded);
        }
        let track_id = track.id;
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(codec_params, &AudioDecoderOptions::default())
            .map_err(map_decoder_creation_error)?;
        let resampler = MonoResampler::new(source_sample_rate)?;
        Ok(Self {
            format,
            decoder,
            track_id,
            source_sample_rate,
            source_channels,
            resampler,
            interleaved: Vec::new(),
            info: AttachmentAudioInfo {
                media_kind: container.as_str(),
                codec: codec.as_str(),
                duration_ms,
                used_default_track,
            },
            packet_count: 0,
            source_frames: 0,
            emitted_samples: 0,
            finished: false,
        })
    }

    pub fn info(&self) -> AttachmentAudioInfo {
        self.info
    }

    pub fn read_chunk(&mut self) -> Result<Option<AttachmentPcmChunk>, AttachmentAudioError> {
        if self.finished {
            return Ok(None);
        }
        loop {
            let Some(packet) = self.format.next_packet().map_err(map_stream_error)? else {
                let mut samples = Vec::new();
                self.resampler.finish(&mut samples)?;
                self.interleaved.zeroize();
                self.finished = true;
                if samples.is_empty() {
                    if self.emitted_samples == 0 {
                        return Err(AttachmentAudioError::NoAudioTrack);
                    }
                    return Ok(None);
                }
                return self.output_chunk(samples);
            };
            self.packet_count = self
                .packet_count
                .checked_add(1)
                .ok_or(AttachmentAudioError::ResourceLimit)?;
            if self.packet_count > MAX_PACKETS {
                return Err(AttachmentAudioError::ResourceLimit);
            }
            if packet.track_id != self.track_id {
                continue;
            }
            let decoded = self.decoder.decode(&packet).map_err(map_stream_error)?;
            if decoded.is_empty() {
                continue;
            }
            if decoded.spec().rate() != self.source_sample_rate
                || decoded.spec().channels().count() != self.source_channels
                || decoded.frames() > MAX_DECODED_FRAMES_PER_PACKET
            {
                return Err(AttachmentAudioError::ResourceLimit);
            }
            self.source_frames = self
                .source_frames
                .checked_add(decoded.frames() as u64)
                .ok_or(AttachmentAudioError::ResourceLimit)?;
            if self.source_frames > u64::from(self.source_sample_rate) * MAX_DURATION_SECONDS {
                return Err(AttachmentAudioError::DurationExceeded);
            }
            self.interleaved
                .resize(decoded.samples_interleaved(), f32::MID);
            decoded.copy_to_slice_interleaved(&mut self.interleaved);
            let mut samples = Vec::new();
            self.resampler
                .process_frames(&self.interleaved, self.source_channels, &mut samples)?;
            self.interleaved.zeroize();
            if !samples.is_empty() {
                return self.output_chunk(samples);
            }
        }
    }

    pub fn output_samples(&self) -> u64 {
        self.emitted_samples
    }

    fn output_chunk(
        &mut self,
        mut samples: Vec<f32>,
    ) -> Result<Option<AttachmentPcmChunk>, AttachmentAudioError> {
        let end = self
            .emitted_samples
            .checked_add(samples.len() as u64)
            .ok_or(AttachmentAudioError::ResourceLimit)?;
        if end > MAX_OUTPUT_SAMPLES {
            samples.zeroize();
            return Err(AttachmentAudioError::DurationExceeded);
        }
        let start_sample = self.emitted_samples;
        self.emitted_samples = end;
        Ok(Some(AttachmentPcmChunk {
            start_sample,
            samples,
        }))
    }
}

impl Drop for AttachmentAudioDecoder {
    fn drop(&mut self) {
        self.interleaved.zeroize();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContainerKind {
    Wav,
    Aiff,
    Mp3,
    Flac,
    Ogg,
    M4a,
    Mp4,
    Mov,
}

impl ContainerKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Aiff => "aiff",
            Self::Mp3 => "mp3",
            Self::Flac => "flac",
            Self::Ogg => "ogg",
            Self::M4a => "m4a",
            Self::Mp4 => "mp4",
            Self::Mov => "mov",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodecKind {
    Pcm,
    Adpcm,
    Mp3,
    Flac,
    Vorbis,
    AacLc,
    Alac,
}

impl CodecKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pcm => "pcm",
            Self::Adpcm => "adpcm",
            Self::Mp3 => "mp3",
            Self::Flac => "flac",
            Self::Vorbis => "vorbis",
            Self::AacLc => "aac-lc",
            Self::Alac => "alac",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IsoBmffBrand {
    NotIsoBmff,
    M4a,
    Mp4,
    Mov,
    EncryptedM4p,
    Unknown,
}

fn container_kind(
    short_name: &str,
    iso_brand: IsoBmffBrand,
) -> Result<ContainerKind, AttachmentAudioError> {
    match short_name {
        "wave" => Ok(ContainerKind::Wav),
        "aiff" => Ok(ContainerKind::Aiff),
        "mp3" => Ok(ContainerKind::Mp3),
        "flac" => Ok(ContainerKind::Flac),
        "ogg" => Ok(ContainerKind::Ogg),
        "isomp4" => match iso_brand {
            IsoBmffBrand::M4a => Ok(ContainerKind::M4a),
            IsoBmffBrand::Mp4 => Ok(ContainerKind::Mp4),
            IsoBmffBrand::Mov | IsoBmffBrand::NotIsoBmff => Ok(ContainerKind::Mov),
            IsoBmffBrand::EncryptedM4p => Err(AttachmentAudioError::EncryptedMedia),
            IsoBmffBrand::Unknown => Err(AttachmentAudioError::UnsupportedContainer),
        },
        _ => Err(AttachmentAudioError::UnsupportedContainer),
    }
}

fn select_audio_track(
    format: &dyn FormatReader,
    container: ContainerKind,
) -> Result<(&Track, CodecKind, bool), AttachmentAudioError> {
    let mut supported = format
        .tracks()
        .iter()
        .filter_map(|track| codec_for_track(track, container).map(|codec| (track, codec)))
        .collect::<Vec<_>>();
    if supported.is_empty() {
        return if format
            .tracks()
            .iter()
            .any(|track| track.track_type() == Some(TrackType::Audio))
        {
            Err(AttachmentAudioError::UnsupportedCodec)
        } else {
            Err(AttachmentAudioError::NoAudioTrack)
        };
    }
    if let Some(index) = supported
        .iter()
        .position(|(track, _)| track.flags.contains(TrackFlags::DEFAULT))
    {
        let (track, codec) = supported.remove(index);
        return Ok((track, codec, true));
    }
    let unambiguous = supported.len() == 1;
    let (track, codec) = supported.remove(0);
    Ok((track, codec, unambiguous))
}

fn codec_for_track(track: &Track, container: ContainerKind) -> Option<CodecKind> {
    let CodecParameters::Audio(params) = track.codec_params.as_ref()? else {
        return None;
    };
    let codec = if is_pcm(params.codec) {
        CodecKind::Pcm
    } else if matches!(
        params.codec,
        CODEC_ID_ADPCM_MS | CODEC_ID_ADPCM_IMA_WAV | CODEC_ID_ADPCM_IMA_QT
    ) {
        CodecKind::Adpcm
    } else if params.codec == CODEC_ID_MP3 {
        CodecKind::Mp3
    } else if params.codec == CODEC_ID_FLAC {
        CodecKind::Flac
    } else if params.codec == CODEC_ID_VORBIS {
        CodecKind::Vorbis
    } else if params.codec == CODEC_ID_AAC && params.profile == Some(CODEC_PROFILE_AAC_LC) {
        CodecKind::AacLc
    } else if params.codec == CODEC_ID_ALAC {
        CodecKind::Alac
    } else {
        return None;
    };
    match (container, codec) {
        (ContainerKind::Wav, CodecKind::Pcm | CodecKind::Adpcm)
        | (ContainerKind::Aiff, CodecKind::Pcm)
        | (ContainerKind::Mp3, CodecKind::Mp3)
        | (ContainerKind::Flac, CodecKind::Flac)
        | (ContainerKind::Ogg, CodecKind::Vorbis)
        | (ContainerKind::M4a, CodecKind::AacLc | CodecKind::Alac)
        | (ContainerKind::Mp4, CodecKind::AacLc | CodecKind::Alac | CodecKind::Mp3)
        | (ContainerKind::Mov, CodecKind::Pcm | CodecKind::AacLc | CodecKind::Mp3) => Some(codec),
        _ => None,
    }
}

fn is_pcm(codec: symphonia::core::codecs::audio::AudioCodecId) -> bool {
    matches!(
        codec,
        CODEC_ID_PCM_S32LE
            | CODEC_ID_PCM_S32LE_PLANAR
            | CODEC_ID_PCM_S32BE
            | CODEC_ID_PCM_S32BE_PLANAR
            | CODEC_ID_PCM_S24LE
            | CODEC_ID_PCM_S24LE_PLANAR
            | CODEC_ID_PCM_S24BE
            | CODEC_ID_PCM_S24BE_PLANAR
            | CODEC_ID_PCM_S16LE
            | CODEC_ID_PCM_S16LE_PLANAR
            | CODEC_ID_PCM_S16BE
            | CODEC_ID_PCM_S16BE_PLANAR
            | CODEC_ID_PCM_S8
            | CODEC_ID_PCM_S8_PLANAR
            | CODEC_ID_PCM_U32LE
            | CODEC_ID_PCM_U32LE_PLANAR
            | CODEC_ID_PCM_U32BE
            | CODEC_ID_PCM_U32BE_PLANAR
            | CODEC_ID_PCM_U24LE
            | CODEC_ID_PCM_U24LE_PLANAR
            | CODEC_ID_PCM_U24BE
            | CODEC_ID_PCM_U24BE_PLANAR
            | CODEC_ID_PCM_U16LE
            | CODEC_ID_PCM_U16LE_PLANAR
            | CODEC_ID_PCM_U16BE
            | CODEC_ID_PCM_U16BE_PLANAR
            | CODEC_ID_PCM_U8
            | CODEC_ID_PCM_U8_PLANAR
            | CODEC_ID_PCM_F32LE
            | CODEC_ID_PCM_F32LE_PLANAR
            | CODEC_ID_PCM_F32BE
            | CODEC_ID_PCM_F32BE_PLANAR
            | CODEC_ID_PCM_F64LE
            | CODEC_ID_PCM_F64LE_PLANAR
            | CODEC_ID_PCM_F64BE
            | CODEC_ID_PCM_F64BE_PLANAR
    )
}

fn track_duration_ms(track: &Track, sample_rate: u32) -> Result<Option<u64>, AttachmentAudioError> {
    if let (Some(time_base), Some(duration)) = (track.time_base, track.duration) {
        let nanos = time_base
            .calc_duration(duration)
            .ok_or(AttachmentAudioError::ResourceLimit)?
            .as_nanos();
        return u64::try_from(nanos / 1_000_000)
            .map(Some)
            .map_err(|_| AttachmentAudioError::ResourceLimit);
    }
    track
        .num_frames
        .map(|frames| {
            frames
                .checked_mul(1_000)
                .map(|value| value / u64::from(sample_rate))
                .ok_or(AttachmentAudioError::ResourceLimit)
        })
        .transpose()
}

fn map_probe_error(error: SymphoniaError, brand: IsoBmffBrand) -> AttachmentAudioError {
    if brand == IsoBmffBrand::EncryptedM4p {
        return AttachmentAudioError::EncryptedMedia;
    }
    match error {
        SymphoniaError::Unsupported(_) => AttachmentAudioError::UnsupportedContainer,
        SymphoniaError::LimitError(_) => AttachmentAudioError::ResourceLimit,
        SymphoniaError::IoError(error) if error.kind() == std::io::ErrorKind::NotFound => {
            AttachmentAudioError::SourceUnavailable
        }
        _ => AttachmentAudioError::CorruptMedia,
    }
}

fn map_decoder_creation_error(error: SymphoniaError) -> AttachmentAudioError {
    match error {
        SymphoniaError::Unsupported(_) => AttachmentAudioError::UnsupportedCodec,
        SymphoniaError::LimitError(_) => AttachmentAudioError::ResourceLimit,
        _ => AttachmentAudioError::CorruptMedia,
    }
}

fn map_stream_error(error: SymphoniaError) -> AttachmentAudioError {
    match error {
        SymphoniaError::Unsupported(_) => AttachmentAudioError::UnsupportedCodec,
        SymphoniaError::LimitError(_) => AttachmentAudioError::ResourceLimit,
        _ => AttachmentAudioError::CorruptMedia,
    }
}

fn open_regular_file_no_follow(path: &Path) -> Result<File, AttachmentAudioError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|_| AttachmentAudioError::SourceUnavailable)?;
    let metadata = file
        .metadata()
        .map_err(|_| AttachmentAudioError::SourceUnavailable)?;
    if !metadata.is_file() {
        return Err(AttachmentAudioError::UnsafeSource);
    }
    Ok(file)
}

fn probe_iso_bmff_brand(path: &Path) -> Result<IsoBmffBrand, AttachmentAudioError> {
    let mut file = open_regular_file_no_follow(path)?;
    let file_len = file
        .metadata()
        .map_err(|_| AttachmentAudioError::SourceUnavailable)?
        .len();
    let mut offset = 0_u64;
    for _ in 0..MAX_TOP_LEVEL_ATOMS_TO_FTYP {
        if offset.checked_add(8).is_none_or(|end| end > file_len) {
            return Ok(IsoBmffBrand::NotIsoBmff);
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| AttachmentAudioError::CorruptMedia)?;
        let mut header = [0_u8; 16];
        file.read_exact(&mut header[..8])
            .map_err(|_| AttachmentAudioError::CorruptMedia)?;
        let size32 = u32::from_be_bytes(header[..4].try_into().expect("four bytes"));
        let atom_type: [u8; 4] = header[4..8].try_into().expect("four bytes");
        let (header_len, atom_size) = if size32 == 1 {
            file.read_exact(&mut header[8..16])
                .map_err(|_| AttachmentAudioError::CorruptMedia)?;
            (
                16_u64,
                u64::from_be_bytes(header[8..16].try_into().expect("eight bytes")),
            )
        } else if size32 == 0 {
            (8_u64, file_len - offset)
        } else {
            (8_u64, u64::from(size32))
        };
        if atom_size < header_len
            || offset
                .checked_add(atom_size)
                .is_none_or(|end| end > file_len)
        {
            return Ok(IsoBmffBrand::NotIsoBmff);
        }
        if atom_type == *b"ftyp" {
            let payload_len = atom_size - header_len;
            if !(8..=MAX_FTYP_BYTES).contains(&payload_len) || !payload_len.is_multiple_of(4) {
                return Err(AttachmentAudioError::CorruptMedia);
            }
            let mut payload = vec![0_u8; payload_len as usize];
            file.read_exact(&mut payload)
                .map_err(|_| AttachmentAudioError::CorruptMedia)?;
            let result = classify_iso_brands(&payload);
            payload.zeroize();
            return Ok(result);
        }
        offset = offset
            .checked_add(atom_size)
            .ok_or(AttachmentAudioError::ResourceLimit)?;
    }
    Ok(IsoBmffBrand::NotIsoBmff)
}

fn classify_iso_brands(payload: &[u8]) -> IsoBmffBrand {
    let brands = std::iter::once(&payload[..4]).chain(payload[8..].chunks_exact(4));
    let mut saw_mp4 = false;
    for brand in brands {
        match brand {
            b"M4P " => return IsoBmffBrand::EncryptedM4p,
            b"M4A " | b"M4B " => return IsoBmffBrand::M4a,
            b"qt  " => return IsoBmffBrand::Mov,
            b"isom" | b"iso2" | b"iso3" | b"iso4" | b"iso5" | b"iso6" | b"mp41" | b"mp42"
            | b"avc1" | b"dash" | b"MSNV" => saw_mp4 = true,
            _ => {}
        }
    }
    if saw_mp4 {
        IsoBmffBrand::Mp4
    } else {
        IsoBmffBrand::Unknown
    }
}

struct MonoResampler {
    input_sample_rate: u32,
    resampler: Option<SincFixedIn<f32>>,
    input_plane: Vec<Vec<f32>>,
    output_plane: Vec<Vec<f32>>,
    pending_frames: usize,
    input_frames: u64,
    emitted_frames: u64,
    delay_frames: usize,
}

impl MonoResampler {
    fn new(input_sample_rate: u32) -> Result<Self, AttachmentAudioError> {
        if input_sample_rate == OUTPUT_SAMPLE_RATE {
            return Ok(Self {
                input_sample_rate,
                resampler: None,
                input_plane: Vec::new(),
                output_plane: Vec::new(),
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
        let resampler = SincFixedIn::<f32>::new(
            f64::from(OUTPUT_SAMPLE_RATE) / f64::from(input_sample_rate),
            1.0,
            parameters,
            RESAMPLER_CHUNK_FRAMES,
            1,
        )
        .map_err(|_| AttachmentAudioError::ResourceLimit)?;
        let input_plane = resampler.input_buffer_allocate(true);
        let output_plane = resampler.output_buffer_allocate(true);
        let delay_frames = resampler.output_delay();
        Ok(Self {
            input_sample_rate,
            resampler: Some(resampler),
            input_plane,
            output_plane,
            pending_frames: 0,
            input_frames: 0,
            emitted_frames: 0,
            delay_frames,
        })
    }

    fn process_frames(
        &mut self,
        interleaved: &[f32],
        channels: usize,
        output: &mut Vec<f32>,
    ) -> Result<(), AttachmentAudioError> {
        if channels == 0 || !interleaved.len().is_multiple_of(channels) {
            return Err(AttachmentAudioError::CorruptMedia);
        }
        for frame in interleaved.chunks_exact(channels) {
            let mono = frame.iter().copied().sum::<f32>() / channels as f32;
            self.input_frames = self
                .input_frames
                .checked_add(1)
                .ok_or(AttachmentAudioError::ResourceLimit)?;
            if self.resampler.is_none() {
                output.push(mono);
                self.emitted_frames = self
                    .emitted_frames
                    .checked_add(1)
                    .ok_or(AttachmentAudioError::ResourceLimit)?;
                continue;
            }
            self.input_plane[0][self.pending_frames] = mono;
            self.pending_frames += 1;
            if self.pending_frames == RESAMPLER_CHUNK_FRAMES {
                self.process_full_chunk(output, None)?;
            }
        }
        Ok(())
    }

    fn finish(&mut self, output: &mut Vec<f32>) -> Result<(), AttachmentAudioError> {
        let target_frames = self.expected_output_frames();
        if self.resampler.is_none() {
            return (self.emitted_frames == target_frames)
                .then_some(())
                .ok_or(AttachmentAudioError::CorruptMedia);
        }
        if self.pending_frames > 0 {
            self.input_plane[0][self.pending_frames..RESAMPLER_CHUNK_FRAMES].fill(0.0);
            self.process_full_chunk(output, Some(target_frames))?;
        }
        self.input_plane[0].fill(0.0);
        let mut flush_count = 0;
        while self.emitted_frames < target_frames {
            self.process_full_chunk(output, Some(target_frames))?;
            flush_count += 1;
            if flush_count > 8 {
                return Err(AttachmentAudioError::ResourceLimit);
            }
        }
        (self.emitted_frames == target_frames)
            .then_some(())
            .ok_or(AttachmentAudioError::CorruptMedia)
    }

    fn process_full_chunk(
        &mut self,
        output: &mut Vec<f32>,
        target_frames: Option<u64>,
    ) -> Result<(), AttachmentAudioError> {
        let (_, produced_frames) = self
            .resampler
            .as_mut()
            .expect("resampling chunks require Rubato")
            .process_into_buffer(&self.input_plane, &mut self.output_plane, None)
            .map_err(|_| AttachmentAudioError::ResourceLimit)?;
        self.pending_frames = 0;
        let first_frame = self.delay_frames.min(produced_frames);
        self.delay_frames -= first_frame;
        let available_frames = produced_frames - first_frame;
        let emit = target_frames.map_or(available_frames, |target| {
            available_frames.min(target.saturating_sub(self.emitted_frames) as usize)
        });
        output.extend_from_slice(&self.output_plane[0][first_frame..first_frame + emit]);
        self.emitted_frames = self
            .emitted_frames
            .checked_add(emit as u64)
            .ok_or(AttachmentAudioError::ResourceLimit)?;
        Ok(())
    }

    fn expected_output_frames(&self) -> u64 {
        let numerator = u128::from(self.input_frames) * u128::from(OUTPUT_SAMPLE_RATE)
            + u128::from(self.input_sample_rate) / 2;
        (numerator / u128::from(self.input_sample_rate)) as u64
    }
}

impl Drop for MonoResampler {
    fn drop(&mut self) {
        for plane in &mut self.input_plane {
            plane.zeroize();
        }
        for plane in &mut self.output_plane {
            plane.zeroize();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_pcm_wav(path: &Path, sample_rate: u32, channels: u16, frames: u32) {
        let data_bytes = frames * u32::from(channels) * 2;
        let mut file = File::create(path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + data_bytes).to_le_bytes()).unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16_u32.to_le_bytes()).unwrap();
        file.write_all(&1_u16.to_le_bytes()).unwrap();
        file.write_all(&channels.to_le_bytes()).unwrap();
        file.write_all(&sample_rate.to_le_bytes()).unwrap();
        file.write_all(&(sample_rate * u32::from(channels) * 2).to_le_bytes())
            .unwrap();
        file.write_all(&(channels * 2).to_le_bytes()).unwrap();
        file.write_all(&16_u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&data_bytes.to_le_bytes()).unwrap();
        for frame in 0..frames {
            for channel in 0..channels {
                let sample = ((frame + u32::from(channel)) % 1_000) as i16;
                file.write_all(&sample.to_le_bytes()).unwrap();
            }
        }
    }

    #[test]
    fn real_probe_ignores_extension_and_streams_wav_through_rubato() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("not-really-an-mp4.mp4");
        write_pcm_wav(&source, 48_000, 2, 4_800);

        let mut decoder = AttachmentAudioDecoder::open(&source).unwrap();
        assert_eq!(decoder.info().media_kind, "wav");
        assert_eq!(decoder.info().codec, "pcm");
        let mut starts = Vec::new();
        let mut samples = 0_u64;
        while let Some(chunk) = decoder.read_chunk().unwrap() {
            starts.push(chunk.start_sample());
            samples += chunk.samples().len() as u64;
        }
        assert_eq!(starts.first(), Some(&0));
        assert_eq!(samples, 1_600);
        assert_eq!(decoder.output_samples(), 1_600);
    }

    #[test]
    fn unsupported_container_is_rejected_by_probe_not_extension() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("looks-like.wav");
        fs::write(&source, b"not media").unwrap();
        assert_eq!(
            AttachmentAudioDecoder::open(&source).err(),
            Some(AttachmentAudioError::UnsupportedContainer)
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_source_is_rejected_without_following() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.wav");
        write_pcm_wav(&source, 16_000, 1, 160);
        let link = root.path().join("link.wav");
        symlink(&source, &link).unwrap();
        assert_eq!(
            AttachmentAudioDecoder::open(&link).err(),
            Some(AttachmentAudioError::UnsafeSource)
        );
    }

    #[test]
    fn iso_brand_classifier_distinguishes_product_whitelist() {
        assert_eq!(classify_iso_brands(b"M4A \0\0\0\0isom"), IsoBmffBrand::M4a);
        assert_eq!(classify_iso_brands(b"qt  \0\0\0\0qt  "), IsoBmffBrand::Mov);
        assert_eq!(classify_iso_brands(b"isom\0\0\0\0mp42"), IsoBmffBrand::Mp4);
        assert_eq!(
            classify_iso_brands(b"M4P \0\0\0\0isom"),
            IsoBmffBrand::EncryptedM4p
        );
    }
}
