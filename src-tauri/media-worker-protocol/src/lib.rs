use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use zeroize::Zeroize;

pub const PROTOCOL_VERSION: u32 = 1;
pub const SAMPLE_RATE: u32 = 16_000;
pub const MAX_CONTROL_FRAME_BYTES: usize = 256 * 1024;
pub const MAX_PCM_SAMPLES_PER_FRAME: usize = SAMPLE_RATE as usize * 5;
pub const MAX_TRANSCRIPT_TEXT_BYTES: usize = 64 * 1024;
pub const MAX_SPEAKER_TURNS_PER_BATCH: usize = 1_000;
pub const MAX_MEDIA_SAMPLES_PER_TRACK: u64 = SAMPLE_RATE as u64 * 60 * 60 * 8;

const CONTROL_FRAME_KIND: u8 = 1;
const PCM_FRAME_KIND: u8 = 2;
const PCM_HEADER_BYTES: usize = 1 + 4 + 8 + 1 + 8 + 8 + 4;
const MAX_WIRE_FRAME_BYTES: usize = 1 + MAX_CONTROL_FRAME_BYTES;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkloadKind {
    ModelPackProbe,
    RecordLiveAsr,
    RecordBackfillAsr,
    RecordDiarization,
    AttachmentProbe,
    AttachmentAsr,
}

impl WorkloadKind {
    pub fn accepts_pcm_frames(self) -> bool {
        matches!(self, Self::RecordLiveAsr)
    }

