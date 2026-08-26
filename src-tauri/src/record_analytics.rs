//! Typed, content-free analytics receipts for Record/Recording/Speech owners.
//!
//! This module is deliberately only a process-local bridge. Product owners
//! emit after their authoritative mutation or terminal commit; the Renderer
//! reuses the existing analytics privacy hash and transport. There is no
//! durable outbox, network client, retry loop, or business-state replay here.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{LazyLock, Mutex};
use tokio::sync::broadcast;

pub const TAURI_EVENT: &str = "analytics:record-milestone";
#[cfg(test)]
pub const ANALYTICS_SOURCES_V1: &[&str] =
    &["desktop", "floating_ball", "cli", "cli_agent", "cron", "im"];
#[cfg(test)]
pub const RECORD_USE_OPERATIONS_V1: &[&str] = &[
    "open",
    "play",
    "export_audio",
    "export_transcript",
    "archive",
    "delete",
    "speaker_rename",
    "speaker_merge",
    "speaker_reassign",
];
pub const ANALYTICS_ERROR_CODES_V1: &[&str] = &[
    "RECORDING_DEVICE_CHANGED",
    "RECORDING_DISK_LOW",
    "RECORDING_DISK_UNAVAILABLE",
    "RECORDING_DISPLAY_CHANGED",
    "RECORDING_MICROPHONE_PERMISSION_REQUIRED",
    "RECORDING_MICROPHONE_UNAVAILABLE",
    "RECORDING_NO_AVAILABLE_SOURCE",
    "RECORDING_PIPEWIRE_MONITOR_UNAVAILABLE",
    "RECORDING_PIPEWIRE_UNAVAILABLE",
    "RECORDING_RECOVERY_FAILED",
    "RECORDING_SCREEN_PERMISSION_REQUIRED",
    "RECORDING_START_FAILED",
    "RECORDING_SYSTEM_AUDIO_UNAVAILABLE",
    "RECORDING_TRACK_RECOVERY_PARTIAL",
    "SPEECH_ANALYSIS_BOUNDARY_INVALID",
    "SPEECH_ANALYSIS_SOURCE_INVALID",
    "SPEECH_ANALYSIS_SOURCE_UNAVAILABLE",
    "SPEECH_CANCELLED",
    "SPEECH_CORRUPT_MEDIA",
    "SPEECH_DEADLINE_EXCEEDED",
    "SPEECH_DEFAULT_AUDIO_TRACK_MISSING",
    "SPEECH_DIARIZATION_QUEUE_FAILED",
    "SPEECH_ENCRYPTED_MEDIA",
    "SPEECH_INFERENCE_FAILED",
    "SPEECH_INTERRUPTED",
    "SPEECH_JOB_STORE_WRITE_FAILED",
    "SPEECH_MANAGER_SHUTTING_DOWN",
    "SPEECH_MANAGER_UNAVAILABLE",
    "SPEECH_MEDIA_LIMIT_EXCEEDED",
    "SPEECH_MODEL_LOAD_FAILED",
    "SPEECH_MODEL_LOAD_TIMEOUT",
    "SPEECH_MODEL_PACK_REVISION_UNAVAILABLE",
    "SPEECH_MODEL_PACK_UNAVAILABLE",
    "SPEECH_NATIVE_RUNTIME_UNAVAILABLE",
    "SPEECH_NO_AUDIO_TRACK",
    "SPEECH_OUTPUT_COLLISION",
    "SPEECH_OUTPUT_PATH_UNSAFE",
    "SPEECH_PATH_ENCODING_UNSUPPORTED",
    "SPEECH_PIPELINE_REVISION_UNAVAILABLE",
    "SPEECH_PRIVATE_INPUT_UNAVAILABLE",
    "SPEECH_PRIVATE_STORAGE_UNAVAILABLE",
    "SPEECH_PUBLISH_FAILED",
    "SPEECH_QUEUE_FULL",
    "SPEECH_RECORD_AUDIO_UNAVAILABLE",
    "SPEECH_RECORD_UPDATE_FAILED",
    "SPEECH_RESOURCE_ACTIVATION_DURABILITY_UNCONFIRMED",
    "SPEECH_RESOURCE_ACTIVATION_FAILED",
    "SPEECH_RESOURCE_ARCHIVE_INVALID",
    "SPEECH_RESOURCE_BUSY",
    "SPEECH_RESOURCE_CHANGED",
    "SPEECH_RESOURCE_CORRUPT",
    "SPEECH_RESOURCE_DOWNLOAD_INVALID",
    "SPEECH_RESOURCE_INSTALL_INTERRUPTED",
    "SPEECH_RESOURCE_LIMIT",
    "SPEECH_RESOURCE_MANIFEST_INVALID",
    "SPEECH_RESOURCE_NETWORK",
    "SPEECH_RESOURCE_PACK_INVALID",
    "SPEECH_RESOURCE_REMOVE_FAILED",
    "SPEECH_RESOURCE_REQUIRED",
    "SPEECH_RESOURCE_SIGNATURE_INVALID",
    "SPEECH_RESOURCE_SOURCE_LOCK_INVALID",
    "SPEECH_RESOURCE_STORE_WRITE_FAILED",
    "SPEECH_SESSION_REQUIRED",
    "SPEECH_SOURCE_CHANGED",
    "SPEECH_SOURCE_READ_FAILED",
    "SPEECH_SOURCE_UNAVAILABLE",
    "SPEECH_SOURCE_UNSAFE",
    "SPEECH_UNSUPPORTED_CODEC",
    "SPEECH_WORKER_CRASHED",
    "SPEECH_WORKER_DISCONNECTED",
    "SPEECH_WORKER_IO_ERROR",
    "SPEECH_WORKER_PROTOCOL_ERROR",
    "SPEECH_WORKER_START_FAILED",
    "SPEECH_WORKER_TIMEOUT",
    "SPEECH_WORKLOAD_NOT_READY",
    "SPEECH_WORKSPACE_UNSAFE",
];
const PRE_BRIDGE_RECOVERY_LIMIT: usize = 64;