    pub fn can_cooperatively_yield(self) -> bool {
        matches!(
            self,
            Self::RecordLiveAsr
                | Self::RecordBackfillAsr
                | Self::RecordDiarization
                | Self::AttachmentAsr
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackKind {
    Microphone,
    System,
    Mixed,
    Attachment,
}

impl TrackKind {
    fn wire_value(self) -> u8 {
        match self {
            Self::Microphone => 1,
            Self::System => 2,
            Self::Mixed => 3,
            Self::Attachment => 4,
        }
    }

    fn from_wire(value: u8) -> Option<Self> {
        match value {
            1 => Some(Self::Microphone),
            2 => Some(Self::System),
            3 => Some(Self::Mixed),
            4 => Some(Self::Attachment),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkloadIdentity {
    pub workload_id: String,
    pub worker_generation: u64,
}

impl WorkloadIdentity {
    pub fn is_valid(&self) -> bool {
        !self.workload_id.is_empty()
            && self.workload_id.len() <= 128
            && self
                .workload_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            && self.worker_generation > 0
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PcmStreamStart {
    pub track: TrackKind,
    pub first_sequence: u64,
    pub first_sample: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PcmStreamEnd {
    pub track: TrackKind,
    pub last_sequence: Option<u64>,
    pub final_sample: u64,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordArtifactInput {
    pub input_path: String,
    pub track: TrackKind,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkloadInput {
    ModelPackProbe,
    LivePcm { streams: Vec<PcmStreamStart> },
    RecordArtifacts { inputs: Vec<RecordArtifactInput> },
    Attachment { input_path: String },
}

impl std::fmt::Debug for WorkloadInput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::ModelPackProbe => "WorkloadInput::ModelPackProbe",
            Self::LivePcm { .. } => "WorkloadInput::LivePcm",
            Self::RecordArtifacts { .. } => "WorkloadInput::RecordArtifacts([REDACTED])",
            Self::Attachment { .. } => "WorkloadInput::Attachment([REDACTED])",
        })
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub protocol_version: u32,
    pub identity: WorkloadIdentity,
    pub workload_kind: WorkloadKind,
    pub input: WorkloadInput,
    pub native_manifest_path: String,
    pub onnx_runtime_path: String,
    pub model_pack_manifest_path: String,
}

impl std::fmt::Debug for StartRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StartRequest")
            .field("protocol_version", &self.protocol_version)
            .field("identity", &self.identity)
            .field("workload_kind", &self.workload_kind)
            .field("input", &"[REDACTED]")
            .field("resource_paths", &"[REDACTED]")
            .finish()
    }
}

impl StartRequest {
    pub fn has_valid_shape(&self) -> bool {
        if self.protocol_version != PROTOCOL_VERSION
            || !self.identity.is_valid()
            || self.native_manifest_path.is_empty()
            || self.onnx_runtime_path.is_empty()
            || self.model_pack_manifest_path.is_empty()
        {
            return false;
        }
        matches!(
            (&self.workload_kind, &self.input),
            (WorkloadKind::ModelPackProbe, WorkloadInput::ModelPackProbe)
        ) || matches!(
            (&self.workload_kind, &self.input),
            (WorkloadKind::RecordLiveAsr, WorkloadInput::LivePcm { streams })
                if valid_live_streams(streams)
        ) || matches!(
            (&self.workload_kind, &self.input),
            (
                WorkloadKind::RecordBackfillAsr,
                WorkloadInput::RecordArtifacts { inputs }
            ) if valid_record_artifacts(inputs)
        ) || matches!(
            (&self.workload_kind, &self.input),
            (
                WorkloadKind::RecordDiarization,
                WorkloadInput::RecordArtifacts { inputs }
            ) if valid_record_artifacts(inputs)
        ) || matches!(
            (&self.workload_kind, &self.input),
            (
                WorkloadKind::AttachmentProbe | WorkloadKind::AttachmentAsr,
                WorkloadInput::Attachment { input_path }
            )
                if !input_path.is_empty()
        )
    }
}

fn valid_live_streams(streams: &[PcmStreamStart]) -> bool {
    (1..=2).contains(&streams.len())
        && streams
            .iter()
            .all(|stream| is_record_source_track(stream.track))
        && (streams.len() == 1 || streams[0].track != streams[1].track)
}

fn valid_record_artifacts(inputs: &[RecordArtifactInput]) -> bool {
    let valid_count = (1..=2).contains(&inputs.len());
    valid_count
        && inputs
            .iter()
            .all(|input| !input.input_path.is_empty() && is_record_source_track(input.track))
        && (inputs.len() == 1 || inputs[0].track != inputs[1].track)
}

fn is_record_source_track(track: TrackKind) -> bool {
    matches!(track, TrackKind::Microphone | TrackKind::System)
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkerCommand {
    Start(StartRequest),
    Finalize {
        protocol_version: u32,
        identity: WorkloadIdentity,
        streams: Vec<PcmStreamEnd>,
    },
    Flush {
        protocol_version: u32,
        identity: WorkloadIdentity,
    },
    Cancel {
        protocol_version: u32,
        identity: WorkloadIdentity,
    },
    Yield {
        protocol_version: u32,
        identity: WorkloadIdentity,
    },
    Ping {
        protocol_version: u32,
        identity: WorkloadIdentity,
        nonce: u64,
    },
}

impl std::fmt::Debug for WorkerCommand {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Start(start) => formatter.debug_tuple("Start").field(start).finish(),
            Self::Finalize { identity, .. } => {
                formatter.debug_tuple("Finalize").field(identity).finish()
            }
            Self::Flush { identity, .. } => formatter.debug_tuple("Flush").field(identity).finish(),
            Self::Cancel { identity, .. } => {
                formatter.debug_tuple("Cancel").field(identity).finish()
            }
            Self::Yield { identity, .. } => formatter.debug_tuple("Yield").field(identity).finish(),
            Self::Ping {
                identity, nonce, ..
            } => formatter
                .debug_struct("Ping")
                .field("identity", identity)
                .field("nonce", nonce)
                .finish(),
        }
    }
}

impl WorkerCommand {
    pub fn protocol_version(&self) -> u32 {
        match self {
            Self::Start(start) => start.protocol_version,
            Self::Finalize {
                protocol_version, ..
            }
            | Self::Flush {
                protocol_version, ..
            }
            | Self::Cancel {
                protocol_version, ..
            }
            | Self::Yield {
                protocol_version, ..
            }
            | Self::Ping {
                protocol_version, ..
            } => *protocol_version,
        }
    }

    pub fn identity(&self) -> &WorkloadIdentity {
        match self {
            Self::Start(start) => &start.identity,
            Self::Finalize { identity, .. }
            | Self::Flush { identity, .. }
            | Self::Cancel { identity, .. }
            | Self::Yield { identity, .. }
            | Self::Ping { identity, .. } => identity,
        }
    }

    pub fn has_valid_shape(&self) -> bool {
        if self.protocol_version() != PROTOCOL_VERSION || !self.identity().is_valid() {
            return false;
        }
        match self {
            Self::Start(start) => start.has_valid_shape(),
            Self::Finalize { streams, .. } => valid_stream_ends(streams),
            Self::Flush { .. } | Self::Cancel { .. } | Self::Yield { .. } | Self::Ping { .. } => {
                true
            }
        }
    }
}

fn valid_stream_ends(streams: &[PcmStreamEnd]) -> bool {
    (1..=2).contains(&streams.len())
        && streams
            .iter()
            .all(|stream| is_record_source_track(stream.track))
        && (streams.len() == 1 || streams[0].track != streams[1].track)
}

#[derive(Clone, PartialEq, Eq)]
pub struct PcmFrame {
    pub protocol_version: u32,
    pub worker_generation: u64,
    pub track: TrackKind,
    pub sequence: u64,
    pub start_sample: u64,
    pub samples: Vec<i16>,
}

impl std::fmt::Debug for PcmFrame {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PcmFrame")
            .field("protocol_version", &self.protocol_version)
            .field("worker_generation", &self.worker_generation)
            .field("track", &self.track)
            .field("sequence", &self.sequence)
            .field("start_sample", &self.start_sample)
            .field("sample_count", &self.samples.len())
            .finish()
    }
}

impl PcmFrame {
    pub fn has_valid_shape(&self) -> bool {
        self.protocol_version == PROTOCOL_VERSION
            && self.worker_generation > 0
            && is_record_source_track(self.track)
            && !self.samples.is_empty()
            && self.samples.len() <= MAX_PCM_SAMPLES_PER_FRAME
            && self
                .start_sample
                .checked_add(self.samples.len() as u64)
                .is_some()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStage {
    Loading,
    Decoding,
    Vad,
    Transcribing,
    SegmentingSpeakers,
    EmbeddingSpeakers,
    ClusteringSpeakers,
    ReconcilingSpeakers,
    Finalizing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgressUnit {
    Samples,
    Windows,
    Segments,
    Packets,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub streams: Vec<PcmStreamCheckpoint>,
    pub analysis_sample: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PcmStreamCheckpoint {
    pub track: TrackKind,
    pub last_ack_sequence: Option<u64>,
    pub analysis_sample: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerMetrics {
    pub source_samples: u64,
    pub segments: u32,
    pub speakers: u32,
    pub elapsed_ms: u64,
    pub peak_working_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerTurn {
    pub start_sample: u64,
    pub end_sample: u64,
    pub global_speaker: u32,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WorkerResponse {
    Ready {
        protocol_version: u32,
        identity: WorkloadIdentity,
    },
    Heartbeat {
        protocol_version: u32,
        identity: WorkloadIdentity,
        stage: WorkerStage,
        checkpoint: Checkpoint,
    },
    InputAck {
        protocol_version: u32,
        identity: WorkloadIdentity,
        track: TrackKind,
        sequence: u64,
        end_sample: u64,
    },
    MediaProbed {
        protocol_version: u32,
        identity: WorkloadIdentity,
        media_kind: String,
        codec: String,
        duration_ms: Option<u64>,
        used_default_track: bool,
    },
    TranscriptSegment {
        protocol_version: u32,
        identity: WorkloadIdentity,
        segment_id: String,
        track: TrackKind,
        start_sample: u64,
        end_sample: u64,
        text: String,
        language: Option<String>,
        revision: u64,
    },
    SpeakerTurnBatch {
        protocol_version: u32,
        identity: WorkloadIdentity,
        revision: u64,
        batch_index: u32,
        is_last: bool,
        turns: Vec<SpeakerTurn>,
    },
    Progress {
        protocol_version: u32,
        identity: WorkloadIdentity,
        stage: WorkerStage,
        current: u64,
        total: u64,
        unit: ProgressUnit,
    },
    Yielded {
        protocol_version: u32,
        identity: WorkloadIdentity,
        checkpoint: Checkpoint,
    },
    Pong {
        protocol_version: u32,
        identity: WorkloadIdentity,
        nonce: u64,
    },
    Completed {
        protocol_version: u32,
        identity: WorkloadIdentity,
        metrics: WorkerMetrics,
    },
    Failed {
        protocol_version: u32,
        identity: WorkloadIdentity,
        code: String,
    },
}

impl std::fmt::Debug for WorkerResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Ready { .. } => "WorkerResponse::Ready",
            Self::Heartbeat { .. } => "WorkerResponse::Heartbeat",
            Self::InputAck { .. } => "WorkerResponse::InputAck",
            Self::MediaProbed { .. } => "WorkerResponse::MediaProbed",
            Self::TranscriptSegment { .. } => "WorkerResponse::TranscriptSegment([REDACTED])",
            Self::SpeakerTurnBatch { .. } => "WorkerResponse::SpeakerTurnBatch",
            Self::Progress { .. } => "WorkerResponse::Progress",
            Self::Yielded { .. } => "WorkerResponse::Yielded",
            Self::Pong { .. } => "WorkerResponse::Pong",
            Self::Completed { .. } => "WorkerResponse::Completed",
            Self::Failed { .. } => "WorkerResponse::Failed",
        })
    }
}

impl WorkerResponse {
    pub fn protocol_version(&self) -> u32 {
        match self {
            Self::Ready {
                protocol_version, ..
            }
            | Self::Heartbeat {
                protocol_version, ..
            }
            | Self::InputAck {
                protocol_version, ..
            }
            | Self::MediaProbed {
                protocol_version, ..
            }
            | Self::TranscriptSegment {
                protocol_version, ..
            }
            | Self::SpeakerTurnBatch {
                protocol_version, ..
            }
            | Self::Progress {
                protocol_version, ..
            }
            | Self::Yielded {
                protocol_version, ..
            }
            | Self::Pong {
                protocol_version, ..
            }
            | Self::Completed {
                protocol_version, ..
            }
            | Self::Failed {
                protocol_version, ..
            } => *protocol_version,
        }
    }

    pub fn identity(&self) -> &WorkloadIdentity {
        match self {
            Self::Ready { identity, .. }
            | Self::Heartbeat { identity, .. }
            | Self::InputAck { identity, .. }
            | Self::MediaProbed { identity, .. }
            | Self::TranscriptSegment { identity, .. }
            | Self::SpeakerTurnBatch { identity, .. }
            | Self::Progress { identity, .. }
            | Self::Yielded { identity, .. }
            | Self::Pong { identity, .. }
            | Self::Completed { identity, .. }
            | Self::Failed { identity, .. } => identity,
        }
    }

    pub fn has_valid_shape(&self) -> bool {
        if self.protocol_version() != PROTOCOL_VERSION || !self.identity().is_valid() {
            return false;
        }
        match self {
            Self::Ready { .. } | Self::Pong { .. } => true,
            Self::Heartbeat { checkpoint, .. } | Self::Yielded { checkpoint, .. } => {
                valid_checkpoint(checkpoint)
            }
            Self::InputAck {
                track, end_sample, ..
            } => is_record_source_track(*track) && *end_sample <= MAX_MEDIA_SAMPLES_PER_TRACK,
            Self::MediaProbed {
                media_kind,
                codec,
                duration_ms,
                ..
            } => {
                matches!(
                    media_kind.as_str(),
                    "wav" | "aiff" | "mp3" | "flac" | "ogg" | "m4a" | "mp4" | "mov"
                ) && matches!(
                    codec.as_str(),
                    "pcm" | "adpcm" | "mp3" | "flac" | "vorbis" | "aac-lc" | "alac"
                ) && duration_ms.is_none_or(|duration| duration <= 8 * 60 * 60 * 1_000)
            }
            Self::TranscriptSegment {
                segment_id,
                track,
                start_sample,
                end_sample,
                text,
                language,
                revision,
                ..
            } => {
                valid_protocol_id(segment_id)
                    && is_transcription_track(*track)
                    && start_sample < end_sample
                    && *end_sample <= MAX_MEDIA_SAMPLES_PER_TRACK
                    && !text.trim().is_empty()
                    && text.len() <= MAX_TRANSCRIPT_TEXT_BYTES
                    && !text.contains('\0')
                    && language.as_deref().is_none_or(valid_language)
                    && *revision > 0
            }
            Self::SpeakerTurnBatch {
                revision,
                batch_index,
                is_last,
                turns,
                ..
            } => {
                *revision > 0
                    && ((!turns.is_empty()
                        && (*is_last || turns.len() == MAX_SPEAKER_TURNS_PER_BATCH))
                        || (*is_last && *batch_index == 0 && turns.is_empty()))
                    && turns.len() <= MAX_SPEAKER_TURNS_PER_BATCH
                    && turns.iter().all(valid_speaker_turn)
                    && turns.windows(2).all(|pair| {
                        (
                            pair[0].start_sample,
                            pair[0].end_sample,
                            pair[0].global_speaker,
                        ) <= (
                            pair[1].start_sample,
                            pair[1].end_sample,
                            pair[1].global_speaker,
                        )
                    })
            }
            Self::Progress { current, total, .. } => *total > 0 && current <= total,
            Self::Completed { metrics, .. } => valid_metrics(metrics),
            Self::Failed { code, .. } => valid_error_code(code),
        }
    }

    pub fn zeroize_sensitive(&mut self) {
        if let Self::TranscriptSegment { text, language, .. } = self {
            text.zeroize();
            if let Some(language) = language {
                language.zeroize();
            }
        }
    }
}

fn valid_protocol_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_language(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_error_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn valid_checkpoint(checkpoint: &Checkpoint) -> bool {
    (1..=2).contains(&checkpoint.streams.len())
        && checkpoint.streams.iter().all(|stream| {
            is_transcription_track(stream.track)
                && stream.analysis_sample <= MAX_MEDIA_SAMPLES_PER_TRACK
        })
        && (checkpoint.streams.len() == 1
            || checkpoint.streams[0].track != checkpoint.streams[1].track)
        && checkpoint.analysis_sample
            == checkpoint
                .streams
                .iter()
                .map(|stream| stream.analysis_sample)
                .max()
                .unwrap_or(0)
}

fn is_transcription_track(track: TrackKind) -> bool {
    is_record_source_track(track) || track == TrackKind::Attachment
}

fn valid_speaker_turn(turn: &SpeakerTurn) -> bool {
    turn.start_sample < turn.end_sample
        && turn.end_sample <= MAX_MEDIA_SAMPLES_PER_TRACK
        && turn.global_speaker <= 4_096
}

fn valid_metrics(metrics: &WorkerMetrics) -> bool {
    metrics.source_samples > 0
        && metrics.source_samples <= MAX_MEDIA_SAMPLES_PER_TRACK.saturating_mul(2)
        && metrics.segments <= 200_000
        && metrics.speakers <= 4_096
}

#[derive(Debug)]
pub enum ManagerFrame {
    Control(WorkerCommand),
    Pcm(PcmFrame),
}

pub fn read_manager_frame(reader: &mut impl Read) -> io::Result<Option<ManagerFrame>> {
    let Some(mut payload) = read_wire_frame(reader)? else {
        return Ok(None);
    };
    let parsed = match payload[0] {
        CONTROL_FRAME_KIND => serde_json::from_slice(&payload[1..])
            .map(|command| Some(ManagerFrame::Control(command)))
            .map_err(|_| invalid_data("invalid control JSON")),
        PCM_FRAME_KIND => parse_pcm_frame(&payload).map(|frame| Some(ManagerFrame::Pcm(frame))),
        _ => Err(invalid_data("unknown media worker frame kind")),
    };
    payload.zeroize();
    parsed
}

pub fn read_worker_response(reader: &mut impl Read) -> io::Result<Option<WorkerResponse>> {
    let Some(mut payload) = read_wire_frame(reader)? else {
        return Ok(None);
    };
    let parsed = if payload[0] != CONTROL_FRAME_KIND {
        Err(invalid_data("unexpected media worker response frame kind"))
    } else {
        serde_json::from_slice::<WorkerResponse>(&payload[1..])
            .map_err(|_| invalid_data("invalid worker response JSON"))
            .and_then(|mut response| {
                if response.has_valid_shape() {
                    Ok(Some(response))
                } else {
                    response.zeroize_sensitive();
                    Err(invalid_data("invalid worker response shape"))
                }
            })
    };
    payload.zeroize();
    parsed
}

pub fn write_control_frame(writer: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    let mut json =
        serde_json::to_vec(value).map_err(|_| invalid_data("control serialization failed"))?;
    if json.is_empty() || json.len() > MAX_CONTROL_FRAME_BYTES {
        json.zeroize();
        return Err(invalid_data("control frame exceeds fixed limit"));
    }
    let mut payload = Vec::with_capacity(1 + json.len());
    payload.push(CONTROL_FRAME_KIND);
    payload.extend_from_slice(&json);
    json.zeroize();
    let result = write_wire_frame(writer, &payload);
    payload.zeroize();
    result
}

pub fn write_pcm_frame(writer: &mut impl Write, frame: &PcmFrame) -> io::Result<()> {
    if !frame.has_valid_shape() {
        return Err(invalid_data("invalid PCM frame"));
    }
    let sample_count = u32::try_from(frame.samples.len())
        .map_err(|_| invalid_data("PCM sample count exceeds protocol"))?;
    let mut payload = Vec::with_capacity(PCM_HEADER_BYTES + frame.samples.len() * 2);
    payload.push(PCM_FRAME_KIND);
    payload.extend_from_slice(&frame.protocol_version.to_be_bytes());
    payload.extend_from_slice(&frame.worker_generation.to_be_bytes());
    payload.push(frame.track.wire_value());
    payload.extend_from_slice(&frame.sequence.to_be_bytes());
    payload.extend_from_slice(&frame.start_sample.to_be_bytes());
    payload.extend_from_slice(&sample_count.to_be_bytes());
    for sample in &frame.samples {
        payload.extend_from_slice(&sample.to_le_bytes());
    }
    write_wire_frame(writer, &payload)
}

fn parse_pcm_frame(payload: &[u8]) -> io::Result<PcmFrame> {
    if payload.len() < PCM_HEADER_BYTES {
        return Err(invalid_data("truncated PCM frame header"));
    }
    let protocol_version = u32::from_be_bytes(payload[1..5].try_into().unwrap());
    let worker_generation = u64::from_be_bytes(payload[5..13].try_into().unwrap());
    let track = TrackKind::from_wire(payload[13])
        .ok_or_else(|| invalid_data("invalid PCM track identity"))?;
    let sequence = u64::from_be_bytes(payload[14..22].try_into().unwrap());
    let start_sample = u64::from_be_bytes(payload[22..30].try_into().unwrap());
    let sample_count = u32::from_be_bytes(payload[30..34].try_into().unwrap()) as usize;
    if sample_count == 0 || sample_count > MAX_PCM_SAMPLES_PER_FRAME {
        return Err(invalid_data("PCM sample count exceeds fixed limit"));
    }
    let expected = PCM_HEADER_BYTES
        .checked_add(sample_count.saturating_mul(2))
        .ok_or_else(|| invalid_data("PCM frame length overflow"))?;
    if payload.len() != expected {
        return Err(invalid_data("PCM payload length mismatch"));
    }
    let samples = payload[PCM_HEADER_BYTES..]
        .chunks_exact(2)
        .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]))
        .collect::<Vec<_>>();
    let frame = PcmFrame {
        protocol_version,
        worker_generation,
        track,
        sequence,
        start_sample,
        samples,
    };
    if !frame.has_valid_shape() {
        return Err(invalid_data("invalid PCM frame identity"));
    }
    Ok(frame)
}

fn read_wire_frame(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut prefix = [0_u8; 4];
    loop {
        match reader.read(&mut prefix[..1]) {
            Ok(0) => return Ok(None),
            Ok(1) => break,
            Ok(_) => unreachable!("one-byte read returned more than one byte"),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        }
    }
    reader.read_exact(&mut prefix[1..])?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0
        || length > MAX_WIRE_FRAME_BYTES.max(PCM_HEADER_BYTES + 2 * MAX_PCM_SAMPLES_PER_FRAME)
    {
        return Err(invalid_data("media worker frame exceeds fixed limit"));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    Ok(Some(payload))
}

fn write_wire_frame(writer: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    let length = u32::try_from(payload.len())
        .map_err(|_| invalid_data("media worker frame length exceeds protocol"))?;
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

fn invalid_data(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> WorkloadIdentity {
        WorkloadIdentity {
            workload_id: "record_123".into(),
            worker_generation: 7,
        }
    }

    fn start_request() -> StartRequest {
        StartRequest {
            protocol_version: PROTOCOL_VERSION,
            identity: identity(),
            workload_kind: WorkloadKind::RecordLiveAsr,
            input: WorkloadInput::LivePcm {
                streams: vec![
                    PcmStreamStart {
                        track: TrackKind::Microphone,
                        first_sequence: 4,
                        first_sample: 2_048,
                    },
                    PcmStreamStart {
                        track: TrackKind::System,
                        first_sequence: 9,
                        first_sample: 2_048,
                    },
                ],
            },
            native_manifest_path: "/private/native-manifest.json".into(),
            onnx_runtime_path: "/private/libonnxruntime.dylib".into(),
            model_pack_manifest_path: "/private/model-pack.json".into(),
        }
    }

    #[test]
    fn control_frame_round_trips_without_exposing_paths_in_debug() {
        for command in [
            WorkerCommand::Start(start_request()),
            WorkerCommand::Flush {
                protocol_version: PROTOCOL_VERSION,
                identity: identity(),
            },
        ] {
            let mut wire = Vec::new();
            write_control_frame(&mut wire, &command).unwrap();
            let ManagerFrame::Control(decoded) =
                read_manager_frame(&mut wire.as_slice()).unwrap().unwrap()
            else {
                panic!("expected control frame");
            };
            assert_eq!(decoded, command);
            let debug = format!("{decoded:?}");
            assert!(!debug.contains("/private/"));
            assert!(!debug.contains("libonnxruntime"));
        }
    }

    #[test]
    fn pcm_frame_is_binary_little_endian_and_round_trips_exactly() {
        let frame = PcmFrame {
            protocol_version: PROTOCOL_VERSION,
            worker_generation: 7,
            track: TrackKind::System,
            sequence: 91,
            start_sample: 32_000,
            samples: vec![i16::MIN, -1, 0, 1, i16::MAX],
        };
        let mut wire = Vec::new();
        write_pcm_frame(&mut wire, &frame).unwrap();
        assert!(wire.windows(2).any(|bytes| bytes == i16::MIN.to_le_bytes()));
        let ManagerFrame::Pcm(decoded) = read_manager_frame(&mut wire.as_slice()).unwrap().unwrap()
        else {
            panic!("expected PCM frame");
        };
        assert_eq!(decoded, frame);
        assert!(!format!("{decoded:?}").contains("-32768"));
    }

    #[test]
    fn rejects_oversized_frame_before_allocating_payload() {
        let length =
            (MAX_WIRE_FRAME_BYTES.max(PCM_HEADER_BYTES + 2 * MAX_PCM_SAMPLES_PER_FRAME) + 1) as u32;
        let prefix = length.to_be_bytes();
        let mut wire = prefix.as_slice();
        let error = read_manager_frame(&mut wire).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn rejects_pcm_length_and_generation_mismatch() {
        let frame = PcmFrame {
            protocol_version: PROTOCOL_VERSION,
            worker_generation: 7,
            track: TrackKind::Microphone,
            sequence: 1,
            start_sample: 0,
            samples: vec![1, 2, 3],
        };
        let mut wire = Vec::new();
        write_pcm_frame(&mut wire, &frame).unwrap();
        wire.pop();
        let error = read_manager_frame(&mut wire.as_slice()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);

        let mut invalid = frame;
        invalid.worker_generation = 0;
        let error = write_pcm_frame(&mut Vec::new(), &invalid).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn start_shape_binds_each_workload_to_its_domain_input() {
        let mut start = start_request();
        assert!(start.has_valid_shape());
        start.workload_kind = WorkloadKind::AttachmentAsr;
        assert!(!start.has_valid_shape());
        start.input = WorkloadInput::Attachment {
            input_path: "/private/job/source.m4a".into(),
        };
        assert!(start.has_valid_shape());
        start.workload_kind = WorkloadKind::AttachmentProbe;
        assert!(start.has_valid_shape());
        assert!(WorkloadKind::RecordLiveAsr.can_cooperatively_yield());
        assert!(WorkloadKind::AttachmentAsr.can_cooperatively_yield());
        assert!(!WorkloadKind::AttachmentProbe.can_cooperatively_yield());

        start.workload_kind = WorkloadKind::ModelPackProbe;
        start.input = WorkloadInput::ModelPackProbe;
        assert!(start.has_valid_shape());
        assert!(!WorkloadKind::ModelPackProbe.can_cooperatively_yield());
        assert!(!format!("{:?}", start.input).contains("/private/"));

        start.workload_kind = WorkloadKind::RecordDiarization;
        start.input = WorkloadInput::RecordArtifacts {
            inputs: vec![RecordArtifactInput {
                input_path: "/private/record/system.opus".into(),
                track: TrackKind::System,
            }],
        };
        assert!(start.has_valid_shape());
        if let WorkloadInput::RecordArtifacts { inputs } = &mut start.input {
            inputs.push(RecordArtifactInput {
                input_path: "/private/record/microphone.opus".into(),
                track: TrackKind::Microphone,
            });
        }
        assert!(
            start.has_valid_shape(),
            "diarization accepts both physical Record tracks"
        );

        let finalize = WorkerCommand::Finalize {
            protocol_version: PROTOCOL_VERSION,
            identity: identity(),
            streams: vec![
                PcmStreamEnd {
                    track: TrackKind::Microphone,
                    last_sequence: Some(8),
                    final_sample: 32_000,
                },
                PcmStreamEnd {
                    track: TrackKind::System,
                    last_sequence: None,
                    final_sample: 32_000,
                },
            ],
        };
        assert!(finalize.has_valid_shape());
        let WorkerCommand::Finalize { mut streams, .. } = finalize else {
            unreachable!();
        };
        streams[1].track = TrackKind::Microphone;
        assert!(
            !WorkerCommand::Finalize {
                protocol_version: PROTOCOL_VERSION,
                identity: identity(),
                streams,
            }
            .has_valid_shape()
        );
    }

    #[test]
    fn workload_identity_rejects_paths_whitespace_and_zero_generation() {
        for workload_id in ["", "../record", "record id", "录音"] {
            assert!(
                !WorkloadIdentity {
                    workload_id: workload_id.into(),
                    worker_generation: 1,
                }
                .is_valid()
            );
        }
        assert!(
            !WorkloadIdentity {
                workload_id: "record-1".into(),
                worker_generation: 0,
            }
            .is_valid()
        );
    }

    #[test]
    fn transcript_response_debug_redacts_content() {
        let mut response = WorkerResponse::TranscriptSegment {
            protocol_version: PROTOCOL_VERSION,
            identity: identity(),
            segment_id: "segment-1".into(),
            track: TrackKind::Microphone,
            start_sample: 0,
            end_sample: 16_000,
            text: "unique-secret-transcript".into(),
            language: Some("zh".into()),
            revision: 1,
        };
        let debug = format!("{response:?}");
        assert!(!debug.contains("unique-secret-transcript"));
        let mut wire = Vec::new();
        write_control_frame(&mut wire, &response).unwrap();
        let decoded = read_worker_response(&mut wire.as_slice()).unwrap().unwrap();
        assert!(decoded.has_valid_shape());
        assert_eq!(decoded.identity(), &identity());
        response.zeroize_sensitive();
        let WorkerResponse::TranscriptSegment { text, language, .. } = response else {
            unreachable!();
        };
        assert!(text.is_empty());
        assert_eq!(language.as_deref(), Some(""));
        assert!(
            wire.windows(24)
                .any(|bytes| bytes == b"unique-secret-transcript")
        );
    }

    #[test]
    fn attachment_probe_and_transcript_use_the_attachment_track_only() {
        let probe = WorkerResponse::MediaProbed {
            protocol_version: PROTOCOL_VERSION,
            identity: identity(),
            media_kind: "m4a".into(),
            codec: "aac-lc".into(),
            duration_ms: Some(60_000),
            used_default_track: true,
        };
        assert!(probe.has_valid_shape());
        let transcript = WorkerResponse::TranscriptSegment {
            protocol_version: PROTOCOL_VERSION,
            identity: identity(),
            segment_id: "segment-1".into(),
            track: TrackKind::Attachment,
            start_sample: 0,
            end_sample: 16_000,
            text: "private attachment words".into(),
            language: Some("en".into()),
            revision: 1,
        };
        assert!(transcript.has_valid_shape());
        assert!(
            WorkerResponse::Heartbeat {
                protocol_version: PROTOCOL_VERSION,
                identity: identity(),
                stage: WorkerStage::Transcribing,
                checkpoint: Checkpoint {
                    streams: vec![PcmStreamCheckpoint {
                        track: TrackKind::Attachment,
                        last_ack_sequence: None,
                        analysis_sample: 16_000,
                    }],
                    analysis_sample: 16_000,
                },
            }
            .has_valid_shape()
        );
    }

    #[test]
    fn manager_rejects_invalid_worker_response_shapes() {
        let invalid = WorkerResponse::TranscriptSegment {
            protocol_version: PROTOCOL_VERSION,
            identity: identity(),
            segment_id: "../segment".into(),
            track: TrackKind::Microphone,
            start_sample: 0,
            end_sample: 16_000,
            text: "sensitive text".into(),
            language: Some("zh".into()),
            revision: 1,
        };
        let mut wire = Vec::new();
        write_control_frame(&mut wire, &invalid).unwrap();
        let error = read_worker_response(&mut wire.as_slice()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);

        let invalid_batch = WorkerResponse::SpeakerTurnBatch {
            protocol_version: PROTOCOL_VERSION,
            identity: identity(),
            revision: 1,
            batch_index: 0,
            is_last: true,
            turns: vec![SpeakerTurn {
                start_sample: 9,
                end_sample: 8,
                global_speaker: 0,
            }],
        };
        assert!(!invalid_batch.has_valid_shape());
    }
}