static CHANNEL: LazyLock<broadcast::Sender<RecordAnalyticsMilestone>> =
    LazyLock::new(|| broadcast::channel(256).0);
static BRIDGE_STATE: LazyLock<Mutex<BridgeState>> =
    LazyLock::new(|| Mutex::new(BridgeState::default()));

#[derive(Default)]
struct BridgeState {
    ready: bool,
    pending_recovery: VecDeque<RecordAnalyticsMilestone>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnalyticsRecordKind {
    Text,
    Audio,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnalyticsSource {
    Desktop,
    CliAgent,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnalyticsSurface {
    LauncherInput,
    TaskCenter,
    FloatingBall,
    RecordDetail,
    SpeechToolCard,
    Unknown,
}

impl From<crate::record::RecordKind> for AnalyticsRecordKind {
    fn from(value: crate::record::RecordKind) -> Self {
        match value {
            crate::record::RecordKind::Text => Self::Text,
            crate::record::RecordKind::Audio => Self::Audio,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnalyticsOutcome {
    Success,
    Partial,
    Failed,
    Canceled,
    Interrupted,
    Rejected,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingRecoveryOutcome {
    Repaired,
    Partial,
    Unrecoverable,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordingFinishReason {
    UserStop,
    AppExit,
    DeviceOpenFailed,
    DeviceFatal,
    LowDisk,
    RecordingStateCommitFailed,
    RecordingJournalCommitFailed,
    PauseResumeFailed,
    PauseResumeStateCommitFailed,
    PauseResumeJournalFailed,
}

impl RecordingFinishReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::UserStop => "user_stop",
            Self::AppExit => "app_exit",
            Self::DeviceOpenFailed => "device_open_failed",
            Self::DeviceFatal => "device_fatal",
            Self::LowDisk => "low_disk",
            Self::RecordingStateCommitFailed => "recording_state_commit_failed",
            Self::RecordingJournalCommitFailed => "recording_journal_commit_failed",
            Self::PauseResumeFailed => "pause_resume_failed",
            Self::PauseResumeStateCommitFailed => "pause_resume_state_commit_failed",
            Self::PauseResumeJournalFailed => "pause_resume_journal_failed",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureSources {
    None,
    Microphone,
    System,
    MicrophoneSystem,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptionMode {
    Unavailable,
    Live,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechResourceState {
    Ready,
    NotInstalled,
    NativeUnavailable,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SystemAudioCapability {
    Available,
    Unavailable,
    NotRequested,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordUseOperation {
    ExportAudio,
    ExportTranscript,
    Archive,
    Delete,
    SpeakerRename,
    SpeakerMerge,
    SpeakerReassign,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechProcessingStage {
    Backfill,
    Diarization,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechResourceOperation {
    Download,
    Update,
    Retry,
    Remove,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechAttachmentOperation {
    Submit,
    Finish,
    Cancel,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AnalyticsMediaKind {
    Wav,
    Aiff,
    Mp3,
    Flac,
    Ogg,
    M4a,
    Mp4,
    Mov,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum MediaDurationBucket {
    #[serde(rename = "lt_1m")]
    LessThanOneMinute,
    #[serde(rename = "1_5m")]
    OneToFiveMinutes,
    #[serde(rename = "5_15m")]
    FiveToFifteenMinutes,
    #[serde(rename = "15_30m")]
    FifteenToThirtyMinutes,
    #[serde(rename = "30_60m")]
    ThirtyToSixtyMinutes,
    #[serde(rename = "1_2h")]
    OneToTwoHours,
    #[serde(rename = "2_4h")]
    TwoToFourHours,
    #[serde(rename = "4_8h")]
    FourToEightHours,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum SmallCountBucket {
    #[serde(rename = "0")]
    Zero,
    #[serde(rename = "1")]
    One,
    #[serde(rename = "2_5")]
    TwoToFive,
    #[serde(rename = "6_20")]
    SixToTwenty,
    #[serde(rename = "gt_20")]
    MoreThanTwenty,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum SegmentCountBucket {
    #[serde(rename = "0")]
    Zero,
    #[serde(rename = "1_20")]
    OneToTwenty,
    #[serde(rename = "21_100")]
    TwentyOneToOneHundred,
    #[serde(rename = "101_500")]
    OneHundredOneToFiveHundred,
    #[serde(rename = "gt_500")]
    MoreThanFiveHundred,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum SpeakerCountBucket {
    #[serde(rename = "0")]
    Zero,
    #[serde(rename = "1")]
    One,
    #[serde(rename = "2")]
    Two,
    #[serde(rename = "3_4")]
    ThreeToFour,
    #[serde(rename = "gte_5")]
    FiveOrMore,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum MediaBytesBucket {
    #[serde(rename = "lt_10mb")]
    LessThanTenMegabytes,
    #[serde(rename = "10_50mb")]
    TenToFiftyMegabytes,
    #[serde(rename = "50_200mb")]
    FiftyToTwoHundredMegabytes,
    #[serde(rename = "200_500mb")]
    TwoHundredToFiveHundredMegabytes,
    #[serde(rename = "500mb_1gb")]
    FiveHundredMegabytesToOneGigabyte,
    #[serde(rename = "1_4gb")]
    OneToFourGigabytes,
    #[serde(rename = "gte_4gb")]
    FourGigabytesOrMore,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum TranscriptCoverageBucket {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "lt_50")]
    LessThanFiftyPercent,
    #[serde(rename = "50_90")]
    FiftyToNinetyPercent,
    #[serde(rename = "90_99")]
    NinetyToNinetyNinePercent,
    #[serde(rename = "complete")]
    Complete,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum SegmentLatencyBucket {
    #[serde(rename = "lt_500ms")]
    LessThanFiveHundredMilliseconds,
    #[serde(rename = "500_1000ms")]
    FiveHundredToOneThousandMilliseconds,
    #[serde(rename = "1_2s")]
    OneToTwoSeconds,
    #[serde(rename = "2_5s")]
    TwoToFiveSeconds,
    #[serde(rename = "gte_5s")]
    FiveSecondsOrMore,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "event",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RecordAnalyticsMilestone {
    RecordCreate {
        event_schema_version: u8,
        record_id: String,
        record_kind: AnalyticsRecordKind,
        source: AnalyticsSource,
        surface: AnalyticsSurface,
    },
    RecordingStartResult {
        event_schema_version: u8,
        record_id: Option<String>,
        ok: bool,
        capture_sources: CaptureSources,
        transcription_mode: TranscriptionMode,
        resource_state: SpeechResourceState,
        system_audio_capability: SystemAudioCapability,
        error_code: Option<String>,
    },
    RecordingFinish {
        event_schema_version: u8,
        record_id: String,
        outcome: AnalyticsOutcome,
        finish_reason: RecordingFinishReason,
        media_duration_bucket: MediaDurationBucket,
        pause_count_bucket: SmallCountBucket,
        note_count_bucket: SmallCountBucket,
        mark_count_bucket: SmallCountBucket,
        audio_bytes_bucket: MediaBytesBucket,
        live_transcript_coverage: TranscriptCoverageBucket,
        segment_latency_p50_bucket: Option<SegmentLatencyBucket>,
        segment_latency_p95_bucket: Option<SegmentLatencyBucket>,
    },
    RecordingRecovery {
        event_schema_version: u8,
        record_id: String,
        outcome: RecordingRecoveryOutcome,
        error_code: Option<String>,
    },
    SpeechProcessingFinish {
        event_schema_version: u8,
        record_id: String,
        stage: SpeechProcessingStage,
        outcome: AnalyticsOutcome,
        provider: String,
        model_revision: String,
        duration_ms: u64,
        media_duration_bucket: MediaDurationBucket,
        segment_count_bucket: SegmentCountBucket,
        speaker_count_bucket: SpeakerCountBucket,
        error_code: Option<String>,
    },
    RecordUse {
        event_schema_version: u8,
        record_id: String,
        record_kind: AnalyticsRecordKind,
        operation: RecordUseOperation,
        source: AnalyticsSource,
        surface: AnalyticsSurface,
    },
    SpeechResourceMutation {
        event_schema_version: u8,
        operation: SpeechResourceOperation,
        outcome: AnalyticsOutcome,
        pack_revision: String,
        resource_bytes: u64,
        duration_ms: u64,
        error_code: Option<String>,
    },
    SpeechAttachmentJob {
        event_schema_version: u8,
        job_id: Option<String>,
        operation: SpeechAttachmentOperation,
        source: AnalyticsSource,
        media_kind: AnalyticsMediaKind,
        outcome: AnalyticsOutcome,
        file_bytes_bucket: Option<MediaBytesBucket>,
        media_duration_bucket: Option<MediaDurationBucket>,
        provider: Option<String>,
        model_revision: Option<String>,
        duration_ms: u64,
        error_code: Option<String>,
    },
}

impl RecordAnalyticsMilestone {
    fn is_recovery(&self) -> bool {
        matches!(self, Self::RecordingRecovery { .. })
    }
}

pub fn subscribe() -> broadcast::Receiver<RecordAnalyticsMilestone> {
    CHANNEL.subscribe()
}

pub fn emit(milestone: RecordAnalyticsMilestone) {
    let milestone = sanitize_milestone_error_code(milestone);
    let Ok(mut bridge) = BRIDGE_STATE.lock() else {
        return;
    };
    if !bridge.ready {
        if milestone.is_recovery() {
            if bridge.pending_recovery.len() == PRE_BRIDGE_RECOVERY_LIMIT {
                bridge.pending_recovery.pop_front();
            }
            bridge.pending_recovery.push_back(milestone);
        }
        return;
    }
    drop(bridge);
    let _ = CHANNEL.send(milestone);
}

fn sanitize_milestone_error_code(
    mut milestone: RecordAnalyticsMilestone,
) -> RecordAnalyticsMilestone {
    let error_code = match &mut milestone {
        RecordAnalyticsMilestone::RecordingStartResult { error_code, .. }
        | RecordAnalyticsMilestone::RecordingRecovery { error_code, .. }
        | RecordAnalyticsMilestone::SpeechProcessingFinish { error_code, .. }
        | RecordAnalyticsMilestone::SpeechResourceMutation { error_code, .. }
        | RecordAnalyticsMilestone::SpeechAttachmentJob { error_code, .. } => error_code,
        RecordAnalyticsMilestone::RecordCreate { .. }
        | RecordAnalyticsMilestone::RecordingFinish { .. }
        | RecordAnalyticsMilestone::RecordUse { .. } => return milestone,
    };
    if error_code
        .as_deref()
        .is_some_and(|code| !ANALYTICS_ERROR_CODES_V1.contains(&code))
    {
        *error_code = None;
    }
    milestone
}

pub fn emit_record_create(
    record: &crate::record::Record,
    source: AnalyticsSource,
    surface: AnalyticsSurface,
) {
    emit(RecordAnalyticsMilestone::RecordCreate {
        event_schema_version: 1,
        record_id: record.id.clone(),
        record_kind: record.kind.into(),
        source,
        surface,
    });
}

pub fn emit_record_use(
    record: &crate::record::Record,
    operation: RecordUseOperation,
    source: AnalyticsSource,
    surface: AnalyticsSurface,
) {
    emit(RecordAnalyticsMilestone::RecordUse {
        event_schema_version: 1,
        record_id: record.id.clone(),
        record_kind: record.kind.into(),
        operation,
        source,
        surface,
    });
}

#[tauri::command]
pub fn cmd_record_analytics_bridge_ready() {
    let pending = {
        let Ok(mut bridge) = BRIDGE_STATE.lock() else {
            return;
        };
        if bridge.ready {
            return;
        }
        bridge.ready = true;
        bridge.pending_recovery.drain(..).collect::<Vec<_>>()
    };
    for milestone in pending {
        let _ = CHANNEL.send(milestone);
    }
}

pub fn media_duration_bucket(duration_ms: u64) -> MediaDurationBucket {
    match duration_ms {
        0..60_000 => MediaDurationBucket::LessThanOneMinute,
        60_000..300_000 => MediaDurationBucket::OneToFiveMinutes,
        300_000..900_000 => MediaDurationBucket::FiveToFifteenMinutes,
        900_000..1_800_000 => MediaDurationBucket::FifteenToThirtyMinutes,
        1_800_000..3_600_000 => MediaDurationBucket::ThirtyToSixtyMinutes,
        3_600_000..7_200_000 => MediaDurationBucket::OneToTwoHours,
        7_200_000..14_400_000 => MediaDurationBucket::TwoToFourHours,
        _ => MediaDurationBucket::FourToEightHours,
    }
}

pub fn small_count_bucket(count: usize) -> SmallCountBucket {
    match count {
        0 => SmallCountBucket::Zero,
        1 => SmallCountBucket::One,
        2..=5 => SmallCountBucket::TwoToFive,
        6..=20 => SmallCountBucket::SixToTwenty,
        _ => SmallCountBucket::MoreThanTwenty,
    }
}

pub fn segment_count_bucket(count: usize) -> SegmentCountBucket {
    match count {
        0 => SegmentCountBucket::Zero,
        1..=20 => SegmentCountBucket::OneToTwenty,
        21..=100 => SegmentCountBucket::TwentyOneToOneHundred,
        101..=500 => SegmentCountBucket::OneHundredOneToFiveHundred,
        _ => SegmentCountBucket::MoreThanFiveHundred,
    }
}

pub fn speaker_count_bucket(count: usize) -> SpeakerCountBucket {
    match count {
        0 => SpeakerCountBucket::Zero,
        1 => SpeakerCountBucket::One,
        2 => SpeakerCountBucket::Two,
        3..=4 => SpeakerCountBucket::ThreeToFour,
        _ => SpeakerCountBucket::FiveOrMore,
    }
}

pub fn media_bytes_bucket(bytes: u64) -> MediaBytesBucket {
    const MIB: u64 = 1024 * 1024;
    const GIB: u64 = 1024 * MIB;
    const TEN_MIB: u64 = 10 * MIB;
    const FIFTY_MIB: u64 = 50 * MIB;
    const TWO_HUNDRED_MIB: u64 = 200 * MIB;
    const FIVE_HUNDRED_MIB: u64 = 500 * MIB;
    const FOUR_GIB: u64 = 4 * GIB;
    match bytes {
        0..TEN_MIB => MediaBytesBucket::LessThanTenMegabytes,
        TEN_MIB..FIFTY_MIB => MediaBytesBucket::TenToFiftyMegabytes,
        FIFTY_MIB..TWO_HUNDRED_MIB => MediaBytesBucket::FiftyToTwoHundredMegabytes,
        TWO_HUNDRED_MIB..FIVE_HUNDRED_MIB => MediaBytesBucket::TwoHundredToFiveHundredMegabytes,
        FIVE_HUNDRED_MIB..GIB => MediaBytesBucket::FiveHundredMegabytesToOneGigabyte,
        GIB..FOUR_GIB => MediaBytesBucket::OneToFourGigabytes,
        _ => MediaBytesBucket::FourGigabytesOrMore,
    }
}

pub fn transcript_coverage_bucket(covered_ms: u64, media_ms: u64) -> TranscriptCoverageBucket {
    if covered_ms == 0 || media_ms == 0 {
        return TranscriptCoverageBucket::None;
    }
    let percent = covered_ms.saturating_mul(100) / media_ms;
    match percent {
        0..50 => TranscriptCoverageBucket::LessThanFiftyPercent,
        50..90 => TranscriptCoverageBucket::FiftyToNinetyPercent,
        90..100 => TranscriptCoverageBucket::NinetyToNinetyNinePercent,
        _ => TranscriptCoverageBucket::Complete,
    }
}

pub fn segment_latency_bucket(latency_ms: u64) -> SegmentLatencyBucket {
    match latency_ms {
        0..500 => SegmentLatencyBucket::LessThanFiveHundredMilliseconds,
        500..1_000 => SegmentLatencyBucket::FiveHundredToOneThousandMilliseconds,
        1_000..2_000 => SegmentLatencyBucket::OneToTwoSeconds,
        2_000..5_000 => SegmentLatencyBucket::TwoToFiveSeconds,
        _ => SegmentLatencyBucket::FiveSecondsOrMore,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_bucket_boundaries_match_the_product_contract() {
        assert_eq!(
            media_duration_bucket(59_999),
            MediaDurationBucket::LessThanOneMinute
        );
        assert_eq!(
            media_duration_bucket(60_000),
            MediaDurationBucket::OneToFiveMinutes
        );
        assert_eq!(small_count_bucket(21), SmallCountBucket::MoreThanTwenty);
        assert_eq!(
            segment_count_bucket(501),
            SegmentCountBucket::MoreThanFiveHundred
        );
        assert_eq!(speaker_count_bucket(5), SpeakerCountBucket::FiveOrMore);
        assert_eq!(
            media_bytes_bucket(4 * 1024 * 1024 * 1024),
            MediaBytesBucket::FourGigabytesOrMore
        );
        assert_eq!(
            transcript_coverage_bucket(99, 100),
            TranscriptCoverageBucket::NinetyToNinetyNinePercent
        );
        assert_eq!(
            transcript_coverage_bucket(100, 100),
            TranscriptCoverageBucket::Complete
        );
        assert_eq!(
            segment_latency_bucket(5_000),
            SegmentLatencyBucket::FiveSecondsOrMore
        );
    }

    #[test]
    fn serialization_uses_the_stable_event_and_dimension_names() {
        assert_eq!(ANALYTICS_SOURCES_V1.len(), 6);
        assert_eq!(RECORD_USE_OPERATIONS_V1.len(), 9);
        let value = serde_json::to_value(RecordAnalyticsMilestone::RecordUse {
            event_schema_version: 1,
            record_id: "record-private".into(),
            record_kind: AnalyticsRecordKind::Audio,
            operation: RecordUseOperation::SpeakerReassign,
            source: AnalyticsSource::Desktop,
            surface: AnalyticsSurface::RecordDetail,
        })
        .unwrap();
        assert_eq!(value["event"], "record_use");
        assert_eq!(value["eventSchemaVersion"], 1);
        assert_eq!(value["recordKind"], "audio");
        assert_eq!(value["operation"], "speaker_reassign");
        assert_eq!(value["surface"], "record_detail");

        let rejected = serde_json::to_value(RecordAnalyticsMilestone::SpeechAttachmentJob {
            event_schema_version: 1,
            job_id: None,
            operation: SpeechAttachmentOperation::Submit,
            source: AnalyticsSource::CliAgent,
            media_kind: AnalyticsMediaKind::Unknown,
            outcome: AnalyticsOutcome::Rejected,
            file_bytes_bucket: None,
            media_duration_bucket: None,
            provider: Some("local".into()),
            model_revision: None,
            duration_ms: 4,
            error_code: Some("SPEECH_QUEUE_FULL".into()),
        })
        .unwrap();
        assert_eq!(rejected["outcome"], "rejected");
        assert!(rejected["jobId"].is_null());
        assert!(rejected["fileBytesBucket"].is_null());
    }

    #[test]
    fn unknown_error_codes_are_removed_before_bridge_delivery() {
        let milestone =
            sanitize_milestone_error_code(RecordAnalyticsMilestone::RecordingStartResult {
                event_schema_version: 1,
                record_id: None,
                ok: false,
                capture_sources: CaptureSources::Microphone,
                transcription_mode: TranscriptionMode::Unavailable,
                resource_state: SpeechResourceState::NotInstalled,
                system_audio_capability: SystemAudioCapability::NotRequested,
                error_code: Some("/Users/private/raw failure".into()),
            });
        let value = serde_json::to_value(milestone).unwrap();
        assert!(value["errorCode"].is_null());
    }
}
