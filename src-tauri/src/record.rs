//! App-owned authority for durable text and audio Records.
//!
//! The legacy Thought directory is read only by the startup migration adapter.
//! Every business mutation, including legacy Thought compatibility commands,
//! commits through this store.

use chrono::{DateTime, Datelike, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write as FmtWrite;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock as StdRwLock};
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;
use zeroize::Zeroize;

use crate::durable_fs::{rename_directory_noreplace, sync_directory};
use crate::durable_journal::{
    read_valid_prefix, read_valid_suffix, recover_and_read, DurableRecordJournal,
};
use crate::record_analytics::{self, AnalyticsSource, AnalyticsSurface, RecordUseOperation};
use crate::utils::file_lock::{with_file_lock_blocking, FileLockError, FileLockOptions};
use crate::{ulog_info, ulog_warn};

const RECORD_SCHEMA_VERSION: u32 = 1;
const RECORD_MANIFEST_MAX_BYTES: u64 = 1024 * 1024;
const TEXT_CONTENT_MAX_BYTES: u64 = 16 * 1024 * 1024;
const AUDIO_DISCUSSION_DOCUMENT_MAX_BYTES: u64 = 32 * 1024 * 1024;
const AUDIO_DISCUSSION_DOCUMENT_PATH: &str = "content.md";
const AUDIO_DISCUSSION_DOCUMENT_KIND: &str = "record/discussion-document+markdown";
const TEXT_ATTACHMENT_MAX_BYTES: u64 = 16 * 1024 * 1024;
const LEGACY_THOUGHT_MAX_BYTES: u64 = 16 * 1024 * 1024;
const TRANSCRIPT_SNAPSHOT_MAX_BYTES: u64 = 64 * 1024 * 1024;
const TRANSCRIPT_SEGMENT_LIMIT: usize = 100_000;
const TRANSCRIPT_CHARACTER_LIMIT: usize = 5_000_000;
const TRANSCRIPT_REVISION_SCHEMA_VERSION: u32 = 1;
const TRANSCRIPT_REVISION_MAX_LINE_BYTES: usize = 256 * 1024;
const TRANSCRIPT_REVISION_MAX_BYTES: u64 = 128 * 1024 * 1024;
const LIVE_TRANSCRIPT_MAX_SAMPLES: u64 = SPEECH_SAMPLE_RATE * 60 * 60 * 8;
const DIARIZATION_TURN_LIMIT: usize = 200_000;
const DIARIZATION_OVERRIDES_MAX_BYTES: u64 = 4 * 1024 * 1024;
const SPEAKER_DISPLAY_NAME_MAX_BYTES: usize = 256;
const SPEECH_SAMPLE_RATE: u64 = 16_000;
const TIMELINE_SCHEMA_VERSION: u32 = 1;
const TIMELINE_MAX_LINE_BYTES: usize = 128 * 1024;
const TIMELINE_MAX_BYTES: u64 = 64 * 1024 * 1024;
const TIMELINE_ITEM_LIMIT: usize = 100_000;
const TIMELINE_TEXT_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RecordKind {
    Text,
    Audio,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureStatus {
    None,
    Preparing,
    Recording,
    Paused,
    Stopping,
    Finalizing,
    Ready,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TranscriptionStatus {
    NotApplicable,
    Unavailable,
    NotStarted,
    Queued,
    Live,
    Lagging,
    Recovering,
    Finalizing,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DiarizationStatus {
    NotApplicable,
    Queued,
    Running,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AudioTrackKind {
    Microphone,
    System,
    Mixed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AudioRecordSummary {
    pub media_duration_ms: u64,
    pub capture_status: CaptureStatus,
    pub transcription_status: TranscriptionStatus,
    pub diarization_status: DiarizationStatus,
    pub tracks: Vec<AudioTrackKind>,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordArtifact {
    pub kind: String,
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub kind: RecordKind,
    pub title: String,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived: bool,
    pub converted_task_ids: Vec<String>,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioRecordSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifacts: Vec<RecordArtifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordSummary {
    pub id: String,
    pub kind: RecordKind,
    pub title: String,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub archived: bool,
    pub converted_task_ids: Vec<String>,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioRecordSummary>,
}

impl From<&Record> for RecordSummary {
    fn from(record: &Record) -> Self {
        Self {
            id: record.id.clone(),
            kind: record.kind,
            title: record.title.clone(),
            tags: record.tags.clone(),
            created_at: record.created_at,
            updated_at: record.updated_at,
            archived: record.archived,
            converted_task_ids: record.converted_task_ids.clone(),
            revision: record.revision,
            audio: record.audio.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordManifest {
    schema_version: u32,
    id: String,
    kind: RecordKind,
    title: String,
    tags: Vec<String>,
    created_at: i64,
    updated_at: i64,
    archived: bool,
    converted_task_ids: Vec<String>,
    revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    audio: Option<AudioRecordSummary>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    images: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    artifacts: Vec<RecordArtifact>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    content_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    legacy_thought_digest: Option<String>,
}

impl RecordManifest {
    fn from_record(record: &Record, legacy_thought_digest: Option<String>) -> Self {
        Self {
            schema_version: RECORD_SCHEMA_VERSION,
            id: record.id.clone(),
            kind: record.kind,
            title: record.title.clone(),
            tags: record.tags.clone(),
            created_at: record.created_at,
            updated_at: record.updated_at,
            archived: record.archived,
            converted_task_ids: record.converted_task_ids.clone(),
            revision: record.revision,
            audio: record.audio.clone(),
            images: record.images.clone(),
            artifacts: record.artifacts.clone(),
            content_sha256: record.content.as_deref().map(sha256_text),
            legacy_thought_digest,
        }
    }

    fn into_record(self, content: Option<String>) -> Record {
        Record {
            id: self.id,
            kind: self.kind,
            title: self.title,
            tags: self.tags,
            created_at: self.created_at,
            updated_at: self.updated_at,
            archived: self.archived,
            converted_task_ids: self.converted_task_ids,
            revision: self.revision,
            audio: self.audio,
            content,
            images: self.images,
            artifacts: self.artifacts,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordArchiveFilter {
    Active,
    Archived,
    All,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordListFilter {
    pub kind: Option<RecordKind>,
    pub tag: Option<String>,
    pub query: Option<String>,
    pub limit: Option<usize>,
    pub archived: Option<RecordArchiveFilter>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRecordCreateInput {
    pub content: String,
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRecordUpdateInput {
    pub id: String,
    pub content: Option<String>,
    pub images: Option<Vec<String>>,
    pub converted_task_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRecordMetadataUpdateInput {
    pub id: String,
    pub expected_revision: u64,
    pub title: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordNoteCreateInput {
    pub record_id: String,
    pub operation_id: String,
    pub anchor_media_ms: u64,
    pub started_at_wall_time: i64,
    pub submitted_at_wall_time: i64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordMarkCreateInput {
    pub record_id: String,
    pub operation_id: String,
    pub media_ms: u64,
    pub wall_time: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordNoteUpdateInput {
    pub record_id: String,
    pub operation_id: String,
    pub note_id: String,
    pub updated_at_wall_time: i64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordTimelineDeleteInput {
    pub record_id: String,
    pub operation_id: String,
    pub item_id: String,
    pub item_type: String,
    pub deleted_at_wall_time: i64,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum RecordTimelineEvent {
    NoteCreated {
        operation_id: String,
        note_id: String,
        anchor_media_ms: u64,
        started_at_wall_time: i64,
        submitted_at_wall_time: i64,
        text: String,
    },
    MarkCreated {
        operation_id: String,
        mark_id: String,
        media_ms: u64,
        wall_time: i64,
        kind: String,
    },
    NoteUpdated {
        operation_id: String,
        note_id: String,
        updated_at_wall_time: i64,
        text: String,
    },
    NoteDeleted {
        operation_id: String,
        note_id: String,
        deleted_at_wall_time: i64,
    },
    MarkDeleted {
        operation_id: String,
        mark_id: String,
        deleted_at_wall_time: i64,
    },
}

impl RecordTimelineEvent {
    fn operation_id(&self) -> &str {
        match self {
            Self::NoteCreated { operation_id, .. }
            | Self::MarkCreated { operation_id, .. }
            | Self::NoteUpdated { operation_id, .. }
            | Self::NoteDeleted { operation_id, .. }
            | Self::MarkDeleted { operation_id, .. } => operation_id,
        }
    }
}

#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RecordTimelineItem {
    Note {
        seq: u64,
        note_id: String,
        anchor_media_ms: u64,
        started_at_wall_time: i64,
        submitted_at_wall_time: i64,
        text: String,
    },
    Mark {
        seq: u64,
        mark_id: String,
        media_ms: u64,
        wall_time: i64,
        kind: String,
    },
}

#[derive(Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordTimelineProjection {
    pub record_id: String,
    pub revision: u64,
    pub items: Vec<RecordTimelineItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordDeleteFailure {
    pub id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordMergeResult {
    pub merged: Record,
    pub failed_source_deletes: Vec<RecordDeleteFailure>,
}

#[derive(Debug, Clone)]
pub struct AudioRecordCreateInput {
    pub title: String,
    pub tracks: Vec<AudioTrackKind>,
    pub transcription_status: TranscriptionStatus,
}

#[derive(Debug, Clone)]
pub struct AudioTrackArtifactInput {
    pub track: AudioTrackKind,
    pub relative_path: String,
}

#[derive(Debug, Clone)]
pub struct ResolvedRecordMedia {
    pub record_id: String,
    pub revision: u64,
    pub track: AudioTrackKind,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub sha256: String,
    pub mime_type: &'static str,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordTranscriptSegment {
    pub segment_id: String,
    pub track: AudioTrackKind,
    pub start_sample: u64,
    pub end_sample: u64,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RecordSegmentFinalization {
    pub wall_time_ms: i64,
    pub media_ms: u64,
}

impl std::fmt::Debug for RecordTranscriptSegment {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RecordTranscriptSegment")
            .field("segment_id", &self.segment_id)
            .field("track", &self.track)
            .field("start_sample", &self.start_sample)
            .field("end_sample", &self.end_sample)
            .field("text", &"[REDACTED]")
            .field("language", &self.language.as_ref().map(|_| "[REDACTED]"))
            .field("revision", &self.revision)
            .finish()
    }
}

impl RecordTranscriptSegment {
    pub(crate) fn zeroize_sensitive(&mut self) {
        self.text.zeroize();
        if let Some(language) = &mut self.language {
            language.zeroize();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordTranscriptTrackOffset {
    pub track: AudioTrackKind,
    pub sample: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum RecordTranscriptRevisionEvent {
    SessionStarted {
        provenance: RecordSpeechProvenance,
        tracks: Vec<AudioTrackKind>,
    },
    GenerationStarted {
        generation: u64,
        replay_from: Vec<RecordTranscriptTrackOffset>,
    },
    SegmentUpsert {
        segment: RecordTranscriptSegment,
    },
    GenerationFailed {
        generation: u64,
        error_code: String,
    },
    SessionFailed {
        error_code: String,
    },
    SessionFinished,
}

pub(crate) struct RecordLiveTranscriptJournal {
    inner: DurableRecordJournal<RecordTranscriptRevisionEvent>,
    path: PathBuf,
    allowed_tracks: Vec<AudioTrackKind>,
    segments: HashMap<String, RecordTranscriptSegment>,
    characters: usize,
    terminal: bool,
}

impl RecordLiveTranscriptJournal {
    fn create(
        record_path: &Path,
        record: &Record,
        provenance: RecordSpeechProvenance,
    ) -> Result<Self, String> {
        validate_speech_provenance(&provenance)?;
        let audio = record
            .audio
            .as_ref()
            .filter(|_| record.kind == RecordKind::Audio)
            .ok_or_else(|| "live transcript requires an audio Record".to_string())?;
        if !matches!(
            audio.capture_status,
            CaptureStatus::Preparing | CaptureStatus::Recording | CaptureStatus::Paused
        ) {
            return Err("live transcript admission requires active capture".to_string());
        }
        let allowed_tracks = audio
            .tracks
            .iter()
            .copied()
            .filter(|track| *track != AudioTrackKind::Mixed)
            .collect::<Vec<_>>();
        if allowed_tracks.is_empty() {
            return Err("live transcript has no physical source track".to_string());
        }
        let path = record_path.join("transcript/revisions.jsonl");
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err("live transcript revision target is not a regular file".to_string())
            }
            Ok(metadata) if metadata.len() > 0 => {
                return Err("live transcript revision journal already exists".to_string())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("inspect live transcript journal: {error}")),
        }
        let mut inner = DurableRecordJournal::open(
            path.clone(),
            &record.id,
            TRANSCRIPT_REVISION_SCHEMA_VERSION,
            TRANSCRIPT_REVISION_MAX_LINE_BYTES,
        )?;
        inner.append(
            now_ms(),
            0,
            RecordTranscriptRevisionEvent::SessionStarted {
                provenance: provenance.clone(),
                tracks: allowed_tracks.clone(),
            },
        )?;
        Ok(Self {
            inner,
            path,
            allowed_tracks,
            segments: HashMap::new(),
            characters: 0,
            terminal: false,
        })
    }

    pub(crate) fn replay_offsets(&self) -> Vec<RecordTranscriptTrackOffset> {
        self.allowed_tracks
            .iter()
            .copied()
            .map(|track| RecordTranscriptTrackOffset {
                track,
                sample: self
                    .segments
                    .values()
                    .filter(|segment| segment.track == track)
                    .map(|segment| segment.end_sample)
                    .max()
                    .unwrap_or(0),
            })
            .collect()
    }

    pub(crate) fn append_generation_started(
        &mut self,
        generation: u64,
        replay_from: Vec<RecordTranscriptTrackOffset>,
    ) -> Result<(), String> {
        if self.terminal || generation == 0 || !self.valid_offsets(&replay_from) {
            return Err("live transcript generation metadata is invalid".to_string());
        }
        self.ensure_append_budget()?;
        self.inner.append(
            now_ms(),
            replay_from
                .iter()
                .map(|offset| offset.sample)
                .max()
                .unwrap_or(0)
                * 1_000
                / SPEECH_SAMPLE_RATE,
            RecordTranscriptRevisionEvent::GenerationStarted {
                generation,
                replay_from,
            },
        )?;
        Ok(())
    }

    pub(crate) fn append_segment(
        &mut self,
        track: AudioTrackKind,
        start_sample: u64,
        end_sample: u64,
        text: String,
        language: Option<String>,
    ) -> Result<Option<RecordTranscriptSegment>, String> {
        let mut sensitive = SensitiveLiveText { text, language };
        if self.terminal
            || !self.allowed_tracks.contains(&track)
            || start_sample >= end_sample
            || end_sample > LIVE_TRANSCRIPT_MAX_SAMPLES
            || sensitive.text.trim().is_empty()
            || sensitive.text.len() > 64 * 1024
            || sensitive.text.contains('\0')
            || sensitive.language.as_deref().is_some_and(|language| {
                language.is_empty()
                    || language.len() > 32
                    || !language
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            })
        {
            return Err("live transcript segment is invalid".to_string());
        }
        let segment_id = live_segment_id(track, start_sample, end_sample);
        if let Some(existing) = self.segments.get(&segment_id) {
            if existing.text == sensitive.text && existing.language == sensitive.language {
                return Ok(None);
            }
        }
        let old_characters = self
            .segments
            .get(&segment_id)
            .map_or(0, |segment| segment.text.chars().count());
        let new_characters = sensitive.text.chars().count();
        let characters = self
            .characters
            .checked_sub(old_characters)
            .and_then(|count| count.checked_add(new_characters))
            .filter(|count| *count <= TRANSCRIPT_CHARACTER_LIMIT)
            .ok_or_else(|| "live transcript character limit exceeded".to_string())?;
        if self.segments.len() >= TRANSCRIPT_SEGMENT_LIMIT
            && !self.segments.contains_key(&segment_id)
        {
            return Err("live transcript segment limit exceeded".to_string());
        }
        let revision = self
            .segments
            .get(&segment_id)
            .map_or(1, |segment| segment.revision.saturating_add(1).max(1));
        let segment = RecordTranscriptSegment {
            segment_id: segment_id.clone(),
            track,
            start_sample,
            end_sample,
            text: std::mem::take(&mut sensitive.text),
            language: sensitive.language.take(),
            revision,
        };
        self.ensure_append_budget()?;
        let entry = self.inner.append(
            now_ms(),
            end_sample.saturating_mul(1_000) / SPEECH_SAMPLE_RATE,
            RecordTranscriptRevisionEvent::SegmentUpsert { segment },
        )?;
        let RecordTranscriptRevisionEvent::SegmentUpsert { segment } = entry.event else {
            unreachable!("segment append returns its own event")
        };
        self.characters = characters;
        self.segments.insert(segment_id, segment.clone());
        Ok(Some(segment))
    }

    pub(crate) fn append_generation_failed(
        &mut self,
        generation: u64,
        error_code: &str,
    ) -> Result<(), String> {
        if self.terminal || generation == 0 || !valid_speech_error_code(error_code) {
            return Err("live transcript failure metadata is invalid".to_string());
        }
        self.ensure_append_budget()?;
        self.inner.append(
            now_ms(),
            self.replay_offsets()
                .iter()
                .map(|offset| offset.sample)
                .max()
                .unwrap_or(0)
                .saturating_mul(1_000)
                / SPEECH_SAMPLE_RATE,
            RecordTranscriptRevisionEvent::GenerationFailed {
                generation,
                error_code: error_code.to_string(),
            },
        )?;
        Ok(())
    }

    pub(crate) fn finish(&mut self) -> Result<(), String> {
        if self.terminal {
            return Ok(());
        }
        self.ensure_append_budget()?;
        self.inner.append(
            now_ms(),
            self.replay_offsets()
                .iter()
                .map(|offset| offset.sample)
                .max()
                .unwrap_or(0)
                .saturating_mul(1_000)
                / SPEECH_SAMPLE_RATE,
            RecordTranscriptRevisionEvent::SessionFinished,
        )?;
        self.terminal = true;
        Ok(())
    }

    pub(crate) fn fail(&mut self, error_code: &str) -> Result<(), String> {
        if self.terminal {
            return Ok(());
        }
        if !valid_speech_error_code(error_code) {
            return Err("live transcript terminal failure is invalid".to_string());
        }
        self.ensure_append_budget()?;
        self.inner.append(
            now_ms(),
            self.replay_offsets()
                .iter()
                .map(|offset| offset.sample)
                .max()
                .unwrap_or(0)
                .saturating_mul(1_000)
                / SPEECH_SAMPLE_RATE,
            RecordTranscriptRevisionEvent::SessionFailed {
                error_code: error_code.to_string(),
            },
        )?;
        self.terminal = true;
        Ok(())
    }

    fn valid_offsets(&self, offsets: &[RecordTranscriptTrackOffset]) -> bool {
        offsets.len() == self.allowed_tracks.len()
            && self.allowed_tracks.iter().all(|track| {
                offsets.iter().any(|offset| {
                    offset.track == *track && offset.sample <= LIVE_TRANSCRIPT_MAX_SAMPLES
                })
            })
            && offsets
                .windows(2)
                .all(|pair| pair[0].track != pair[1].track)
    }

    fn ensure_append_budget(&self) -> Result<(), String> {
        let size = fs::symlink_metadata(&self.path)
            .map_err(|error| format!("inspect live transcript journal: {error}"))?
            .len();
        if size
            > TRANSCRIPT_REVISION_MAX_BYTES
                .saturating_sub(TRANSCRIPT_REVISION_MAX_LINE_BYTES as u64)
        {
            return Err("live transcript revision journal exceeds size limit".to_string());
        }
        Ok(())
    }
}

struct SensitiveLiveText {
    text: String,
    language: Option<String>,
}

impl Drop for SensitiveLiveText {
    fn drop(&mut self) {
        self.text.zeroize();
        if let Some(language) = &mut self.language {
            language.zeroize();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordSpeechProvenance {
    pub provider: String,
    pub model_pack_revision: String,
    pub onnx_runtime_version: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordTranscriptSnapshot {
    pub schema_version: u32,
    pub record_id: String,
    pub projection_revision: u64,
    pub state: String,
    pub sample_rate: u32,
    pub provenance: RecordSpeechProvenance,
    pub segments: Vec<RecordTranscriptSegment>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordTranscriptCursor {
    pub journal_bytes: u64,
    pub projection_revision: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordTranscriptDelta {
    pub record_id: String,
    pub projection_revision: u64,
    pub state: String,
    pub upserts: Vec<RecordTranscriptSegment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_snapshot: Option<RecordTranscriptSnapshot>,
    pub cursor: RecordTranscriptCursor,
}

impl std::fmt::Debug for RecordTranscriptSnapshot {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RecordTranscriptSnapshot")
            .field("schema_version", &self.schema_version)
            .field("record_id", &self.record_id)
            .field("projection_revision", &self.projection_revision)
            .field("state", &self.state)
            .field("sample_rate", &self.sample_rate)
            .field("provenance", &self.provenance)
            .field("segment_count", &self.segments.len())
            .finish()
    }
}

impl Drop for RecordTranscriptSnapshot {
    fn drop(&mut self) {
        for segment in &mut self.segments {
            segment.zeroize_sensitive();
        }
    }
}

struct SensitiveTranscriptInput(Vec<RecordTranscriptSegment>);

impl Drop for SensitiveTranscriptInput {
    fn drop(&mut self) {
        for segment in &mut self.0 {
            segment.zeroize_sensitive();
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordSpeakerTurn {
    pub start_sample: u64,
    pub end_sample: u64,
    pub global_speaker: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordDiarizationResult {
    pub schema_version: u32,
    pub record_id: String,
    pub projection_revision: u64,
    pub sample_rate: u32,
    pub provenance: RecordSpeechProvenance,
    pub turns: Vec<RecordSpeakerTurn>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordSpeakerProjection {
    pub speaker_id: u32,
    pub custom_name: Option<String>,
    pub merged_into: Option<u32>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordSpeakerOverrideConflict {
    pub kind: String,
    pub target_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordDiarizationProjection {
    pub schema_version: u32,
    pub record_id: String,
    pub projection_revision: u64,
    pub sample_rate: u32,
    pub provenance: RecordSpeechProvenance,
    pub turns: Vec<RecordSpeakerTurn>,
    pub override_revision: u64,
    pub speakers: Vec<RecordSpeakerProjection>,
    pub segment_speaker_overrides: BTreeMap<String, u32>,
    pub conflicts: Vec<RecordSpeakerOverrideConflict>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordSpeakerOverrides {
    schema_version: u32,
    record_id: String,
    revision: u64,
    updated_at_wall_time: i64,
    renames: BTreeMap<u32, String>,
    merges: BTreeMap<u32, u32>,
    reassignments: BTreeMap<String, u32>,
}

impl RecordSpeakerOverrides {
    fn empty(record_id: &str) -> Self {
        Self {
            schema_version: 1,
            record_id: record_id.to_string(),
            revision: 0,
            updated_at_wall_time: 0,
            renames: BTreeMap::new(),
            merges: BTreeMap::new(),
            reassignments: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordSpeakerRenameInput {
    pub record_id: String,
    pub expected_override_revision: u64,
    pub speaker_id: u32,
    pub name: String,
    pub updated_at_wall_time: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordSpeakerMergeInput {
    pub record_id: String,
    pub expected_override_revision: u64,
    pub source_speaker_id: u32,
    pub target_speaker_id: u32,
    pub updated_at_wall_time: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordSegmentSpeakerReassignInput {
    pub record_id: String,
    pub expected_override_revision: u64,
    pub segment_id: String,
    pub speaker_id: u32,
    pub updated_at_wall_time: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordAudioExportInput {
    pub record_id: String,
    pub track: AudioTrackKind,
    pub destination_path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordDiscussionAudioSource {
    pub track: AudioTrackKind,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordDiscussionContext {
    pub document_path: String,
    pub audio_sources: Vec<RecordDiscussionAudioSource>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RecordTextExportFormat {
    Markdown,
    Text,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordTextExportInput {
    pub record_id: String,
    pub format: RecordTextExportFormat,
    pub destination_path: String,
    pub locale: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordExportResult {
    pub destination_path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordSearchDocument {
    pub record_id: String,
    pub kind: RecordKind,
    pub title: String,
    pub tags: Vec<String>,
    pub content: String,
    pub media_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct StoredRecord {
    record: Record,
    path: PathBuf,
    legacy_thought_digest: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecordChangeKind {
    Upsert,
    Delete,
    Transcript,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordChange {
    pub sequence: u64,
    pub id: String,
    pub kind: RecordChangeKind,
}

pub struct RecordStore {
    inner: Arc<RwLock<HashMap<String, StoredRecord>>>,
    root: PathBuf,
    published_ids: StdRwLock<HashSet<String>>,
    changes: broadcast::Sender<RecordChange>,
    change_sequence: AtomicU64,
}

impl RecordStore {
    pub fn new(root: PathBuf, legacy_thought_root: Option<PathBuf>) -> Self {
        if let Err(error) = ensure_or_create_plain_directory(&root) {
            ulog_warn!("[record] failed to prepare root: {}", error);
        }
        if let Some(legacy_root) = legacy_thought_root.as_deref() {
            migrate_legacy_thoughts(&root, legacy_root);
        }
        let initial = scan_records(&root);
        let published_ids = initial.keys().cloned().collect();
        let (changes, _) = broadcast::channel(256);
        ulog_info!("[record] loaded {} record(s) from disk", initial.len());
        Self {
            inner: Arc::new(RwLock::new(initial)),
            root,
            published_ids: StdRwLock::new(published_ids),
            changes,
            change_sequence: AtomicU64::new(0),
        }
    }

    pub fn root_dir(&self) -> &Path {
        &self.root
    }

    pub fn subscribe_changes(&self) -> broadcast::Receiver<RecordChange> {
        self.changes.subscribe()
    }

    pub fn has_published_record(&self, id: &str) -> bool {
        match self.published_ids.read() {
            Ok(ids) => ids.contains(id),
            Err(poisoned) => poisoned.into_inner().contains(id),
        }
    }

    fn set_published_record(&self, id: &str, published: bool) {
        let mut ids = match self.published_ids.write() {
            Ok(ids) => ids,
            Err(poisoned) => poisoned.into_inner(),
        };
        if published {
            ids.insert(id.to_string());
        } else {
            ids.remove(id);
        }
    }

    fn emit_change(&self, id: &str, kind: RecordChangeKind) {
        let sequence = self.change_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self.changes.send(RecordChange {
            sequence,
            id: id.to_string(),
            kind,
        });
    }

    pub(crate) fn notify_live_transcript_changed(&self, id: &str) {
        self.emit_change(id, RecordChangeKind::Transcript);
    }

    pub async fn create_text(&self, input: TextRecordCreateInput) -> Result<Record, String> {
        if input.content.trim().is_empty() {
            return Err("record content must not be empty".to_string());
        }
        if !input.images.is_empty() {
            return Err(
                "text Record images must be imported through the attachment owner".to_string(),
            );
        }
        let now = now_ms();
        let record = Record {
            id: Uuid::new_v4().to_string(),
            kind: RecordKind::Text,
            title: derive_text_title(&input.content),
            tags: parse_tags(&input.content),
            created_at: now,
            updated_at: now,
            archived: false,
            converted_task_ids: Vec::new(),
            revision: 1,
            audio: None,
            content: Some(input.content),
            images: input.images,
            artifacts: Vec::new(),
        };
        self.publish_and_insert(record, None, |_| Ok(())).await
    }

    pub async fn create_audio(&self, input: AudioRecordCreateInput) -> Result<Record, String> {
        if input.title.trim().is_empty() {
            return Err("audio Record title must not be empty".to_string());
        }
        let now = now_ms();
        let record = Record {
            id: Uuid::new_v4().to_string(),
            kind: RecordKind::Audio,
            title: input.title,
            tags: Vec::new(),
            created_at: now,
            updated_at: now,
            archived: false,
            converted_task_ids: Vec::new(),
            revision: 1,
            audio: Some(AudioRecordSummary {
                media_duration_ms: 0,
                capture_status: CaptureStatus::Preparing,
                transcription_status: input.transcription_status,
                diarization_status: DiarizationStatus::NotApplicable,
                tracks: dedup_audio_tracks(input.tracks),
                size_bytes: 0,
            }),
            content: None,
            images: Vec::new(),
            artifacts: Vec::new(),
        };
        self.publish_and_insert(record, None, |staging| {
            for directory in ["audio", "analysis", "transcript", "diarization"] {
                let path = staging.join(directory);
                fs::create_dir(&path)
                    .map_err(|error| format!("create audio Record directory: {error}"))?;
            }
            write_new_synced_file(&staging.join("lifecycle.jsonl"), b"")?;
            write_new_synced_file(&staging.join("timeline.jsonl"), b"")
        })
        .await
    }

    pub(crate) async fn audio_workspace_path(&self, id: &str) -> Result<PathBuf, String> {
        let inner = self.inner.read().await;
        let stored = inner
            .get(id)
            .ok_or_else(|| format!("Record not found: {id}"))?;
        if stored.record.kind != RecordKind::Audio {
            return Err(format!("Record is not audio: {id}"));
        }
        ensure_plain_directory(&stored.path)?;
        Ok(stored.path.clone())
    }

    pub async fn ensure_audio_discussion_document(&self, id: &str) -> Result<PathBuf, String> {
        let mut inner = self.inner.write().await;
        let stored = inner
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {id}"))?;
        ensure_audio_record(&stored, id)?;
        if !audio_discussion_document_allowed(&stored.record)
            || !audio_discussion_audio_present(&stored.path, &stored.record)
        {
            return Err("RECORD_DISCUSSION_DOCUMENT_NOT_READY".to_string());
        }

        // Live transcript revisions do not independently bump the Record
        // revision, so admission re-renders instead of trusting only the
        // cached artifact revision between stop and final backfill.
        let document_record = rebuild_audio_discussion_document(&stored, stored.record.clone())
            .map_err(|error| {
                ulog_warn!(
                    "[record] discussion document rebuild failed recordId={} error={}",
                    id,
                    error
                );
                format!("RECORD_DISCUSSION_DOCUMENT_FAILED: {error}")
            })?;
        if document_record.artifacts != stored.record.artifacts {
            inner.insert(
                id.to_string(),
                StoredRecord {
                    record: document_record,
                    ..stored.clone()
                },
            );
        }

        let record_root = fs::canonicalize(&stored.path)
            .map_err(|error| format!("resolve Record directory: {error}"))?;
        let document_path = fs::canonicalize(stored.path.join(AUDIO_DISCUSSION_DOCUMENT_PATH))
            .map_err(|error| format!("resolve Record discussion document: {error}"))?;
        if document_path.parent() != Some(record_root.as_path()) {
            return Err("Record discussion document escaped its Record directory".to_string());
        }
        Ok(document_path)
    }

    pub async fn ensure_audio_discussion_context(
        &self,
        id: &str,
    ) -> Result<RecordDiscussionContext, String> {
        let document_path = self.ensure_audio_discussion_document(id).await?;
        let record = self
            .get(id)
            .await
            .ok_or_else(|| format!("Record not found: {id}"))?;
        let tracks = record
            .audio
            .as_ref()
            .ok_or_else(|| format!("Record is not audio: {id}"))?
            .tracks
            .clone();
        let mut audio_sources = Vec::with_capacity(tracks.len());
        for track in tracks {
            if let Ok(media) = self.resolve_record_media(id, track).await {
                let path = media
                    .path
                    .into_os_string()
                    .into_string()
                    .map_err(|_| "RECORD_DISCUSSION_AUDIO_PATH_INVALID".to_string())?;
                audio_sources.push(RecordDiscussionAudioSource { track, path });
            }
        }
        if audio_sources.is_empty() {
            return Err("RECORD_DISCUSSION_DOCUMENT_NOT_READY".to_string());
        }
        let document_path = document_path.into_os_string().into_string().map_err(|_| {
            "RECORD_DISCUSSION_DOCUMENT_FAILED: path is not valid UTF-8".to_string()
        })?;
        Ok(RecordDiscussionContext {
            document_path,
            audio_sources,
        })
    }

    pub(crate) async fn update_audio_capture(
        &self,
        id: &str,
        capture_status: CaptureStatus,
        media_duration_ms: u64,
        tracks: Option<Vec<AudioTrackKind>>,
    ) -> Result<Record, String> {
        let mut inner = self.inner.write().await;
        let stored = inner
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {id}"))?;
        if stored.record.kind != RecordKind::Audio {
            return Err(format!("Record is not audio: {id}"));
        }
        let mut updated = stored.record;
        let audio = updated
            .audio
            .as_mut()
            .ok_or_else(|| format!("audio Record summary missing: {id}"))?;
        audio.capture_status = capture_status;
        audio.media_duration_ms = media_duration_ms;
        if let Some(tracks) = tracks {
            audio.tracks = dedup_audio_tracks(tracks);
        }
        updated.updated_at = now_ms();
        updated.revision = updated.revision.saturating_add(1);
        persist_existing_record(
            &stored.path,
            &updated,
            stored.legacy_thought_digest.clone(),
            false,
        )?;
        inner.insert(
            id.to_string(),
            StoredRecord {
                record: updated.clone(),
                ..stored
            },
        );
        self.emit_change(id, RecordChangeKind::Upsert);
        Ok(updated)
    }

    pub(crate) async fn finalize_audio_capture(
        &self,
        id: &str,
        capture_status: CaptureStatus,
        media_duration_ms: u64,
        track_artifacts: Vec<AudioTrackArtifactInput>,
    ) -> Result<Record, String> {
        let mut inner = self.inner.write().await;
        let stored = inner
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {id}"))?;
        if stored.record.kind != RecordKind::Audio {
            return Err(format!("Record is not audio: {id}"));
        }

        let mut inventory = Vec::with_capacity(track_artifacts.len());
        let mut actual_tracks = Vec::with_capacity(track_artifacts.len());
        for artifact in track_artifacts {
            let expected = audio_track_relative_path(artifact.track);
            if artifact.relative_path != expected {
                return Err(format!(
                    "audio track path does not match {:?}: {}",
                    artifact.track, artifact.relative_path
                ));
            }
            let relative = validate_record_relative_path(&artifact.relative_path)?;
            let source = resolve_plain_record_artifact(&stored.path, &relative)?;
            inventory.push(record_artifact_from_file(
                &source,
                &relative,
                "audio/ogg-opus",
            )?);
            actual_tracks.push(artifact.track);
        }
        let size_bytes = inventory
            .iter()
            .try_fold(0_u64, |total, artifact| {
                total.checked_add(artifact.size_bytes)
            })
            .ok_or_else(|| "audio artifact size overflow".to_string())?;

        let mut updated = stored.record.clone();
        updated
            .artifacts
            .retain(|artifact| artifact.kind != "audio/ogg-opus");
        updated.artifacts.extend(inventory);
        let audio = updated
            .audio
            .as_mut()
            .ok_or_else(|| format!("audio Record summary missing: {id}"))?;
        audio.capture_status = capture_status;
        audio.media_duration_ms = media_duration_ms;
        audio.tracks = dedup_audio_tracks(actual_tracks);
        audio.size_bytes = size_bytes;
        updated.updated_at = now_ms();
        updated.revision = updated.revision.saturating_add(1);
        persist_existing_record(
            &stored.path,
            &updated,
            stored.legacy_thought_digest.clone(),
            false,
        )?;
        updated = refresh_audio_discussion_document_best_effort(&stored, updated);
        inner.insert(
            id.to_string(),
            StoredRecord {
                record: updated.clone(),
                ..stored
            },
        );
        self.emit_change(id, RecordChangeKind::Upsert);
        Ok(updated)
    }

    pub async fn resolve_record_media(
        &self,
        id: &str,
        track: AudioTrackKind,
    ) -> Result<ResolvedRecordMedia, String> {
        let inner = self.inner.read().await;
        let stored = inner
            .get(id)
            .ok_or_else(|| format!("Record not found: {id}"))?;
        if stored.record.kind != RecordKind::Audio {
            return Err(format!("Record is not audio: {id}"));
        }
        let expected_path = audio_track_relative_path(track);
        let artifact = stored
            .record
            .artifacts
            .iter()
            .find(|artifact| artifact.kind == "audio/ogg-opus" && artifact.path == expected_path)
            .ok_or_else(|| format!("Record media track not found: {id}/{expected_path}"))?;
        let relative = validate_record_relative_path(&artifact.path)?;
        let path = resolve_plain_record_artifact(&stored.path, &relative)?;
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("inspect Record media: {error}"))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() != artifact.size_bytes
        {
            return Err("Record media no longer matches its inventory".to_string());
        }
        Ok(ResolvedRecordMedia {
            record_id: id.to_string(),
            revision: stored.record.revision,
            track,
            path,
            size_bytes: artifact.size_bytes,
            sha256: artifact.sha256.clone(),
            mime_type: "audio/ogg; codecs=opus",
        })
    }

    /// Resolve a permanent audio track for an owned background processor.
    /// Playback range requests use the cheaper inventory/size check above;
    /// inference admission additionally re-hashes the complete immutable file
    /// once before a Worker generation is allowed to consume it.
    pub async fn resolve_record_media_for_processing(
        &self,
        id: &str,
        track: AudioTrackKind,
    ) -> Result<ResolvedRecordMedia, String> {
        let media = self.resolve_record_media(id, track).await?;
        let actual = sha256_regular_file_exact(&media.path, media.size_bytes)?;
        if actual != media.sha256 {
            return Err("Record media digest no longer matches its inventory".to_string());
        }
        Ok(media)
    }

    pub(crate) async fn begin_live_transcript(
        &self,
        id: &str,
        provenance: RecordSpeechProvenance,
    ) -> Result<RecordLiveTranscriptJournal, String> {
        let stored = self
            .inner
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {id}"))?;
        RecordLiveTranscriptJournal::create(&stored.path, &stored.record, provenance)
    }

    pub async fn read_live_transcript_revisions(
        &self,
        id: &str,
    ) -> Result<Option<RecordTranscriptSnapshot>, String> {
        let stored = self
            .inner
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {id}"))?;
        if stored.record.kind != RecordKind::Audio || stored.record.audio.is_none() {
            return Err(format!("Record is not audio: {id}"));
        }
        let path = stored.path.join("transcript/revisions.jsonl");
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("inspect live transcript journal: {error}")),
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > TRANSCRIPT_REVISION_MAX_BYTES
        {
            return Err("live transcript revision journal is invalid".to_string());
        }
        let (entries, _) = read_valid_prefix::<RecordTranscriptRevisionEvent>(
            &path,
            id,
            TRANSCRIPT_REVISION_SCHEMA_VERSION,
            TRANSCRIPT_REVISION_MAX_LINE_BYTES,
        )?;
        project_live_transcript(id, entries).map(Some)
    }

    pub async fn read_live_transcript_delta(
        &self,
        id: &str,
        cursor: Option<RecordTranscriptCursor>,
    ) -> Result<Option<RecordTranscriptDelta>, String> {
        let stored = self
            .inner
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {id}"))?;
        if stored.record.kind != RecordKind::Audio || stored.record.audio.is_none() {
            return Err(format!("Record is not audio: {id}"));
        }
        let path = stored.path.join("transcript/revisions.jsonl");
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("inspect live transcript journal: {error}")),
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > TRANSCRIPT_REVISION_MAX_BYTES
        {
            return Err("live transcript revision journal is invalid".to_string());
        }

        if let Some(cursor) = cursor.filter(|cursor| cursor.journal_bytes <= metadata.len()) {
            if cursor.journal_bytes == metadata.len() {
                return Ok(None);
            }
            if let Ok((entries, journal_bytes)) = read_valid_suffix::<RecordTranscriptRevisionEvent>(
                &path,
                id,
                TRANSCRIPT_REVISION_SCHEMA_VERSION,
                TRANSCRIPT_REVISION_MAX_LINE_BYTES,
                cursor.journal_bytes,
                cursor.projection_revision.saturating_add(1),
            ) {
                if entries.is_empty() {
                    return Ok(None);
                }
                let projection_revision = entries
                    .last()
                    .map_or(cursor.projection_revision, |entry| entry.seq);
                let mut state = "live".to_string();
                let mut upserts = Vec::new();
                for entry in entries {
                    match entry.event {
                        RecordTranscriptRevisionEvent::GenerationStarted { .. }
                        | RecordTranscriptRevisionEvent::GenerationFailed { .. } => {
                            state = "recovering".to_string();
                        }
                        RecordTranscriptRevisionEvent::SegmentUpsert { segment } => {
                            state = "live".to_string();
                            upserts.push(segment);
                        }
                        RecordTranscriptRevisionEvent::SessionFailed { .. } => {
                            state = "failed".to_string();
                        }
                        RecordTranscriptRevisionEvent::SessionFinished => {
                            state = "finalizing".to_string();
                        }
                        RecordTranscriptRevisionEvent::SessionStarted { .. } => {
                            return Err(
                                "live transcript cursor crossed a session boundary".to_string()
                            )
                        }
                    }
                }
                return Ok(Some(RecordTranscriptDelta {
                    record_id: id.to_string(),
                    projection_revision,
                    state,
                    upserts,
                    reset_snapshot: None,
                    cursor: RecordTranscriptCursor {
                        journal_bytes,
                        projection_revision,
                    },
                }));
            }
        }

        let (entries, journal_bytes) = read_valid_prefix::<RecordTranscriptRevisionEvent>(
            &path,
            id,
            TRANSCRIPT_REVISION_SCHEMA_VERSION,
            TRANSCRIPT_REVISION_MAX_LINE_BYTES,
        )?;
        let snapshot = project_live_transcript(id, entries)?;
        let projection_revision = snapshot.projection_revision;
        Ok(Some(RecordTranscriptDelta {
            record_id: id.to_string(),
            projection_revision,
            state: snapshot.state.clone(),
            upserts: Vec::new(),
            reset_snapshot: Some(snapshot),
            cursor: RecordTranscriptCursor {
                journal_bytes,
                projection_revision,
            },
        }))
    }

    pub(crate) async fn read_live_segment_finalizations(
        &self,
        id: &str,
    ) -> Result<Vec<RecordSegmentFinalization>, String> {
        let stored = self
            .inner
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {id}"))?;
        let path = stored.path.join("transcript/revisions.jsonl");
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("inspect live transcript journal: {error}")),
        };
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > TRANSCRIPT_REVISION_MAX_BYTES
        {
            return Err("live transcript revision journal is invalid".to_string());
        }
        let entries = recover_and_read::<RecordTranscriptRevisionEvent>(
            &path,
            id,
            TRANSCRIPT_REVISION_SCHEMA_VERSION,
            TRANSCRIPT_REVISION_MAX_LINE_BYTES,
        )?;
        let mut finalizations = HashMap::<String, RecordSegmentFinalization>::new();
        for entry in entries {
            if let RecordTranscriptRevisionEvent::SegmentUpsert { segment } = entry.event {
                finalizations.insert(
                    segment.segment_id,
                    RecordSegmentFinalization {
                        wall_time_ms: entry.wall_time_ms,
                        media_ms: entry.media_ms,
                    },
                );
            }
        }
        let mut finalizations = finalizations.into_values().collect::<Vec<_>>();
        finalizations.sort_by_key(|item| (item.media_ms, item.wall_time_ms));
        Ok(finalizations)
    }

    pub async fn update_audio_processing_status(
        &self,
        id: &str,
        transcription_status: Option<TranscriptionStatus>,
        diarization_status: Option<DiarizationStatus>,
    ) -> Result<Record, String> {
        if transcription_status.is_none() && diarization_status.is_none() {
            return Err("audio processing status mutation is empty".to_string());
        }
        let mut inner = self.inner.write().await;
        let stored = inner
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {id}"))?;
        if stored.record.kind != RecordKind::Audio {
            return Err(format!("Record is not audio: {id}"));
        }
        let mut updated = stored.record.clone();
        let audio = updated
            .audio
            .as_mut()
            .ok_or_else(|| format!("audio Record summary missing: {id}"))?;
        if let Some(status) = transcription_status {
            audio.transcription_status = status;
        }
        if let Some(status) = diarization_status {
            audio.diarization_status = status;
        }
        updated.updated_at = now_ms();
        updated.revision = updated.revision.saturating_add(1);
        persist_existing_record(
            &stored.path,
            &updated,
            stored.legacy_thought_digest.clone(),
            false,
        )?;
        updated = refresh_audio_discussion_document_best_effort(&stored, updated);
        inner.insert(
            id.to_string(),
            StoredRecord {
                record: updated.clone(),
                ..stored
            },
        );
        self.emit_change(id, RecordChangeKind::Upsert);
        Ok(updated)
    }

    pub async fn commit_recording_final_transcript(
        &self,
        id: &str,
        segments: Vec<RecordTranscriptSegment>,
        provenance: RecordSpeechProvenance,
    ) -> Result<RecordTranscriptSnapshot, String> {
        let mut segments = SensitiveTranscriptInput(segments);
        let mut inner = self.inner.write().await;
        let stored = inner
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {id}"))?;
        let audio = stored
            .record
            .audio
            .as_ref()
            .ok_or_else(|| format!("Record is not audio: {id}"))?;
        validate_transcript_segments(audio, &segments.0)?;
        validate_speech_provenance(&provenance)?;

        let relative = PathBuf::from("transcript/snapshot.json");
        let snapshot_path = stored.path.join(&relative);
        let projection_revision = match stored
            .record
            .artifacts
            .iter()
            .find(|artifact| artifact.kind == "transcript/recording-final+json")
        {
            Some(artifact) => read_owned_transcript_snapshot(id, &stored.path, audio, artifact)?
                .projection_revision
                .saturating_add(1)
                .max(1),
            None if snapshot_path.exists() => {
                return Err("transcript snapshot exists outside Record inventory".to_string());
            }
            None => 1,
        };
        let snapshot = RecordTranscriptSnapshot {
            schema_version: 1,
            record_id: id.to_string(),
            projection_revision,
            state: "recording_final".into(),
            sample_rate: SPEECH_SAMPLE_RATE as u32,
            provenance,
            segments: std::mem::take(&mut segments.0),
        };
        let mut bytes = serde_json::to_vec_pretty(&snapshot)
            .map_err(|error| format!("serialize transcript snapshot: {error}"))?;
        if bytes.is_empty() || bytes.len() as u64 > TRANSCRIPT_SNAPSHOT_MAX_BYTES {
            bytes.zeroize();
            return Err("transcript snapshot exceeds the fixed size limit".to_string());
        }
        let content = match std::str::from_utf8(&bytes) {
            Ok(content) => content,
            Err(_) => {
                bytes.zeroize();
                return Err("transcript snapshot serialization is not UTF-8".to_string());
            }
        };
        let write_result = crate::task::write_atomic_text(&snapshot_path, content);
        bytes.zeroize();
        write_result?;

        let mut updated = stored.record.clone();
        replace_record_artifact(
            &mut updated.artifacts,
            record_artifact_from_file(
                &snapshot_path,
                &relative,
                "transcript/recording-final+json",
            )?,
            "transcript/recording-final+json",
        );
        let audio = updated
            .audio
            .as_mut()
            .ok_or_else(|| format!("audio Record summary missing: {id}"))?;
        audio.transcription_status = TranscriptionStatus::Ready;
        if audio.diarization_status == DiarizationStatus::NotApplicable {
            audio.diarization_status = DiarizationStatus::Queued;
        }
        updated.updated_at = now_ms();
        updated.revision = updated.revision.saturating_add(1);
        persist_existing_record(
            &stored.path,
            &updated,
            stored.legacy_thought_digest.clone(),
            false,
        )?;
        updated = refresh_audio_discussion_document_best_effort(&stored, updated);
        inner.insert(
            id.to_string(),
            StoredRecord {
                record: updated,
                ..stored
            },
        );
        self.emit_change(id, RecordChangeKind::Upsert);
        Ok(snapshot)
    }

    pub async fn commit_diarization_result(
        &self,
        id: &str,
        turns: Vec<RecordSpeakerTurn>,
        provenance: RecordSpeechProvenance,
    ) -> Result<RecordDiarizationResult, String> {
        let mut inner = self.inner.write().await;
        let stored = inner
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {id}"))?;
        let audio = stored
            .record
            .audio
            .as_ref()
            .ok_or_else(|| format!("Record is not audio: {id}"))?;
        validate_speaker_turns(audio, &turns)?;
        validate_speech_provenance(&provenance)?;

        let relative = PathBuf::from("diarization/result.json");
        let result_path = stored.path.join(&relative);
        let projection_revision = match stored
            .record
            .artifacts
            .iter()
            .find(|artifact| artifact.kind == "diarization/model-projection+json")
        {
            Some(artifact) => read_owned_diarization_result(id, &stored.path, audio, artifact)?
                .projection_revision
                .saturating_add(1)
                .max(1),
            None if result_path.exists() => {
                return Err("diarization result exists outside Record inventory".to_string());
            }
            None => 1,
        };
        let result = RecordDiarizationResult {
            schema_version: 1,
            record_id: id.to_string(),
            projection_revision,
            sample_rate: SPEECH_SAMPLE_RATE as u32,
            provenance,
            turns,
        };
        let bytes = serde_json::to_vec_pretty(&result)
            .map_err(|error| format!("serialize diarization result: {error}"))?;
        if bytes.is_empty() || bytes.len() as u64 > TRANSCRIPT_SNAPSHOT_MAX_BYTES {
            return Err("diarization result exceeds the fixed size limit".to_string());
        }
        let content = std::str::from_utf8(&bytes)
            .map_err(|_| "diarization result serialization is not UTF-8".to_string())?;
        crate::task::write_atomic_text(&result_path, content)?;

        let mut updated = stored.record.clone();
        replace_record_artifact(
            &mut updated.artifacts,
            record_artifact_from_file(
                &result_path,
                &relative,
                "diarization/model-projection+json",
            )?,
            "diarization/model-projection+json",
        );
        let audio = updated
            .audio
            .as_mut()
            .ok_or_else(|| format!("audio Record summary missing: {id}"))?;
        audio.diarization_status = DiarizationStatus::Ready;
        updated.updated_at = now_ms();
        updated.revision = updated.revision.saturating_add(1);
        persist_existing_record(
            &stored.path,
            &updated,
            stored.legacy_thought_digest.clone(),
            false,
        )?;
        updated = refresh_audio_discussion_document_best_effort(&stored, updated);
        inner.insert(
            id.to_string(),
            StoredRecord {
                record: updated,
                ..stored
            },
        );
        self.emit_change(id, RecordChangeKind::Upsert);
        Ok(result)
    }

    pub async fn read_recording_final_transcript(
        &self,
        id: &str,
    ) -> Result<Option<RecordTranscriptSnapshot>, String> {
        let inner = self.inner.read().await;
        let stored = inner
            .get(id)
            .ok_or_else(|| format!("Record not found: {id}"))?;
        if stored.record.kind != RecordKind::Audio {
            return Err(format!("Record is not audio: {id}"));
        }
        let Some(audio) = stored.record.audio.as_ref() else {
            return Err(format!("audio Record summary missing: {id}"));
        };
        let Some(artifact) = stored
            .record
            .artifacts
            .iter()
            .find(|artifact| artifact.kind == "transcript/recording-final+json")
        else {
            return Ok(None);
        };
        read_owned_transcript_snapshot(id, &stored.path, audio, artifact).map(Some)
    }

    pub async fn read_diarization_result(
        &self,
        id: &str,
    ) -> Result<Option<RecordDiarizationResult>, String> {
        let inner = self.inner.read().await;
        let stored = inner
            .get(id)
            .ok_or_else(|| format!("Record not found: {id}"))?;
        if stored.record.kind != RecordKind::Audio {
            return Err(format!("Record is not audio: {id}"));
        }
        let Some(audio) = stored.record.audio.as_ref() else {
            return Err(format!("audio Record summary missing: {id}"));
        };
        let Some(artifact) = stored
            .record
            .artifacts
            .iter()
            .find(|artifact| artifact.kind == "diarization/model-projection+json")
        else {
            return Ok(None);
        };
        read_owned_diarization_result(id, &stored.path, audio, artifact).map(Some)
    }

    pub async fn read_diarization_projection(
        &self,
        id: &str,
    ) -> Result<Option<RecordDiarizationProjection>, String> {
        let inner = self.inner.read().await;
        let stored = inner
            .get(id)
            .ok_or_else(|| format!("Record not found: {id}"))?;
        read_diarization_projection_for_stored(stored)
    }

    pub async fn rename_speaker(
        &self,
        input: RecordSpeakerRenameInput,
    ) -> Result<RecordDiarizationProjection, String> {
        let name = input.name.trim().to_string();
        if name.is_empty()
            || name.as_bytes().len() > SPEAKER_DISPLAY_NAME_MAX_BYTES
            || name.contains('\0')
        {
            return Err("Speaker display name is invalid".to_string());
        }
        self.mutate_speaker_overrides(
            &input.record_id,
            input.expected_override_revision,
            input.updated_at_wall_time,
            move |_stored, model, overrides| {
                let speakers = model_speaker_ids(model);
                if !speakers.contains(&input.speaker_id) {
                    return Err("Speaker not found".to_string());
                }
                let speaker_id = resolve_merged_speaker(input.speaker_id, &overrides.merges)?;
                overrides.renames.insert(speaker_id, name);
                Ok(())
            },
        )
        .await
    }

    pub async fn merge_speakers(
        &self,
        input: RecordSpeakerMergeInput,
    ) -> Result<RecordDiarizationProjection, String> {
        self.mutate_speaker_overrides(
            &input.record_id,
            input.expected_override_revision,
            input.updated_at_wall_time,
            move |_stored, model, overrides| {
                let speakers = model_speaker_ids(model);
                if !speakers.contains(&input.source_speaker_id)
                    || !speakers.contains(&input.target_speaker_id)
                {
                    return Err("Speaker not found".to_string());
                }
                let source = resolve_merged_speaker(input.source_speaker_id, &overrides.merges)?;
                let target = resolve_merged_speaker(input.target_speaker_id, &overrides.merges)?;
                if source == target {
                    return Err("Speakers are already merged".to_string());
                }
                for merged_target in overrides.merges.values_mut() {
                    if *merged_target == source {
                        *merged_target = target;
                    }
                }
                overrides.merges.insert(source, target);
                overrides.renames.remove(&source);
                for reassigned in overrides.reassignments.values_mut() {
                    if *reassigned == source {
                        *reassigned = target;
                    }
                }
                Ok(())
            },
        )
        .await
    }

    pub async fn reassign_segment_speaker(
        &self,
        input: RecordSegmentSpeakerReassignInput,
    ) -> Result<RecordDiarizationProjection, String> {
        if input.segment_id.trim().is_empty() {
            return Err("Transcript segment ID is invalid".to_string());
        }
        self.mutate_speaker_overrides(
            &input.record_id,
            input.expected_override_revision,
            input.updated_at_wall_time,
            move |stored, model, overrides| {
                let speakers = model_speaker_ids(model);
                if !speakers.contains(&input.speaker_id) {
                    return Err("Speaker not found".to_string());
                }
                let transcript = read_current_transcript(stored)?
                    .ok_or_else(|| "Record transcript is not available".to_string())?;
                if !transcript
                    .segments
                    .iter()
                    .any(|segment| segment.segment_id == input.segment_id)
                {
                    return Err("Transcript segment not found".to_string());
                }
                let speaker_id = resolve_merged_speaker(input.speaker_id, &overrides.merges)?;
                overrides.reassignments.insert(input.segment_id, speaker_id);
                Ok(())
            },
        )
        .await
    }

    async fn mutate_speaker_overrides<F>(
        &self,
        record_id: &str,
        expected_override_revision: u64,
        updated_at_wall_time: i64,
        mutate: F,
    ) -> Result<RecordDiarizationProjection, String>
    where
        F: FnOnce(
            &StoredRecord,
            &RecordDiarizationResult,
            &mut RecordSpeakerOverrides,
        ) -> Result<(), String>,
    {
        if updated_at_wall_time <= 0 {
            return Err("Speaker override wall time is invalid".to_string());
        }
        let mut inner = self.inner.write().await;
        let stored = inner
            .get(record_id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {record_id}"))?;
        let audio = stored
            .record
            .audio
            .as_ref()
            .ok_or_else(|| format!("Record is not audio: {record_id}"))?;
        let artifact = stored
            .record
            .artifacts
            .iter()
            .find(|artifact| artifact.kind == "diarization/model-projection+json")
            .ok_or_else(|| "Record diarization is not available".to_string())?;
        let model = read_owned_diarization_result(record_id, &stored.path, audio, artifact)?;
        let mut overrides = read_speaker_overrides(&stored)?;
        if overrides.revision != expected_override_revision {
            return Err("RECORD_SPEAKER_OVERRIDE_REVISION_CONFLICT".to_string());
        }
        mutate(&stored, &model, &mut overrides)?;
        overrides.revision = overrides.revision.saturating_add(1);
        overrides.updated_at_wall_time = updated_at_wall_time;
        write_speaker_overrides(&stored, &overrides)?;
        let mut updated = stored.record.clone();
        updated.updated_at = now_ms();
        updated.revision = updated.revision.saturating_add(1);
        persist_existing_record(
            &stored.path,
            &updated,
            stored.legacy_thought_digest.clone(),
            false,
        )?;
        updated = refresh_audio_discussion_document_best_effort(&stored, updated);
        let updated_stored = StoredRecord {
            record: updated,
            ..stored
        };
        let projection = project_diarization(&updated_stored, model, overrides)?;
        inner.insert(record_id.to_string(), updated_stored);
        self.emit_change(record_id, RecordChangeKind::Upsert);
        Ok(projection)
    }

    pub async fn read_transcript_projection(
        &self,
        id: &str,
    ) -> Result<Option<RecordTranscriptSnapshot>, String> {
        if let Some(snapshot) = self.read_recording_final_transcript(id).await? {
            return Ok(Some(snapshot));
        }
        self.read_live_transcript_revisions(id).await
    }

    pub async fn read_timeline(&self, id: &str) -> Result<RecordTimelineProjection, String> {
        let stored = self
            .inner
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {id}"))?;
        ensure_audio_record(&stored, id)?;
        read_timeline_projection(&stored)
    }

    pub async fn add_note(
        &self,
        input: RecordNoteCreateInput,
    ) -> Result<RecordTimelineProjection, String> {
        validate_timeline_operation_id(&input.operation_id)?;
        validate_timeline_media_ms(input.anchor_media_ms)?;
        if input.started_at_wall_time <= 0
            || input.submitted_at_wall_time < input.started_at_wall_time
            || input.text.trim().is_empty()
            || input.text.as_bytes().len() > TIMELINE_TEXT_MAX_BYTES
            || input.text.contains('\0')
        {
            return Err("Record note is invalid".to_string());
        }

        let mut inner = self.inner.write().await;
        let stored = inner
            .get(&input.record_id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {}", input.record_id))?;
        ensure_audio_record(&stored, &input.record_id)?;
        let path = stored.path.join("timeline.jsonl");
        let mut entries = read_timeline_entries(&stored)?;
        if entries
            .iter()
            .any(|entry| entry.event.operation_id() == input.operation_id)
        {
            return project_timeline(&stored.record, entries);
        }
        ensure_timeline_append_budget(&path, entries.len())?;
        let mut journal = DurableRecordJournal::open(
            path,
            &input.record_id,
            TIMELINE_SCHEMA_VERSION,
            TIMELINE_MAX_LINE_BYTES,
        )?;
        let entry = journal.append(
            input.submitted_at_wall_time,
            input.anchor_media_ms,
            RecordTimelineEvent::NoteCreated {
                operation_id: input.operation_id,
                note_id: Uuid::new_v4().to_string(),
                anchor_media_ms: input.anchor_media_ms,
                started_at_wall_time: input.started_at_wall_time,
                submitted_at_wall_time: input.submitted_at_wall_time,
                text: input.text,
            },
        )?;
        entries.push(entry);
        let updated =
            refresh_audio_discussion_document_best_effort(&stored, touch_timeline_record(&stored)?);
        inner.insert(
            input.record_id.clone(),
            StoredRecord {
                record: updated.clone(),
                ..stored
            },
        );
        self.emit_change(&input.record_id, RecordChangeKind::Upsert);
        project_timeline(&updated, entries)
    }

    pub async fn add_mark(
        &self,
        input: RecordMarkCreateInput,
    ) -> Result<RecordTimelineProjection, String> {
        validate_timeline_operation_id(&input.operation_id)?;
        validate_timeline_media_ms(input.media_ms)?;
        if input.wall_time <= 0 {
            return Err("Record mark wall time is invalid".to_string());
        }

        let mut inner = self.inner.write().await;
        let stored = inner
            .get(&input.record_id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {}", input.record_id))?;
        ensure_audio_record(&stored, &input.record_id)?;
        let path = stored.path.join("timeline.jsonl");
        let mut entries = read_timeline_entries(&stored)?;
        if entries
            .iter()
            .any(|entry| entry.event.operation_id() == input.operation_id)
        {
            return project_timeline(&stored.record, entries);
        }
        ensure_timeline_append_budget(&path, entries.len())?;
        let mut journal = DurableRecordJournal::open(
            path,
            &input.record_id,
            TIMELINE_SCHEMA_VERSION,
            TIMELINE_MAX_LINE_BYTES,
        )?;
        let entry = journal.append(
            input.wall_time,
            input.media_ms,
            RecordTimelineEvent::MarkCreated {
                operation_id: input.operation_id,
                mark_id: Uuid::new_v4().to_string(),
                media_ms: input.media_ms,
                wall_time: input.wall_time,
                kind: "highlight".to_string(),
            },
        )?;
        entries.push(entry);
        let updated =
            refresh_audio_discussion_document_best_effort(&stored, touch_timeline_record(&stored)?);
        inner.insert(
            input.record_id.clone(),
            StoredRecord {
                record: updated.clone(),
                ..stored
            },
        );
        self.emit_change(&input.record_id, RecordChangeKind::Upsert);
        project_timeline(&updated, entries)
    }

    pub async fn update_note(
        &self,
        input: RecordNoteUpdateInput,
    ) -> Result<RecordTimelineProjection, String> {
        validate_timeline_operation_id(&input.operation_id)?;
        if Uuid::parse_str(&input.note_id).is_err()
            || input.updated_at_wall_time <= 0
            || input.text.trim().is_empty()
            || input.text.as_bytes().len() > TIMELINE_TEXT_MAX_BYTES
            || input.text.contains('\0')
        {
            return Err("Record note update is invalid".to_string());
        }

        let mut inner = self.inner.write().await;
        let stored = inner
            .get(&input.record_id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {}", input.record_id))?;
        ensure_audio_record(&stored, &input.record_id)?;
        let path = stored.path.join("timeline.jsonl");
        let mut entries = read_timeline_entries(&stored)?;
        if entries
            .iter()
            .any(|entry| entry.event.operation_id() == input.operation_id)
        {
            return project_timeline(&stored.record, entries);
        }
        let current = project_timeline(&stored.record, entries.clone())?;
        if !current.items.iter().any(|item| {
            matches!(item, RecordTimelineItem::Note { note_id, .. } if note_id == &input.note_id)
        }) {
            return Err("Record note not found".to_string());
        }
        ensure_timeline_append_budget(&path, entries.len())?;
        let mut journal = DurableRecordJournal::open(
            path,
            &input.record_id,
            TIMELINE_SCHEMA_VERSION,
            TIMELINE_MAX_LINE_BYTES,
        )?;
        entries.push(journal.append(
            input.updated_at_wall_time,
            0,
            RecordTimelineEvent::NoteUpdated {
                operation_id: input.operation_id,
                note_id: input.note_id,
                updated_at_wall_time: input.updated_at_wall_time,
                text: input.text,
            },
        )?);
        let updated =
            refresh_audio_discussion_document_best_effort(&stored, touch_timeline_record(&stored)?);
        inner.insert(
            input.record_id.clone(),
            StoredRecord {
                record: updated.clone(),
                ..stored
            },
        );
        self.emit_change(&input.record_id, RecordChangeKind::Upsert);
        project_timeline(&updated, entries)
    }

    pub async fn delete_timeline_item(
        &self,
        input: RecordTimelineDeleteInput,
    ) -> Result<RecordTimelineProjection, String> {
        validate_timeline_operation_id(&input.operation_id)?;
        if Uuid::parse_str(&input.item_id).is_err()
            || input.deleted_at_wall_time <= 0
            || !matches!(input.item_type.as_str(), "note" | "mark")
        {
            return Err("Record timeline delete is invalid".to_string());
        }

        let mut inner = self.inner.write().await;
        let stored = inner
            .get(&input.record_id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {}", input.record_id))?;
        ensure_audio_record(&stored, &input.record_id)?;
        let path = stored.path.join("timeline.jsonl");
        let mut entries = read_timeline_entries(&stored)?;
        if entries
            .iter()
            .any(|entry| entry.event.operation_id() == input.operation_id)
        {
            return project_timeline(&stored.record, entries);
        }
        let current = project_timeline(&stored.record, entries.clone())?;
        let exists = current.items.iter().any(|item| match item {
            RecordTimelineItem::Note { note_id, .. } => {
                input.item_type == "note" && note_id == &input.item_id
            }
            RecordTimelineItem::Mark { mark_id, .. } => {
                input.item_type == "mark" && mark_id == &input.item_id
            }
        });
        if !exists {
            return Err("Record timeline item not found".to_string());
        }
        ensure_timeline_append_budget(&path, entries.len())?;
        let mut journal = DurableRecordJournal::open(
            path,
            &input.record_id,
            TIMELINE_SCHEMA_VERSION,
            TIMELINE_MAX_LINE_BYTES,
        )?;
        let event = if input.item_type == "note" {
            RecordTimelineEvent::NoteDeleted {
                operation_id: input.operation_id,
                note_id: input.item_id,
                deleted_at_wall_time: input.deleted_at_wall_time,
            }
        } else {
            RecordTimelineEvent::MarkDeleted {
                operation_id: input.operation_id,
                mark_id: input.item_id,
                deleted_at_wall_time: input.deleted_at_wall_time,
            }
        };
        entries.push(journal.append(input.deleted_at_wall_time, 0, event)?);
        let updated =
            refresh_audio_discussion_document_best_effort(&stored, touch_timeline_record(&stored)?);
        inner.insert(
            input.record_id.clone(),
            StoredRecord {
                record: updated.clone(),
                ..stored
            },
        );
        self.emit_change(&input.record_id, RecordChangeKind::Upsert);
        project_timeline(&updated, entries)
    }

    async fn publish_and_insert<F>(
        &self,
        record: Record,
        legacy_digest: Option<String>,
        populate_staging: F,
    ) -> Result<Record, String>
    where
        F: FnOnce(&Path) -> Result<(), String>,
    {
        let final_path = record_path(&self.root, &record);
        publish_record_directory(
            &self.root,
            &final_path,
            &record,
            legacy_digest.clone(),
            populate_staging,
        )?;
        let mut inner = self.inner.write().await;
        inner.insert(
            record.id.clone(),
            StoredRecord {
                record: record.clone(),
                path: final_path,
                legacy_thought_digest: legacy_digest,
            },
        );
        self.set_published_record(&record.id, true);
        self.emit_change(&record.id, RecordChangeKind::Upsert);
        ulog_info!("[record] created id={} kind={:?}", record.id, record.kind);
        Ok(record)
    }

    pub async fn list(&self, filter: RecordListFilter) -> Vec<RecordSummary> {
        self.filtered_records(filter)
            .await
            .iter()
            .map(RecordSummary::from)
            .collect()
    }

    pub async fn list_full(&self, filter: RecordListFilter) -> Vec<Record> {
        self.filtered_records(filter).await
    }

    async fn filtered_records(&self, filter: RecordListFilter) -> Vec<Record> {
        let inner = self.inner.read().await;
        let mut records: Vec<Record> = inner.values().map(|stored| stored.record.clone()).collect();
        match filter.archived.unwrap_or(RecordArchiveFilter::Active) {
            RecordArchiveFilter::Active => records.retain(|record| !record.archived),
            RecordArchiveFilter::Archived => records.retain(|record| record.archived),
            RecordArchiveFilter::All => {}
        }
        if let Some(kind) = filter.kind {
            records.retain(|record| record.kind == kind);
        }
        if let Some(tag) = filter.tag.as_deref() {
            let needle = tag.to_lowercase();
            records.retain(|record| {
                record
                    .tags
                    .iter()
                    .any(|candidate| candidate.to_lowercase() == needle)
            });
        }
        if let Some(query) = filter.query.as_deref() {
            let needle = query.to_lowercase();
            records.retain(|record| {
                record.title.to_lowercase().contains(&needle)
                    || record
                        .content
                        .as_deref()
                        .is_some_and(|content| content.to_lowercase().contains(&needle))
            });
        }
        records.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| right.id.cmp(&left.id))
        });
        if let Some(limit) = filter.limit {
            records.truncate(limit);
        }
        records
    }

    pub async fn get(&self, id: &str) -> Option<Record> {
        self.inner
            .read()
            .await
            .get(id)
            .map(|stored| stored.record.clone())
    }

    pub async fn search_documents(&self, id: &str) -> Result<Vec<RecordSearchDocument>, String> {
        let stored = self
            .inner
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {id}"))?;
        tokio::task::spawn_blocking(move || build_record_search_documents(&stored))
            .await
            .map_err(|error| format!("Record search projection panicked: {error}"))?
    }

    pub async fn all_search_documents(&self) -> Vec<RecordSearchDocument> {
        let stored = self
            .inner
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        tokio::task::spawn_blocking(move || {
            stored
                .iter()
                .flat_map(|record| match build_record_search_documents(record) {
                    Ok(documents) => documents,
                    Err(error) => {
                        ulog_warn!(
                            "[record-search] skipped derived content recordId={} error={}",
                            record.record.id,
                            error
                        );
                        vec![base_record_search_document(record)]
                    }
                })
                .collect()
        })
        .await
        .unwrap_or_else(|error| {
            ulog_warn!("[record-search] baseline projection panicked: {error}");
            Vec::new()
        })
    }

    pub async fn update_text(&self, input: TextRecordUpdateInput) -> Result<Record, String> {
        let mut inner = self.inner.write().await;
        let stored = inner
            .get(&input.id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {}", input.id))?;
        if stored.record.kind != RecordKind::Text {
            return Err(format!("Record is not text: {}", input.id));
        }
        let mut updated = stored.record;
        let mut content_changed = false;
        if let Some(content) = input.content {
            if content.trim().is_empty() {
                return Err("record content must not be empty".to_string());
            }
            updated.title = derive_text_title(&content);
            updated.tags = parse_tags(&content);
            updated.content = Some(content);
            content_changed = true;
        }
        if let Some(images) = input.images {
            if images != updated.images {
                return Err(
                    "Record attachments cannot be changed through the text update API".to_string(),
                );
            }
        }
        if let Some(task_ids) = input.converted_task_ids {
            updated.converted_task_ids = dedup_preserving_order(task_ids);
        }
        updated.updated_at = now_ms();
        updated.revision = updated.revision.saturating_add(1);
        persist_existing_record(
            &stored.path,
            &updated,
            stored.legacy_thought_digest.clone(),
            content_changed,
        )?;
        inner.insert(
            updated.id.clone(),
            StoredRecord {
                record: updated.clone(),
                ..stored
            },
        );
        self.emit_change(&updated.id, RecordChangeKind::Upsert);
        Ok(updated)
    }

    pub async fn update_audio_metadata(
        &self,
        input: AudioRecordMetadataUpdateInput,
    ) -> Result<Record, String> {
        let title = input.title.trim();
        if title.is_empty() || title.chars().count() > 80 || title.contains('\0') {
            return Err("audio Record title is invalid".to_string());
        }
        let tags = normalize_audio_tags(input.tags)?;
        let mut inner = self.inner.write().await;
        let stored = inner
            .get(&input.id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {}", input.id))?;
        ensure_audio_record(&stored, &input.id)?;
        if stored.record.revision != input.expected_revision {
            return Err("RECORD_REVISION_CONFLICT".to_string());
        }
        if stored.record.title == title && stored.record.tags == tags {
            return Ok(stored.record);
        }
        let mut updated = stored.record.clone();
        updated.title = title.to_string();
        updated.tags = tags;
        updated.updated_at = now_ms();
        updated.revision = updated.revision.saturating_add(1);
        persist_existing_record(
            &stored.path,
            &updated,
            stored.legacy_thought_digest.clone(),
            false,
        )?;
        updated = refresh_audio_discussion_document_best_effort(&stored, updated);
        inner.insert(
            input.id.clone(),
            StoredRecord {
                record: updated.clone(),
                ..stored
            },
        );
        self.emit_change(&input.id, RecordChangeKind::Upsert);
        Ok(updated)
    }

    pub async fn export_audio(
        &self,
        input: RecordAudioExportInput,
    ) -> Result<RecordExportResult, String> {
        let media = self
            .resolve_record_media_for_processing(&input.record_id, input.track)
            .await?;
        let destination = validate_new_export_destination(&input.destination_path, "opus")?;
        let bytes = copy_regular_file_noreplace(&media.path, &destination, media.size_bytes)?;
        Ok(RecordExportResult {
            destination_path: destination.to_string_lossy().to_string(),
            bytes,
        })
    }

    pub async fn export_text(
        &self,
        input: RecordTextExportInput,
    ) -> Result<RecordExportResult, String> {
        if !matches!(input.locale.as_str(), "zh-CN" | "en-US") {
            return Err("Record export locale is invalid".to_string());
        }
        let extension = match input.format {
            RecordTextExportFormat::Markdown => "md",
            RecordTextExportFormat::Text => "txt",
        };
        let destination = validate_new_export_destination(&input.destination_path, extension)?;
        let rendered = {
            let inner = self.inner.read().await;
            let stored = inner
                .get(&input.record_id)
                .ok_or_else(|| format!("Record not found: {}", input.record_id))?;
            ensure_audio_record(stored, &input.record_id)?;
            render_record_text_export(stored, input.format, &input.locale)?
        };
        let bytes = write_bytes_noreplace(&destination, rendered.as_bytes())?;
        Ok(RecordExportResult {
            destination_path: destination.to_string_lossy().to_string(),
            bytes,
        })
    }

    pub async fn set_archived(&self, id: &str, archived: bool) -> Result<Record, String> {
        let mut inner = self.inner.write().await;
        let stored = inner
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {id}"))?;
        if stored.record.archived == archived {
            return Ok(stored.record);
        }
        let mut updated = stored.record;
        updated.archived = archived;
        updated.updated_at = now_ms();
        updated.revision = updated.revision.saturating_add(1);
        persist_existing_record(
            &stored.path,
            &updated,
            stored.legacy_thought_digest.clone(),
            false,
        )?;
        inner.insert(
            id.to_string(),
            StoredRecord {
                record: updated.clone(),
                ..stored
            },
        );
        self.emit_change(id, RecordChangeKind::Upsert);
        Ok(updated)
    }

    pub async fn link_task(&self, record_id: &str, task_id: &str) -> Result<Record, String> {
        let mut inner = self.inner.write().await;
        let stored = inner
            .get(record_id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {record_id}"))?;
        if stored
            .record
            .converted_task_ids
            .iter()
            .any(|candidate| candidate == task_id)
        {
            return Ok(stored.record);
        }
        let mut updated = stored.record;
        updated.converted_task_ids.push(task_id.to_string());
        updated.updated_at = now_ms();
        updated.revision = updated.revision.saturating_add(1);
        persist_existing_record(
            &stored.path,
            &updated,
            stored.legacy_thought_digest.clone(),
            false,
        )?;
        inner.insert(
            record_id.to_string(),
            StoredRecord {
                record: updated.clone(),
                ..stored
            },
        );
        self.emit_change(record_id, RecordChangeKind::Upsert);
        Ok(updated)
    }

    pub async fn unlink_task(&self, record_id: &str, task_id: &str) -> Result<(), String> {
        let mut inner = self.inner.write().await;
        let Some(stored) = inner.get(record_id).cloned() else {
            return Ok(());
        };
        let mut updated = stored.record;
        let before = updated.converted_task_ids.len();
        updated
            .converted_task_ids
            .retain(|candidate| candidate != task_id);
        if updated.converted_task_ids.len() == before {
            return Ok(());
        }
        updated.updated_at = now_ms();
        updated.revision = updated.revision.saturating_add(1);
        persist_existing_record(
            &stored.path,
            &updated,
            stored.legacy_thought_digest.clone(),
            false,
        )?;
        inner.insert(
            record_id.to_string(),
            StoredRecord {
                record: updated,
                ..stored
            },
        );
        self.emit_change(record_id, RecordChangeKind::Upsert);
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.write().await;
        let stored = inner
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Record not found: {id}"))?;
        let parent = stored
            .path
            .parent()
            .ok_or_else(|| "Record directory has no parent".to_string())?
            .to_path_buf();
        remove_plain_record_directory(&stored.path)?;
        inner.remove(id);
        self.set_published_record(id, false);
        self.emit_change(id, RecordChangeKind::Delete);
        sync_directory(&parent).map_err(|error| format!("sync Record parent: {error}"))
    }

    pub async fn merge_text(&self, source_ids: Vec<String>) -> Result<RecordMergeResult, String> {
        if source_ids.len() < 2 {
            return Err("merge requires at least 2 source records".to_string());
        }
        if source_ids.iter().collect::<HashSet<_>>().len() != source_ids.len() {
            return Err("merge source records must be unique".to_string());
        }
        let snapshots = {
            let inner = self.inner.read().await;
            let mut snapshots = Vec::with_capacity(source_ids.len());
            for id in &source_ids {
                let stored = inner
                    .get(id)
                    .ok_or_else(|| format!("Record not found: {id}"))?;
                if stored.record.kind != RecordKind::Text {
                    return Err(format!("Record is not text: {id}"));
                }
                ensure_plain_directory(&stored.path)
                    .map_err(|error| format!("source {id} unreachable on disk: {error}"))?;
                snapshots.push(stored.clone());
            }
            snapshots
        };

        let mut merged_bodies = Vec::with_capacity(snapshots.len());
        let mut merged_images = Vec::new();
        let mut merged_artifacts = Vec::new();
        let mut artifact_copies = Vec::new();
        for stored in &snapshots {
            let mut body = stored.record.content.clone().unwrap_or_default();
            let mut rewritten_paths = HashMap::new();
            for artifact in &stored.record.artifacts {
                let relative = validate_record_relative_path(&artifact.path)?;
                let source = resolve_plain_record_artifact(&stored.path, &relative)?;
                let tail = relative
                    .strip_prefix("attachments")
                    .unwrap_or(relative.as_path());
                let destination = PathBuf::from("attachments")
                    .join(&stored.record.id)
                    .join(tail);
                let merged_artifact =
                    record_artifact_from_file(&source, &destination, &artifact.kind)?;
                body = body.replace(&artifact.path, &merged_artifact.path);
                rewritten_paths.insert(artifact.path.clone(), merged_artifact.path.clone());
                artifact_copies.push((source, destination));
                merged_artifacts.push(merged_artifact);
            }
            for image in &stored.record.images {
                let rewritten = rewritten_paths
                    .get(image)
                    .ok_or_else(|| format!("Record image is not inventoried: {image}"))?;
                merged_images.push(rewritten.clone());
            }
            merged_bodies.push(body);
        }
        let content = merged_bodies.join("\n—\n");
        let now = now_ms();
        let merged = Record {
            id: Uuid::new_v4().to_string(),
            kind: RecordKind::Text,
            title: derive_text_title(&content),
            tags: dedup_preserving_order(
                snapshots
                    .iter()
                    .flat_map(|stored| stored.record.tags.clone()),
            ),
            created_at: now,
            updated_at: now,
            archived: false,
            converted_task_ids: dedup_preserving_order(
                snapshots
                    .iter()
                    .flat_map(|stored| stored.record.converted_task_ids.clone()),
            ),
            revision: 1,
            audio: None,
            content: Some(content),
            images: dedup_preserving_order(merged_images),
            artifacts: merged_artifacts,
        };
        let merged = self
            .publish_and_insert(merged, None, move |staging| {
                for (source, destination) in &artifact_copies {
                    let bytes = read_bounded_regular_file(source, TEXT_ATTACHMENT_MAX_BYTES)?;
                    write_new_synced_file(&staging.join(destination), &bytes)?;
                }
                Ok(())
            })
            .await?;

        let mut failures = Vec::new();
        for id in source_ids {
            if let Err(error) = self.delete(&id).await {
                failures.push(RecordDeleteFailure { id, error });
            }
        }
        Ok(RecordMergeResult {
            merged,
            failed_source_deletes: failures,
        })
    }
}

fn scan_records(root: &Path) -> HashMap<String, StoredRecord> {
    let mut records = HashMap::new();
    let Ok(months) = fs::read_dir(root) else {
        return records;
    };
    for month in months.flatten() {
        let month_path = month.path();
        if ensure_plain_directory(&month_path).is_err() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&month_path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if ensure_plain_directory(&path).is_err() {
                continue;
            }
            match read_record_directory(&path) {
                Ok(stored) => {
                    if records.contains_key(&stored.record.id) {
                        ulog_warn!("[record] duplicate id ignored: {}", stored.record.id);
                    } else {
                        records.insert(stored.record.id.clone(), stored);
                    }
                }
                Err(error) => ulog_warn!(
                    "[record] skipped invalid directory {}: {}",
                    path.display(),
                    error
                ),
            }
        }
    }
    records
}

fn read_record_directory(path: &Path) -> Result<StoredRecord, String> {
    read_record_directory_inner(path, false)
}

fn read_staged_record_directory(path: &Path) -> Result<StoredRecord, String> {
    read_record_directory_inner(path, true)
}

fn read_record_directory_inner(
    path: &Path,
    allow_staging_name: bool,
) -> Result<StoredRecord, String> {
    ensure_plain_directory(path)?;
    let manifest_path = path.join("record.json");
    let raw = read_bounded_regular_file(&manifest_path, RECORD_MANIFEST_MAX_BYTES)?;
    let mut manifest: RecordManifest =
        serde_json::from_slice(&raw).map_err(|error| format!("parse record.json: {error}"))?;
    if manifest.schema_version != RECORD_SCHEMA_VERSION {
        return Err(format!(
            "unsupported schema version {}",
            manifest.schema_version
        ));
    }
    let directory_name = path.file_name().and_then(|name| name.to_str());
    let name_matches = directory_name == Some(manifest.id.as_str())
        || (allow_staging_name
            && directory_name
                .is_some_and(|name| name.starts_with(&format!(".{}.staging-", manifest.id))));
    if !is_safe_id(&manifest.id) || !name_matches {
        return Err("record id does not match directory".to_string());
    }
    // Audio content.md is a rebuildable projection. A crash can occur after
    // replacing that file but before replacing record.json (or vice versa),
    // so a stale projection must never make the primary Record disappear at
    // startup. Durable source artifacts remain strict; a stale discussion
    // document is dropped from the in-memory inventory and rebuilt on the
    // next source mutation or discussion admission.
    let durable_artifacts = if manifest.kind == RecordKind::Audio {
        manifest
            .artifacts
            .iter()
            .filter(|artifact| artifact.kind != AUDIO_DISCUSSION_DOCUMENT_KIND)
            .cloned()
            .collect::<Vec<_>>()
    } else {
        manifest.artifacts.clone()
    };
    validate_record_artifacts(path, &durable_artifacts, allow_staging_name)?;
    if manifest.kind == RecordKind::Audio {
        let source_revision = manifest.revision;
        let mut seen = false;
        manifest.artifacts.retain(|artifact| {
            if artifact.kind != AUDIO_DISCUSSION_DOCUMENT_KIND {
                return true;
            }
            if seen {
                return false;
            }
            seen = true;
            validate_audio_discussion_document_artifact(path, artifact, source_revision, false)
                .is_ok()
        });
    }
    if !manifest.artifacts.is_empty()
        && manifest.images.iter().any(|image| {
            !manifest
                .artifacts
                .iter()
                .any(|artifact| artifact.path == *image)
        })
    {
        return Err("record image is missing from artifact inventory".to_string());
    }
    let content = match manifest.kind {
        RecordKind::Text => {
            let bytes =
                read_bounded_regular_file(&path.join("content.md"), TEXT_CONTENT_MAX_BYTES)?;
            let content = String::from_utf8(bytes).map_err(|_| "content.md is not UTF-8")?;
            if manifest.content_sha256.as_deref() != Some(sha256_text(&content).as_str()) {
                return Err("content.md digest does not match record.json".to_string());
            }
            Some(content)
        }
        RecordKind::Audio => None,
    };
    let legacy_thought_digest = manifest.legacy_thought_digest.clone();
    Ok(StoredRecord {
        record: manifest.into_record(content),
        path: path.to_path_buf(),
        legacy_thought_digest,
    })
}

fn publish_record_directory<F>(
    root: &Path,
    final_path: &Path,
    record: &Record,
    legacy_digest: Option<String>,
    populate_staging: F,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let month = final_path
        .parent()
        .ok_or_else(|| "record path has no month directory".to_string())?;
    ensure_or_create_plain_directory(root)?;
    if fs::symlink_metadata(month).is_err() {
        fs::create_dir_all(month).map_err(|error| format!("create record month: {error}"))?;
    }
    ensure_plain_directory(month)?;
    let staging = month.join(format!(
        ".{}.staging-{}",
        record.id,
        Uuid::new_v4().simple()
    ));
    fs::create_dir(&staging).map_err(|error| format!("create record staging: {error}"))?;
    let result = (|| {
        if let Some(content) = record.content.as_deref() {
            write_new_synced_file(&staging.join("content.md"), content.as_bytes())?;
        }
        populate_staging(&staging)?;
        let manifest = RecordManifest::from_record(record, legacy_digest);
        let bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| format!("serialize record.json: {error}"))?;
        write_new_synced_file(&staging.join("record.json"), &bytes)?;
        sync_tree_directories(&staging)?;
        let verified = read_staged_record_directory(&staging)?;
        if verified.record != *record {
            return Err("record staging round-trip mismatch".to_string());
        }
        rename_directory_noreplace(&staging, final_path)
            .map_err(|error| format!("publish record directory: {error}"))?;
        sync_directory(month).map_err(|error| format!("sync record month: {error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = remove_plain_record_directory(&staging);
    }
    result
}

fn persist_existing_record(
    path: &Path,
    record: &Record,
    legacy_digest: Option<String>,
    content_changed: bool,
) -> Result<(), String> {
    ensure_plain_directory(path)?;
    if content_changed {
        let content = record
            .content
            .as_deref()
            .ok_or_else(|| "text record content missing".to_string())?;
        write_atomic_replace(&path.join("content.md"), content.as_bytes())?;
    }
    let manifest = RecordManifest::from_record(record, legacy_digest);
    let bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| format!("serialize record.json: {error}"))?;
    write_atomic_replace(&path.join("record.json"), &bytes)
}

fn write_new_synced_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if fs::symlink_metadata(parent).is_err() {
            fs::create_dir_all(parent).map_err(|error| format!("create parent: {error}"))?;
        }
        ensure_plain_directory(parent)?;
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("create {}: {error}", path.display()))?;
    file.write_all(bytes)
        .and_then(|()| file.flush())
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("persist {}: {error}", path.display()))
}

fn write_atomic_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    reject_non_regular_target(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| "atomic target has no parent".to_string())?;
    ensure_plain_directory(parent)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("data");
    let temporary = path.with_extension(format!("{extension}.tmp-{}", Uuid::new_v4().simple()));
    write_new_synced_file(&temporary, bytes)?;
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("commit {}: {error}", path.display()));
    }
    sync_directory(parent).map_err(|error| format!("sync {}: {error}", parent.display()))
}

fn read_bounded_regular_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|error| format!("open {}: {error}", path.display()))?
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    if bytes.len() as u64 > max_bytes {
        return Err(format!("{} exceeds size limit", path.display()));
    }
    Ok(bytes)
}

fn validate_record_artifacts(
    record_dir: &Path,
    artifacts: &[RecordArtifact],
    verify_digest: bool,
) -> Result<(), String> {
    let mut paths = HashSet::new();
    for artifact in artifacts {
        if artifact.kind.trim().is_empty()
            || artifact.sha256.len() != 64
            || !artifact
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || !paths.insert(artifact.path.as_str())
        {
            return Err("record artifact inventory contains an invalid entry".to_string());
        }
        let relative = validate_record_relative_path(&artifact.path)?;
        let path = resolve_plain_record_artifact(record_dir, &relative)?;
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("inspect Record artifact: {error}"))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() != artifact.size_bytes
        {
            return Err(format!("Record artifact is invalid: {}", artifact.path));
        }
        if verify_digest {
            let digest = sha256_regular_file_exact(&path, artifact.size_bytes)?;
            if digest != artifact.sha256 {
                return Err(format!(
                    "Record artifact digest mismatch: {}",
                    artifact.path
                ));
            }
        }
    }
    Ok(())
}

fn validate_audio_discussion_document_artifact(
    record_dir: &Path,
    artifact: &RecordArtifact,
    source_revision: u64,
    verify_digest: bool,
) -> Result<(), String> {
    if artifact.kind != AUDIO_DISCUSSION_DOCUMENT_KIND
        || artifact.path != AUDIO_DISCUSSION_DOCUMENT_PATH
        || artifact.source_revision != Some(source_revision)
        || artifact.size_bytes == 0
        || artifact.size_bytes > AUDIO_DISCUSSION_DOCUMENT_MAX_BYTES
        || artifact.sha256.len() != 64
        || !artifact
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Record discussion document inventory is stale".to_string());
    }
    let path =
        resolve_plain_record_artifact(record_dir, Path::new(AUDIO_DISCUSSION_DOCUMENT_PATH))?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("inspect Record discussion document: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() != artifact.size_bytes
    {
        return Err("Record discussion document is stale".to_string());
    }
    if verify_digest && sha256_regular_file_exact(&path, artifact.size_bytes)? != artifact.sha256 {
        return Err("Record discussion document digest is stale".to_string());
    }
    Ok(())
}

fn validate_speech_provenance(provenance: &RecordSpeechProvenance) -> Result<(), String> {
    for (label, value) in [
        ("provider", provenance.provider.as_str()),
        ("model revision", provenance.model_pack_revision.as_str()),
        ("runtime version", provenance.onnx_runtime_version.as_str()),
    ] {
        if value.is_empty()
            || value.len() > 256
            || value.chars().any(char::is_control)
            || (label == "provider" && value != "local")
        {
            return Err(format!("speech {label} is invalid"));
        }
    }
    Ok(())
}

fn live_segment_id(track: AudioTrackKind, start_sample: u64, end_sample: u64) -> String {
    let track = match track {
        AudioTrackKind::Microphone => "microphone",
        AudioTrackKind::System => "system",
        AudioTrackKind::Mixed => "mixed",
    };
    format!("live-{track}-{start_sample}-{end_sample}")
}

fn valid_speech_error_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 128
        && code
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn validate_live_transcript_segment(
    allowed_tracks: &[AudioTrackKind],
    segment: &RecordTranscriptSegment,
) -> Result<(), String> {
    if segment.segment_id
        != live_segment_id(segment.track, segment.start_sample, segment.end_sample)
        || segment.revision == 0
        || segment.start_sample >= segment.end_sample
        || segment.end_sample > LIVE_TRANSCRIPT_MAX_SAMPLES
        || segment.track == AudioTrackKind::Mixed
        || !allowed_tracks.contains(&segment.track)
        || segment.text.trim().is_empty()
        || segment.text.len() > 64 * 1024
        || segment.text.contains('\0')
        || segment.language.as_deref().is_some_and(|language| {
            language.is_empty()
                || language.len() > 32
                || !language
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
    {
        return Err("live transcript segment is invalid".to_string());
    }
    Ok(())
}

fn project_live_transcript(
    record_id: &str,
    entries: Vec<crate::durable_journal::DurableJournalEntry<RecordTranscriptRevisionEvent>>,
) -> Result<RecordTranscriptSnapshot, String> {
    let projection_revision = entries.last().map_or(0, |entry| entry.seq);
    let mut provenance = None;
    let mut session_tracks = None;
    let mut segments = HashMap::<String, RecordTranscriptSegment>::new();
    let mut characters = 0_usize;
    let mut state = "live".to_string();
    let mut terminal = false;
    for entry in entries {
        if terminal {
            return Err("live transcript contains events after terminal".to_string());
        }
        match entry.event {
            RecordTranscriptRevisionEvent::SessionStarted {
                provenance: started,
                tracks,
            } if provenance.is_none()
                && entry.seq == 1
                && (1..=2).contains(&tracks.len())
                && tracks.iter().all(|track| *track != AudioTrackKind::Mixed)
                && (tracks.len() == 1 || tracks[0] != tracks[1]) =>
            {
                validate_speech_provenance(&started)?;
                provenance = Some(started);
                session_tracks = Some(tracks);
            }
            RecordTranscriptRevisionEvent::SessionStarted { .. } => {
                return Err("live transcript has duplicate session start".to_string())
            }
            RecordTranscriptRevisionEvent::GenerationStarted {
                generation,
                replay_from,
            } => {
                let Some(tracks) = session_tracks.as_ref() else {
                    return Err("live transcript session tracks are missing".to_string());
                };
                if provenance.is_none()
                    || generation == 0
                    || replay_from.len() != tracks.len()
                    || replay_from.iter().any(|offset| {
                        offset.track == AudioTrackKind::Mixed
                            || !tracks.contains(&offset.track)
                            || offset.sample > LIVE_TRANSCRIPT_MAX_SAMPLES
                    })
                    || replay_from.iter().enumerate().any(|(index, offset)| {
                        replay_from[index + 1..]
                            .iter()
                            .any(|other| other.track == offset.track)
                    })
                {
                    return Err("live transcript generation metadata is invalid".to_string());
                }
                state = "recovering".to_string();
            }
            RecordTranscriptRevisionEvent::SegmentUpsert { segment } => {
                let Some(tracks) = session_tracks.as_ref() else {
                    return Err("live transcript segment precedes session start".to_string());
                };
                validate_live_transcript_segment(tracks, &segment)?;
                let old_characters = segments
                    .get(&segment.segment_id)
                    .map_or(0, |existing| existing.text.chars().count());
                if segments
                    .get(&segment.segment_id)
                    .is_some_and(|existing| segment.revision != existing.revision.saturating_add(1))
                    || !segments.contains_key(&segment.segment_id) && segment.revision != 1
                {
                    return Err("live transcript segment revision is invalid".to_string());
                }
                characters = characters
                    .checked_sub(old_characters)
                    .and_then(|count| count.checked_add(segment.text.chars().count()))
                    .filter(|count| *count <= TRANSCRIPT_CHARACTER_LIMIT)
                    .ok_or_else(|| "live transcript character limit exceeded".to_string())?;
                segments.insert(segment.segment_id.clone(), segment);
                if segments.len() > TRANSCRIPT_SEGMENT_LIMIT {
                    return Err("live transcript segment limit exceeded".to_string());
                }
                state = "live".to_string();
            }
            RecordTranscriptRevisionEvent::GenerationFailed {
                generation,
                error_code,
            } => {
                if provenance.is_none() || generation == 0 || !valid_speech_error_code(&error_code)
                {
                    return Err("live transcript failure metadata is invalid".to_string());
                }
                state = "recovering".to_string();
            }
            RecordTranscriptRevisionEvent::SessionFailed { error_code } => {
                if provenance.is_none() || !valid_speech_error_code(&error_code) {
                    return Err("live transcript terminal failure is invalid".to_string());
                }
                state = "failed".to_string();
                terminal = true;
            }
            RecordTranscriptRevisionEvent::SessionFinished => {
                if provenance.is_none() {
                    return Err("live transcript terminal precedes session start".to_string());
                }
                state = "finalizing".to_string();
                terminal = true;
            }
        }
    }
    let provenance =
        provenance.ok_or_else(|| "live transcript session start is missing".to_string())?;
    let mut segments = segments.into_values().collect::<Vec<_>>();
    segments.sort_by(|left, right| {
        (left.start_sample, left.end_sample, left.segment_id.as_str()).cmp(&(
            right.start_sample,
            right.end_sample,
            right.segment_id.as_str(),
        ))
    });
    Ok(RecordTranscriptSnapshot {
        schema_version: 1,
        record_id: record_id.to_string(),
        projection_revision,
        state,
        sample_rate: SPEECH_SAMPLE_RATE as u32,
        provenance,
        segments,
    })
}

fn validate_transcript_segments(
    audio: &AudioRecordSummary,
    segments: &[RecordTranscriptSegment],
) -> Result<(), String> {
    if segments.len() > TRANSCRIPT_SEGMENT_LIMIT {
        return Err("transcript segment count exceeds the fixed limit".to_string());
    }
    let max_sample = record_max_speech_sample(audio)?;
    let mut ids = HashSet::with_capacity(segments.len());
    let mut characters = 0_usize;
    let mut previous_key: Option<(u64, u64, &str)> = None;
    for segment in segments {
        let track_is_valid = audio.tracks.contains(&segment.track)
            || (segment.track == AudioTrackKind::Mixed
                && audio.tracks.contains(&AudioTrackKind::Microphone)
                && audio.tracks.contains(&AudioTrackKind::System));
        if !is_safe_id(&segment.segment_id)
            || !ids.insert(segment.segment_id.as_str())
            || segment.revision == 0
            || segment.start_sample >= segment.end_sample
            || segment.end_sample > max_sample
            || !track_is_valid
            || segment.text.trim().is_empty()
            || segment.text.chars().any(|character| character == '\0')
        {
            return Err("transcript segment inventory is invalid".to_string());
        }
        if segment.language.as_deref().is_some_and(|language| {
            language.is_empty()
                || language.len() > 32
                || !language
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        }) {
            return Err("transcript segment language is invalid".to_string());
        }
        characters = characters
            .checked_add(segment.text.chars().count())
            .ok_or_else(|| "transcript character count overflow".to_string())?;
        if characters > TRANSCRIPT_CHARACTER_LIMIT {
            return Err("transcript character count exceeds the fixed limit".to_string());
        }
        let key = (
            segment.start_sample,
            segment.end_sample,
            segment.segment_id.as_str(),
        );
        if previous_key.is_some_and(|previous| previous > key) {
            return Err("transcript segments are not in stable timeline order".to_string());
        }
        previous_key = Some(key);
    }
    Ok(())
}

fn validate_speaker_turns(
    audio: &AudioRecordSummary,
    turns: &[RecordSpeakerTurn],
) -> Result<(), String> {
    if turns.len() > DIARIZATION_TURN_LIMIT {
        return Err("diarization turn count exceeds the fixed limit".to_string());
    }
    let max_sample = record_max_speech_sample(audio)?;
    let mut previous_key: Option<(u64, u64, u32)> = None;
    for turn in turns {
        if turn.start_sample >= turn.end_sample || turn.end_sample > max_sample {
            return Err("diarization turn inventory is invalid".to_string());
        }
        let key = (turn.start_sample, turn.end_sample, turn.global_speaker);
        if previous_key.is_some_and(|previous| previous > key) {
            return Err("diarization turns are not in stable timeline order".to_string());
        }
        previous_key = Some(key);
    }
    Ok(())
}

fn record_max_speech_sample(audio: &AudioRecordSummary) -> Result<u64, String> {
    // The archive granule is the execution authority; Record metadata is a
    // millisecond projection. One second of tolerance covers that rounding but
    // still rejects corrupt Worker timelines far beyond the durable media.
    audio
        .media_duration_ms
        .checked_mul(SPEECH_SAMPLE_RATE)
        .and_then(|samples_x_ms| samples_x_ms.checked_div(1_000))
        .and_then(|samples| samples.checked_add(SPEECH_SAMPLE_RATE))
        .ok_or_else(|| "Record media duration exceeds speech timeline limits".to_string())
}

fn read_transcript_snapshot(path: &Path) -> Result<RecordTranscriptSnapshot, String> {
    let mut bytes = read_bounded_regular_file(path, TRANSCRIPT_SNAPSHOT_MAX_BYTES)?;
    let parsed = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse transcript snapshot: {error}"));
    bytes.zeroize();
    let snapshot: RecordTranscriptSnapshot = parsed?;
    if snapshot.schema_version != 1
        || snapshot.projection_revision == 0
        || snapshot.state != "recording_final"
        || snapshot.sample_rate != SPEECH_SAMPLE_RATE as u32
        || !is_safe_id(&snapshot.record_id)
    {
        return Err("transcript snapshot identity is invalid".to_string());
    }
    Ok(snapshot)
}

fn read_owned_transcript_snapshot(
    record_id: &str,
    record_path: &Path,
    audio: &AudioRecordSummary,
    artifact: &RecordArtifact,
) -> Result<RecordTranscriptSnapshot, String> {
    if artifact.path != "transcript/snapshot.json" {
        return Err("transcript artifact inventory path is invalid".to_string());
    }
    let relative = validate_record_relative_path(&artifact.path)?;
    let path = resolve_plain_record_artifact(record_path, &relative)?;
    let actual = record_artifact_from_file(&path, &relative, &artifact.kind)?;
    if &actual != artifact {
        return Err("transcript snapshot no longer matches Record inventory".to_string());
    }
    let snapshot = read_transcript_snapshot(&path)?;
    if snapshot.record_id != record_id {
        return Err("transcript snapshot Record identity mismatch".to_string());
    }
    validate_speech_provenance(&snapshot.provenance)?;
    validate_transcript_segments(audio, &snapshot.segments)?;
    Ok(snapshot)
}

fn read_diarization_result(path: &Path) -> Result<RecordDiarizationResult, String> {
    let bytes = read_bounded_regular_file(path, TRANSCRIPT_SNAPSHOT_MAX_BYTES)?;
    let result: RecordDiarizationResult = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse diarization result: {error}"))?;
    if result.schema_version != 1
        || result.projection_revision == 0
        || result.sample_rate != SPEECH_SAMPLE_RATE as u32
        || !is_safe_id(&result.record_id)
    {
        return Err("diarization result identity is invalid".to_string());
    }
    Ok(result)
}

fn model_speaker_ids(model: &RecordDiarizationResult) -> BTreeSet<u32> {
    model.turns.iter().map(|turn| turn.global_speaker).collect()
}

fn resolve_merged_speaker(speaker_id: u32, merges: &BTreeMap<u32, u32>) -> Result<u32, String> {
    let mut current = speaker_id;
    let mut visited = BTreeSet::new();
    while let Some(next) = merges.get(&current).copied() {
        if !visited.insert(current) {
            return Err("Speaker overrides contain a merge cycle".to_string());
        }
        current = next;
    }
    Ok(current)
}

fn read_speaker_overrides(stored: &StoredRecord) -> Result<RecordSpeakerOverrides, String> {
    let path = stored.path.join("diarization/overrides.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RecordSpeakerOverrides::empty(&stored.record.id));
        }
        Err(error) => return Err(format!("inspect speaker overrides: {error}")),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > DIARIZATION_OVERRIDES_MAX_BYTES
    {
        return Err("Record speaker overrides are invalid".to_string());
    }
    let bytes = fs::read(&path).map_err(|error| format!("read speaker overrides: {error}"))?;
    let overrides: RecordSpeakerOverrides = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse speaker overrides: {error}"))?;
    if overrides.schema_version != 1 || overrides.record_id != stored.record.id {
        return Err("Record speaker override identity mismatch".to_string());
    }
    Ok(overrides)
}

fn write_speaker_overrides(
    stored: &StoredRecord,
    overrides: &RecordSpeakerOverrides,
) -> Result<(), String> {
    if overrides.record_id != stored.record.id || overrides.schema_version != 1 {
        return Err("Record speaker override identity mismatch".to_string());
    }
    let bytes = serde_json::to_vec_pretty(overrides)
        .map_err(|error| format!("serialize speaker overrides: {error}"))?;
    if bytes.is_empty() || bytes.len() as u64 > DIARIZATION_OVERRIDES_MAX_BYTES {
        return Err("Record speaker overrides exceed the fixed size limit".to_string());
    }
    let content = std::str::from_utf8(&bytes)
        .map_err(|_| "speaker override serialization is not UTF-8".to_string())?;
    crate::task::write_atomic_text(&stored.path.join("diarization/overrides.json"), content)
}

fn read_current_transcript(
    stored: &StoredRecord,
) -> Result<Option<RecordTranscriptSnapshot>, String> {
    let Some(audio) = stored.record.audio.as_ref() else {
        return Err(format!("Record is not audio: {}", stored.record.id));
    };
    if let Some(artifact) = stored
        .record
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == "transcript/recording-final+json")
    {
        return read_owned_transcript_snapshot(&stored.record.id, &stored.path, audio, artifact)
            .map(Some);
    }
    let path = stored.path.join("transcript/revisions.jsonl");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("inspect live transcript journal: {error}")),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > TRANSCRIPT_REVISION_MAX_BYTES
    {
        return Err("live transcript revision journal is invalid".to_string());
    }
    let (entries, _) = read_valid_prefix::<RecordTranscriptRevisionEvent>(
        &path,
        &stored.record.id,
        TRANSCRIPT_REVISION_SCHEMA_VERSION,
        TRANSCRIPT_REVISION_MAX_LINE_BYTES,
    )?;
    project_live_transcript(&stored.record.id, entries).map(Some)
}

fn read_diarization_projection_for_stored(
    stored: &StoredRecord,
) -> Result<Option<RecordDiarizationProjection>, String> {
    if stored.record.kind != RecordKind::Audio {
        return Err(format!("Record is not audio: {}", stored.record.id));
    }
    let audio = stored
        .record
        .audio
        .as_ref()
        .ok_or_else(|| format!("audio Record summary missing: {}", stored.record.id))?;
    let Some(artifact) = stored
        .record
        .artifacts
        .iter()
        .find(|artifact| artifact.kind == "diarization/model-projection+json")
    else {
        return Ok(None);
    };
    let model = read_owned_diarization_result(&stored.record.id, &stored.path, audio, artifact)?;
    let overrides = read_speaker_overrides(stored)?;
    project_diarization(stored, model, overrides).map(Some)
}

fn base_record_search_document(stored: &StoredRecord) -> RecordSearchDocument {
    let mut content = stored.record.content.clone().unwrap_or_default();
    for image in &stored.record.images {
        content = content.replace(image, "");
    }
    RecordSearchDocument {
        record_id: stored.record.id.clone(),
        kind: stored.record.kind,
        title: stored.record.title.clone(),
        tags: stored.record.tags.clone(),
        content,
        media_ms: None,
    }
}

fn build_record_search_documents(
    stored: &StoredRecord,
) -> Result<Vec<RecordSearchDocument>, String> {
    let mut documents = vec![base_record_search_document(stored)];
    if stored.record.kind != RecordKind::Audio {
        return Ok(documents);
    }
    let _audio = stored
        .record
        .audio
        .as_ref()
        .ok_or_else(|| format!("audio Record summary missing: {}", stored.record.id))?;
    let transcript = read_current_transcript(stored)?;
    let diarization = read_diarization_projection_for_stored(stored)?;
    if let Some(transcript) = transcript.as_ref() {
        for segment in &transcript.segments {
            let speaker_terms = export_speaker_label(segment, diarization.as_ref());
            documents.push(RecordSearchDocument {
                record_id: stored.record.id.clone(),
                kind: RecordKind::Audio,
                title: stored.record.title.clone(),
                tags: stored.record.tags.clone(),
                content: format!("{speaker_terms}\n{}", segment.text),
                media_ms: Some(
                    segment.start_sample.saturating_mul(1_000) / transcript.sample_rate as u64,
                ),
            });
        }
    }
    for item in read_timeline_projection(stored)?.items {
        if let RecordTimelineItem::Note {
            anchor_media_ms,
            text,
            ..
        } = item
        {
            documents.push(RecordSearchDocument {
                record_id: stored.record.id.clone(),
                kind: RecordKind::Audio,
                title: stored.record.title.clone(),
                tags: stored.record.tags.clone(),
                content: text,
                media_ms: Some(anchor_media_ms),
            });
        }
    }
    Ok(documents)
}

fn project_diarization(
    stored: &StoredRecord,
    model: RecordDiarizationResult,
    overrides: RecordSpeakerOverrides,
) -> Result<RecordDiarizationProjection, String> {
    let speaker_ids = model_speaker_ids(&model);
    let transcript_segment_ids = read_current_transcript(stored)?
        .map(|snapshot| {
            snapshot
                .segments
                .iter()
                .map(|segment| segment.segment_id.clone())
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    let mut conflicts = Vec::new();
    let mut speakers = Vec::with_capacity(speaker_ids.len());
    for speaker_id in speaker_ids.iter().copied() {
        let custom_name = overrides.renames.get(&speaker_id).cloned();
        let merged_into = match overrides.merges.get(&speaker_id).copied() {
            Some(target) if speaker_ids.contains(&target) => {
                match resolve_merged_speaker(target, &overrides.merges) {
                    Ok(canonical) if speaker_ids.contains(&canonical) => Some(canonical),
                    _ => {
                        conflicts.push(RecordSpeakerOverrideConflict {
                            kind: "merge".to_string(),
                            target_id: speaker_id.to_string(),
                        });
                        None
                    }
                }
            }
            Some(_) => {
                conflicts.push(RecordSpeakerOverrideConflict {
                    kind: "merge".to_string(),
                    target_id: speaker_id.to_string(),
                });
                None
            }
            None => None,
        };
        speakers.push(RecordSpeakerProjection {
            speaker_id,
            custom_name,
            merged_into,
        });
    }
    for speaker_id in overrides.renames.keys() {
        if !speaker_ids.contains(speaker_id) {
            conflicts.push(RecordSpeakerOverrideConflict {
                kind: "rename".to_string(),
                target_id: speaker_id.to_string(),
            });
        }
    }
    let mut segment_speaker_overrides = BTreeMap::new();
    for (segment_id, speaker_id) in &overrides.reassignments {
        let resolved = resolve_merged_speaker(*speaker_id, &overrides.merges);
        match resolved {
            Ok(resolved)
                if transcript_segment_ids.contains(segment_id)
                    && speaker_ids.contains(&resolved) =>
            {
                segment_speaker_overrides.insert(segment_id.clone(), resolved);
            }
            _ => conflicts.push(RecordSpeakerOverrideConflict {
                kind: "reassign".to_string(),
                target_id: segment_id.clone(),
            }),
        }
    }
    conflicts.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.target_id.cmp(&right.target_id))
    });
    Ok(RecordDiarizationProjection {
        schema_version: model.schema_version,
        record_id: model.record_id,
        projection_revision: model.projection_revision,
        sample_rate: model.sample_rate,
        provenance: model.provenance,
        turns: model.turns,
        override_revision: overrides.revision,
        speakers,
        segment_speaker_overrides,
        conflicts,
    })
}

fn read_owned_diarization_result(
    record_id: &str,
    record_path: &Path,
    audio: &AudioRecordSummary,
    artifact: &RecordArtifact,
) -> Result<RecordDiarizationResult, String> {
    if artifact.path != "diarization/result.json" {
        return Err("diarization artifact inventory path is invalid".to_string());
    }
    let relative = validate_record_relative_path(&artifact.path)?;
    let path = resolve_plain_record_artifact(record_path, &relative)?;
    let actual = record_artifact_from_file(&path, &relative, &artifact.kind)?;
    if &actual != artifact {
        return Err("diarization result no longer matches Record inventory".to_string());
    }
    let result = read_diarization_result(&path)?;
    if result.record_id != record_id {
        return Err("diarization result Record identity mismatch".to_string());
    }
    validate_speech_provenance(&result.provenance)?;
    validate_speaker_turns(audio, &result.turns)?;
    Ok(result)
}

fn replace_record_artifact(
    artifacts: &mut Vec<RecordArtifact>,
    replacement: RecordArtifact,
    kind: &str,
) {
    artifacts.retain(|artifact| artifact.kind != kind);
    artifacts.push(replacement);
}

fn record_artifact_from_file(
    source: &Path,
    destination: &Path,
    kind: &str,
) -> Result<RecordArtifact, String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("inspect Record artifact source: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Record artifact source is not a regular file".to_string());
    }
    let path = path_to_forward_slashes(destination)?;
    Ok(RecordArtifact {
        kind: kind.to_string(),
        path,
        size_bytes: metadata.len(),
        sha256: sha256_regular_file_exact(source, metadata.len())?,
        source_revision: None,
    })
}

fn sha256_regular_file_exact(path: &Path, expected_size: u64) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("open artifact: {error}"))?;
    let mut hasher = Sha256::new();
    let mut read_bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let remaining = expected_size.saturating_add(1).saturating_sub(read_bytes);
        if remaining == 0 {
            break;
        }
        let read_limit = remaining.min(buffer.len() as u64) as usize;
        let count = file
            .read(&mut buffer[..read_limit])
            .map_err(|error| format!("read artifact: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        read_bytes = read_bytes.saturating_add(count as u64);
    }
    if read_bytes != expected_size {
        return Err("Record artifact size changed while reading".to_string());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn validate_record_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("Record artifact path is unsafe: {value}"));
    }
    Ok(path.to_path_buf())
}

fn resolve_plain_record_artifact(record_dir: &Path, relative: &Path) -> Result<PathBuf, String> {
    ensure_plain_directory(record_dir)?;
    let mut current = record_dir.to_path_buf();
    let component_count = relative.components().count();
    for (index, component) in relative.components().enumerate() {
        let Component::Normal(name) = component else {
            return Err("Record artifact path is unsafe".to_string());
        };
        current.push(name);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("inspect Record artifact path: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("Record artifact path contains a symlink".to_string());
        }
        if index + 1 < component_count && !metadata.is_dir() {
            return Err("Record artifact parent is not a directory".to_string());
        }
    }
    let metadata = fs::symlink_metadata(&current)
        .map_err(|error| format!("inspect Record artifact: {error}"))?;
    if !metadata.is_file() {
        return Err("Record artifact is not a regular file".to_string());
    }
    Ok(current)
}

fn reject_non_regular_target(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(format!("{} is not a regular file", path.display()))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("inspect {}: {error}", path.display())),
    }
}

fn ensure_plain_directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{} is not a plain directory", path.display()));
    }
    Ok(())
}

fn ensure_or_create_plain_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => ensure_plain_directory(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path)
                .map_err(|error| format!("create {}: {error}", path.display()))?;
            ensure_plain_directory(path)
        }
        Err(error) => Err(format!("inspect {}: {error}", path.display())),
    }
}

fn sync_tree_directories(root: &Path) -> Result<(), String> {
    fn visit(path: &Path) -> Result<(), String> {
        for entry in fs::read_dir(path).map_err(|error| format!("scan staging: {error}"))? {
            let entry = entry.map_err(|error| format!("scan staging entry: {error}"))?;
            let child = entry.path();
            let metadata = fs::symlink_metadata(&child)
                .map_err(|error| format!("inspect staging child: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err("record staging contains a symlink".to_string());
            }
            if metadata.is_dir() {
                visit(&child)?;
            }
        }
        sync_directory(path).map_err(|error| format!("sync staging directory: {error}"))
    }
    visit(root)
}

fn remove_plain_record_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => Err(format!(
            "refusing to remove non-directory {}",
            path.display()
        )),
        Ok(_) => fs::remove_dir_all(path).map_err(|error| format!("remove record: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("inspect record directory: {error}")),
    }
}

fn record_path(root: &Path, record: &Record) -> PathBuf {
    let date = DateTime::<Utc>::from_timestamp_millis(record.created_at).unwrap_or_else(Utc::now);
    root.join(format!("{:04}-{:02}", date.year(), date.month()))
        .join(&record.id)
}

fn ensure_audio_record(stored: &StoredRecord, id: &str) -> Result<(), String> {
    if stored.record.kind != RecordKind::Audio || stored.record.audio.is_none() {
        return Err(format!("Record is not audio: {id}"));
    }
    ensure_plain_directory(&stored.path)
}

fn validate_timeline_operation_id(operation_id: &str) -> Result<(), String> {
    Uuid::parse_str(operation_id)
        .map(|_| ())
        .map_err(|_| "Record timeline operation ID is invalid".to_string())
}

fn validate_timeline_media_ms(media_ms: u64) -> Result<(), String> {
    let max_media_ms = LIVE_TRANSCRIPT_MAX_SAMPLES
        .saturating_mul(1_000)
        .checked_div(SPEECH_SAMPLE_RATE)
        .unwrap_or(0);
    if media_ms > max_media_ms {
        return Err("Record timeline media time exceeds limit".to_string());
    }
    Ok(())
}

fn read_timeline_entries(
    stored: &StoredRecord,
) -> Result<Vec<crate::durable_journal::DurableJournalEntry<RecordTimelineEvent>>, String> {
    let path = stored.path.join("timeline.jsonl");
    let metadata =
        fs::symlink_metadata(&path).map_err(|error| format!("inspect Record timeline: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > TIMELINE_MAX_BYTES
    {
        return Err("Record timeline is invalid".to_string());
    }
    recover_and_read(
        &path,
        &stored.record.id,
        TIMELINE_SCHEMA_VERSION,
        TIMELINE_MAX_LINE_BYTES,
    )
}

fn ensure_timeline_append_budget(path: &Path, entry_count: usize) -> Result<(), String> {
    if entry_count >= TIMELINE_ITEM_LIMIT {
        return Err("Record timeline item limit exceeded".to_string());
    }
    let size = fs::symlink_metadata(path)
        .map_err(|error| format!("inspect Record timeline: {error}"))?
        .len();
    if size > TIMELINE_MAX_BYTES.saturating_sub(TIMELINE_MAX_LINE_BYTES as u64) {
        return Err("Record timeline size limit exceeded".to_string());
    }
    Ok(())
}

fn read_timeline_projection(stored: &StoredRecord) -> Result<RecordTimelineProjection, String> {
    project_timeline(&stored.record, read_timeline_entries(stored)?)
}

fn project_timeline(
    record: &Record,
    entries: Vec<crate::durable_journal::DurableJournalEntry<RecordTimelineEvent>>,
) -> Result<RecordTimelineProjection, String> {
    if entries.len() > TIMELINE_ITEM_LIMIT {
        return Err("Record timeline item limit exceeded".to_string());
    }
    let mut notes = HashMap::<String, RecordTimelineItem>::new();
    let mut marks = HashMap::<String, RecordTimelineItem>::new();
    for entry in entries {
        match entry.event {
            RecordTimelineEvent::NoteCreated {
                note_id,
                anchor_media_ms,
                started_at_wall_time,
                submitted_at_wall_time,
                text,
                ..
            } => {
                if notes.contains_key(&note_id) {
                    return Err("Record timeline contains a duplicate note".to_string());
                }
                notes.insert(
                    note_id.clone(),
                    RecordTimelineItem::Note {
                        seq: entry.seq,
                        note_id,
                        anchor_media_ms,
                        started_at_wall_time,
                        submitted_at_wall_time,
                        text,
                    },
                );
            }
            RecordTimelineEvent::MarkCreated {
                mark_id,
                media_ms,
                wall_time,
                kind,
                ..
            } => {
                if marks.contains_key(&mark_id) {
                    return Err("Record timeline contains a duplicate mark".to_string());
                }
                marks.insert(
                    mark_id.clone(),
                    RecordTimelineItem::Mark {
                        seq: entry.seq,
                        mark_id,
                        media_ms,
                        wall_time,
                        kind,
                    },
                );
            }
            RecordTimelineEvent::NoteUpdated { note_id, text, .. } => {
                let Some(RecordTimelineItem::Note {
                    text: current_text, ..
                }) = notes.get_mut(&note_id)
                else {
                    return Err("Record timeline updates an unknown note".to_string());
                };
                *current_text = text;
            }
            RecordTimelineEvent::NoteDeleted { note_id, .. } => {
                if notes.remove(&note_id).is_none() {
                    return Err("Record timeline deletes an unknown note".to_string());
                }
            }
            RecordTimelineEvent::MarkDeleted { mark_id, .. } => {
                if marks.remove(&mark_id).is_none() {
                    return Err("Record timeline deletes an unknown mark".to_string());
                }
            }
        }
    }
    let mut items = Vec::with_capacity(notes.len() + marks.len());
    items.extend(notes.into_values());
    items.extend(marks.into_values());
    items.sort_by_key(|item| match item {
        RecordTimelineItem::Note {
            seq,
            anchor_media_ms,
            ..
        } => (*anchor_media_ms, *seq),
        RecordTimelineItem::Mark { seq, media_ms, .. } => (*media_ms, *seq),
    });
    Ok(RecordTimelineProjection {
        record_id: record.id.clone(),
        revision: record.revision,
        items,
    })
}

fn touch_timeline_record(stored: &StoredRecord) -> Result<Record, String> {
    let mut updated = stored.record.clone();
    updated.updated_at = now_ms();
    updated.revision = updated.revision.saturating_add(1);
    persist_existing_record(
        &stored.path,
        &updated,
        stored.legacy_thought_digest.clone(),
        false,
    )?;
    Ok(updated)
}

fn audio_discussion_document_allowed(record: &Record) -> bool {
    record.kind == RecordKind::Audio
        && record.audio.as_ref().is_some_and(|audio| {
            matches!(
                audio.capture_status,
                CaptureStatus::Ready | CaptureStatus::Interrupted
            )
        })
        && record
            .artifacts
            .iter()
            .any(|artifact| artifact.kind == "audio/ogg-opus" && artifact.size_bytes > 0)
}

fn audio_discussion_audio_present(record_path: &Path, record: &Record) -> bool {
    record.artifacts.iter().any(|artifact| {
        if artifact.kind != "audio/ogg-opus" || artifact.size_bytes == 0 {
            return false;
        }
        let Ok(path) = resolve_plain_record_artifact(record_path, Path::new(&artifact.path)) else {
            return false;
        };
        fs::symlink_metadata(path).is_ok_and(|metadata| {
            !metadata.file_type().is_symlink()
                && metadata.is_file()
                && metadata.len() == artifact.size_bytes
        })
    })
}

fn rebuild_audio_discussion_document(
    stored: &StoredRecord,
    record: Record,
) -> Result<Record, String> {
    if !audio_discussion_document_allowed(&record) {
        return Err("audio Record has not been stopped and saved".to_string());
    }
    let render_source = StoredRecord {
        record: record.clone(),
        path: stored.path.clone(),
        legacy_thought_digest: stored.legacy_thought_digest.clone(),
    };
    let content =
        render_record_text_export(&render_source, RecordTextExportFormat::Markdown, "en-US")?;
    if content.is_empty() || content.len() as u64 > AUDIO_DISCUSSION_DOCUMENT_MAX_BYTES {
        return Err("Record discussion document exceeds the fixed size limit".to_string());
    }
    let relative = PathBuf::from(AUDIO_DISCUSSION_DOCUMENT_PATH);
    let document_path = stored.path.join(&relative);
    write_atomic_replace(&document_path, content.as_bytes())?;
    let mut artifact =
        record_artifact_from_file(&document_path, &relative, AUDIO_DISCUSSION_DOCUMENT_KIND)?;
    artifact.source_revision = Some(record.revision);

    let mut updated = record;
    replace_record_artifact(
        &mut updated.artifacts,
        artifact,
        AUDIO_DISCUSSION_DOCUMENT_KIND,
    );
    persist_existing_record(
        &stored.path,
        &updated,
        stored.legacy_thought_digest.clone(),
        false,
    )?;
    Ok(updated)
}

fn refresh_audio_discussion_document_best_effort(stored: &StoredRecord, record: Record) -> Record {
    if !audio_discussion_document_allowed(&record) {
        return record;
    }
    match rebuild_audio_discussion_document(stored, record.clone()) {
        Ok(updated) => updated,
        Err(error) => {
            ulog_warn!(
                "[record] discussion document refresh deferred recordId={} revision={} error={}",
                record.id,
                record.revision,
                error
            );
            record
        }
    }
}

fn validate_new_export_destination(raw: &str, extension: &str) -> Result<PathBuf, String> {
    let destination = crate::workspace_files::attachment_export::validate_export_destination(raw)?;
    if destination
        .extension()
        .and_then(|value| value.to_str())
        .map_or(true, |value| !value.eq_ignore_ascii_case(extension))
    {
        return Err(format!(
            "Record export destination must end with .{extension}"
        ));
    }
    match fs::symlink_metadata(&destination) {
        Ok(_) => Err("RECORD_EXPORT_DESTINATION_EXISTS".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(destination),
        Err(error) => Err(format!("inspect Record export destination: {error}")),
    }
}

fn write_bytes_noreplace(destination: &Path, bytes: &[u8]) -> Result<u64, String> {
    let mut destination_file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "RECORD_EXPORT_DESTINATION_EXISTS".to_string()
            } else {
                format!("create Record export: {error}")
            }
        })?;
    if let Err(error) = destination_file
        .write_all(bytes)
        .and_then(|()| destination_file.flush())
        .and_then(|()| destination_file.sync_all())
    {
        drop(destination_file);
        let _ = fs::remove_file(destination);
        return Err(format!("write Record export: {error}"));
    }
    drop(destination_file);
    if let Some(parent) = destination.parent() {
        sync_directory(parent).map_err(|error| format!("sync Record export directory: {error}"))?;
    }
    Ok(bytes.len() as u64)
}

fn copy_regular_file_noreplace(
    source: &Path,
    destination: &Path,
    expected_bytes: u64,
) -> Result<u64, String> {
    let mut source_file =
        File::open(source).map_err(|error| format!("open Record audio: {error}"))?;
    let mut destination_file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "RECORD_EXPORT_DESTINATION_EXISTS".to_string()
            } else {
                format!("create Record audio export: {error}")
            }
        })?;
    let result = std::io::copy(
        &mut std::io::Read::by_ref(&mut source_file).take(expected_bytes.saturating_add(1)),
        &mut destination_file,
    )
    .and_then(|bytes| {
        if bytes != expected_bytes {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Record audio size changed during export",
            ));
        }
        destination_file.flush()?;
        destination_file.sync_all()?;
        Ok(bytes)
    });
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(error) => {
            drop(destination_file);
            let _ = fs::remove_file(destination);
            return Err(format!("copy Record audio export: {error}"));
        }
    };
    drop(destination_file);
    if let Some(parent) = destination.parent() {
        sync_directory(parent).map_err(|error| format!("sync Record export directory: {error}"))?;
    }
    Ok(bytes)
}

fn export_duration(media_ms: u64) -> String {
    let total_seconds = media_ms / 1_000;
    let hours = total_seconds / 3_600;
    let minutes = (total_seconds % 3_600) / 60;
    let seconds = total_seconds % 60;
    if hours > 0 {
        format!("{hours:02}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

fn export_speaker_label(
    segment: &RecordTranscriptSegment,
    diarization: Option<&RecordDiarizationProjection>,
) -> String {
    let middle = segment
        .start_sample
        .saturating_add(segment.end_sample.saturating_sub(segment.start_sample) / 2);
    let mut speaker_id = diarization
        .and_then(|projection| {
            projection
                .segment_speaker_overrides
                .get(&segment.segment_id)
                .copied()
        })
        .or_else(|| {
            diarization.and_then(|projection| {
                projection
                    .turns
                    .iter()
                    .find(|turn| turn.start_sample <= middle && turn.end_sample >= middle)
                    .map(|turn| turn.global_speaker)
            })
        })
        .unwrap_or(0);
    if let Some(projection) = diarization {
        let mut visited = BTreeSet::new();
        while visited.insert(speaker_id) {
            let Some(next) = projection
                .speakers
                .iter()
                .find(|speaker| speaker.speaker_id == speaker_id)
                .and_then(|speaker| speaker.merged_into)
            else {
                break;
            };
            speaker_id = next;
        }
        if let Some(name) = projection
            .speakers
            .iter()
            .find(|speaker| speaker.speaker_id == speaker_id)
            .and_then(|speaker| speaker.custom_name.as_ref())
        {
            return name.clone();
        }
    }
    format!("Speaker {}", speaker_letter_for_export(speaker_id))
}

fn speaker_letter_for_export(mut index: u32) -> String {
    let mut bytes = Vec::new();
    loop {
        bytes.push(b'A' + (index % 26) as u8);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    bytes.reverse();
    String::from_utf8(bytes).unwrap_or_else(|_| "A".to_string())
}

fn render_record_text_export(
    stored: &StoredRecord,
    format: RecordTextExportFormat,
    locale: &str,
) -> Result<String, String> {
    let zh = locale == "zh-CN";
    let transcript = read_current_transcript(stored)?;
    let diarization = read_diarization_projection_for_stored(stored)?;
    let timeline = read_timeline_projection(stored)?;
    let audio = stored
        .record
        .audio
        .as_ref()
        .ok_or_else(|| format!("Record is not audio: {}", stored.record.id))?;
    let title = stored.record.title.replace('\r', " ").replace('\n', " ");
    let created = DateTime::<Utc>::from_timestamp_millis(stored.record.created_at)
        .map(|value| value.to_rfc3339())
        .unwrap_or_else(|| stored.record.created_at.to_string());
    let tracks = audio
        .tracks
        .iter()
        .map(|track| match track {
            AudioTrackKind::Microphone => {
                if zh {
                    "麦克风"
                } else {
                    "Microphone"
                }
            }
            AudioTrackKind::System => {
                if zh {
                    "系统声音"
                } else {
                    "System audio"
                }
            }
            AudioTrackKind::Mixed => {
                if zh {
                    "混合"
                } else {
                    "Mixed"
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" · ");
    let tags = stored
        .record
        .tags
        .iter()
        .map(|tag| format!("#{tag}"))
        .collect::<Vec<_>>()
        .join(" ");
    let status = if matches!(audio.capture_status, CaptureStatus::Interrupted) {
        if zh {
            "录音中断"
        } else {
            "Recording interrupted"
        }
    } else if matches!(audio.capture_status, CaptureStatus::Failed)
        || matches!(audio.transcription_status, TranscriptionStatus::Failed)
        || matches!(audio.diarization_status, DiarizationStatus::Failed)
    {
        if zh {
            "处理失败"
        } else {
            "Processing failed"
        }
    } else if matches!(
        audio.transcription_status,
        TranscriptionStatus::Queued
            | TranscriptionStatus::Live
            | TranscriptionStatus::Lagging
            | TranscriptionStatus::Recovering
            | TranscriptionStatus::Finalizing
    ) || matches!(
        audio.diarization_status,
        DiarizationStatus::Queued | DiarizationStatus::Running
    ) {
        if zh {
            "处理中"
        } else {
            "Processing"
        }
    } else {
        if zh {
            "已完成"
        } else {
            "Complete"
        }
    };
    let duration = export_duration(audio.media_duration_ms);
    let mut output = String::new();
    match format {
        RecordTextExportFormat::Markdown => {
            writeln!(output, "# {title}\n").map_err(|error| error.to_string())?;
            writeln!(output, "- {}: {created}", if zh { "日期" } else { "Date" })
                .map_err(|error| error.to_string())?;
            writeln!(output, "- {}: {status}", if zh { "状态" } else { "Status" })
                .map_err(|error| error.to_string())?;
            writeln!(
                output,
                "- {}: {duration}",
                if zh { "时长" } else { "Duration" }
            )
            .map_err(|error| error.to_string())?;
            writeln!(output, "- {}: {tracks}", if zh { "音轨" } else { "Tracks" })
                .map_err(|error| error.to_string())?;
            if !tags.is_empty() {
                writeln!(output, "- {}: {tags}", if zh { "标签" } else { "Tags" })
                    .map_err(|error| error.to_string())?;
            }
            writeln!(output).map_err(|error| error.to_string())?;
            writeln!(output, "## {}\n", if zh { "转写" } else { "Transcript" })
                .map_err(|error| error.to_string())?;
        }
        RecordTextExportFormat::Text => {
            writeln!(output, "{title}").map_err(|error| error.to_string())?;
            writeln!(output, "{}: {created}", if zh { "日期" } else { "Date" })
                .map_err(|error| error.to_string())?;
            writeln!(output, "{}: {status}", if zh { "状态" } else { "Status" })
                .map_err(|error| error.to_string())?;
            writeln!(
                output,
                "{}: {duration}",
                if zh { "时长" } else { "Duration" }
            )
            .map_err(|error| error.to_string())?;
            writeln!(output, "{}: {tracks}", if zh { "音轨" } else { "Tracks" })
                .map_err(|error| error.to_string())?;
            if !tags.is_empty() {
                writeln!(output, "{}: {tags}", if zh { "标签" } else { "Tags" })
                    .map_err(|error| error.to_string())?;
            }
            writeln!(output).map_err(|error| error.to_string())?;
            writeln!(output, "{}", if zh { "转写" } else { "Transcript" })
                .map_err(|error| error.to_string())?;
        }
    }
    if let Some(transcript) = transcript.as_ref() {
        for segment in &transcript.segments {
            let media_ms =
                segment.start_sample.saturating_mul(1_000) / transcript.sample_rate as u64;
            let speaker = export_speaker_label(segment, diarization.as_ref());
            match format {
                RecordTextExportFormat::Markdown => writeln!(
                    output,
                    "- [{}] **{}**: {}",
                    export_duration(media_ms),
                    speaker,
                    segment.text
                ),
                RecordTextExportFormat::Text => writeln!(
                    output,
                    "[{}] {}: {}",
                    export_duration(media_ms),
                    speaker,
                    segment.text
                ),
            }
            .map_err(|error| error.to_string())?;
        }
    }
    let notes_heading = if zh {
        "笔记与重点"
    } else {
        "Notes and highlights"
    };
    match format {
        RecordTextExportFormat::Markdown => {
            writeln!(output, "\n## {notes_heading}\n").map_err(|error| error.to_string())?;
        }
        RecordTextExportFormat::Text => {
            writeln!(output, "\n{notes_heading}").map_err(|error| error.to_string())?;
        }
    }
    for item in timeline.items {
        let (media_ms, text) = match item {
            RecordTimelineItem::Note {
                anchor_media_ms,
                text,
                ..
            } => (anchor_media_ms, text),
            RecordTimelineItem::Mark { media_ms, .. } => (
                media_ms,
                if zh { "标记重点" } else { "Highlight" }.to_string(),
            ),
        };
        writeln!(output, "- [{}] {}", export_duration(media_ms), text)
            .map_err(|error| error.to_string())?;
    }
    Ok(output)
}

fn normalize_audio_tags(tags: Vec<String>) -> Result<Vec<String>, String> {
    if tags.len() > 32 {
        return Err("audio Record tag limit exceeded".to_string());
    }
    let mut normalized = Vec::new();
    for raw in tags {
        let tag = raw.trim().trim_start_matches('#');
        if tag.is_empty() || tag.chars().count() > 32 || !tag.chars().all(is_tag_char) {
            return Err("audio Record tag is invalid".to_string());
        }
        if !normalized.iter().any(|existing| existing == tag) {
            normalized.push(tag.to_string());
        }
    }
    Ok(normalized)
}

pub fn derive_text_title(content: &str) -> String {
    let Some(line) = content.lines().find(|line| !line.trim().is_empty()) else {
        return String::new();
    };
    let trimmed = line.trim();
    let heading_markers = trimmed
        .chars()
        .take_while(|character| *character == '#')
        .count();
    let without_heading = if (1..=6).contains(&heading_markers)
        && trimmed[heading_markers..]
            .chars()
            .next()
            .is_some_and(char::is_whitespace)
    {
        trimmed[heading_markers..].trim_start()
    } else {
        trimmed
    };
    without_heading.chars().take(80).collect()
}

pub fn parse_tags(content: &str) -> Vec<String> {
    let chars: Vec<char> = content.chars().collect();
    let mut tags = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '#' {
            index += 1;
            continue;
        }
        if index > 0 && is_tag_char(chars[index - 1]) {
            index += 1;
            continue;
        }
        let mut end = index + 1;
        while end < chars.len() && is_tag_char(chars[end]) {
            end += 1;
        }
        if end > index + 1 {
            let tag: String = chars[index + 1..end].iter().collect();
            if !tags.iter().any(|existing| existing == &tag) {
                tags.push(tag);
            }
        }
        index = end.max(index + 1);
    }
    tags
}

fn is_tag_char(character: char) -> bool {
    character.is_alphanumeric()
        || character == '_'
        || ('\u{4e00}'..='\u{9fff}').contains(&character)
}

fn sha256_text(content: &str) -> String {
    sha256_bytes(content.as_bytes())
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn dedup_preserving_order<I>(values: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn dedup_audio_tracks(values: Vec<AudioTrackKind>) -> Vec<AudioTrackKind> {
    let mut output = Vec::with_capacity(values.len());
    for value in values {
        if !output.contains(&value) {
            output.push(value);
        }
    }
    output
}

pub(crate) fn audio_track_relative_path(track: AudioTrackKind) -> String {
    let filename = match track {
        AudioTrackKind::Microphone => "microphone.opus",
        AudioTrackKind::System => "system.opus",
        AudioTrackKind::Mixed => "mixed.opus",
    };
    format!("audio/{filename}")
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

#[derive(Debug)]
struct LegacyThought {
    id: String,
    content: String,
    tags: Vec<String>,
    images: Vec<String>,
    created_at: i64,
    updated_at: i64,
    converted_task_ids: Vec<String>,
    archived: bool,
}

fn migrate_legacy_thoughts(record_root: &Path, legacy_root: &Path) {
    if fs::symlink_metadata(legacy_root).is_err() {
        return;
    }
    if ensure_plain_directory(legacy_root).is_err() {
        ulog_warn!("[record-migration] legacy root is not a plain directory");
        return;
    }
    let lock_path = record_root.join(".thought-migration.lock");
    let result = with_file_lock_blocking(&lock_path, FileLockOptions::default(), || {
        migrate_legacy_thoughts_locked(record_root, legacy_root)
            .map_err(|error| FileLockError::Io(std::io::Error::other(error)))
    });
    if let Err(error) = result {
        ulog_warn!("[record-migration] startup migration deferred: {}", error);
    }
}

fn migrate_legacy_thoughts_locked(record_root: &Path, legacy_root: &Path) -> Result<(), String> {
    let sources = collect_legacy_thought_files(legacy_root)?;
    if sources.is_empty() {
        return Ok(());
    }
    let canonical = scan_records(record_root);
    let mut all_succeeded = true;
    let mut cleanup_attachments = HashSet::new();
    for source in &sources {
        match migrate_one_legacy_thought(record_root, legacy_root, source, &canonical) {
            Ok(attachments) => cleanup_attachments.extend(attachments),
            Err(error) => {
                all_succeeded = false;
                ulog_warn!(
                    "[record-migration] retained {} after failure: {}",
                    source.display(),
                    error
                );
            }
        }
    }
    if !all_succeeded {
        return Ok(());
    }
    for source in cleanup_attachments {
        remove_plain_file_if_present(&source)?;
    }
    for source in sources {
        remove_plain_file_if_present(&source)?;
    }
    remove_empty_legacy_directories(legacy_root)?;
    ulog_info!("[record-migration] all legacy thoughts migrated and sources removed");
    Ok(())
}

fn collect_legacy_thought_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    for month in fs::read_dir(root).map_err(|error| format!("scan legacy root: {error}"))? {
        let month = month.map_err(|error| format!("scan legacy month: {error}"))?;
        let month_path = month.path();
        let metadata = fs::symlink_metadata(&month_path)
            .map_err(|error| format!("inspect legacy month: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        for entry in
            fs::read_dir(&month_path).map_err(|error| format!("scan legacy month: {error}"))?
        {
            let entry = entry.map_err(|error| format!("scan legacy entry: {error}"))?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("inspect legacy entry: {error}"))?;
            if metadata.is_file() && path.extension().and_then(|value| value.to_str()) == Some("md")
            {
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
}

fn migrate_one_legacy_thought(
    record_root: &Path,
    legacy_root: &Path,
    source: &Path,
    canonical: &HashMap<String, StoredRecord>,
) -> Result<Vec<PathBuf>, String> {
    let raw = read_bounded_regular_file(source, LEGACY_THOUGHT_MAX_BYTES)?;
    let digest = sha256_bytes(&raw);
    let expected_digest = digest.clone();
    let text = std::str::from_utf8(&raw).map_err(|_| "legacy thought is not UTF-8")?;
    let legacy = parse_legacy_thought(text)?;
    if !is_safe_id(&legacy.id) {
        return Err("legacy thought id is unsafe".to_string());
    }
    if let Some(existing) = canonical.get(&legacy.id) {
        if existing.legacy_thought_digest.as_deref() == Some(digest.as_str()) {
            return legacy_attachment_sources(legacy_root, source, &legacy.images);
        }
        return Err("canonical Record with same id has a different legacy digest".to_string());
    }

    let (content, images, attachment_sources) =
        prepare_legacy_attachments(legacy_root, source, &legacy.content, &legacy.images)?;
    let artifacts = attachment_sources
        .iter()
        .map(|(source, destination)| record_artifact_from_file(source, destination, "attachment"))
        .collect::<Result<Vec<_>, _>>()?;
    let record = Record {
        id: legacy.id,
        kind: RecordKind::Text,
        title: derive_text_title(&content),
        tags: legacy.tags,
        created_at: legacy.created_at,
        updated_at: legacy.updated_at,
        archived: legacy.archived,
        converted_task_ids: legacy.converted_task_ids,
        revision: 1,
        audio: None,
        content: Some(content),
        images,
        artifacts,
    };
    let final_path = record_path(record_root, &record);
    let copy_sources = attachment_sources.clone();
    publish_record_directory(
        record_root,
        &final_path,
        &record,
        Some(digest),
        move |staging| {
            for (source_path, relative_destination) in &copy_sources {
                let destination = staging.join(relative_destination);
                let parent = destination
                    .parent()
                    .ok_or_else(|| "attachment destination has no parent".to_string())?;
                fs::create_dir_all(parent)
                    .map_err(|error| format!("create attachment directory: {error}"))?;
                ensure_plain_directory(parent)?;
                let bytes = read_bounded_regular_file(source_path, TEXT_ATTACHMENT_MAX_BYTES)?;
                write_new_synced_file(&destination, &bytes)?;
            }
            Ok(())
        },
    )?;
    let verified = read_record_directory(&final_path)?;
    if verified.legacy_thought_digest.as_deref() != Some(expected_digest.as_str()) {
        return Err("published legacy digest verification failed".to_string());
    }
    Ok(attachment_sources
        .into_iter()
        .map(|(source, _)| source)
        .collect())
}

fn prepare_legacy_attachments(
    legacy_root: &Path,
    source: &Path,
    content: &str,
    images: &[String],
) -> Result<(String, Vec<String>, Vec<(PathBuf, PathBuf)>), String> {
    let mut rewritten = content.to_string();
    let mut migrated_images = Vec::with_capacity(images.len());
    let mut sources = Vec::with_capacity(images.len());
    for image in images {
        let relative = validate_legacy_relative_path(image)?;
        let source_path = resolve_plain_legacy_attachment(legacy_root, source, &relative)?;
        let destination = PathBuf::from("attachments").join(&relative);
        let destination_text = path_to_forward_slashes(&destination)?;
        rewritten = rewritten.replace(image, &destination_text);
        migrated_images.push(destination_text);
        sources.push((source_path, destination));
    }
    Ok((rewritten, migrated_images, sources))
}

fn legacy_attachment_sources(
    legacy_root: &Path,
    source: &Path,
    images: &[String],
) -> Result<Vec<PathBuf>, String> {
    images
        .iter()
        .map(|image| {
            let relative = validate_legacy_relative_path(image)?;
            resolve_plain_legacy_attachment(legacy_root, source, &relative)
        })
        .collect()
}

fn validate_legacy_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("legacy attachment path is unsafe: {value}"));
    }
    Ok(path.to_path_buf())
}

fn resolve_plain_legacy_attachment(
    legacy_root: &Path,
    thought_file: &Path,
    relative: &Path,
) -> Result<PathBuf, String> {
    let month = thought_file
        .parent()
        .ok_or_else(|| "legacy thought has no month directory".to_string())?;
    let mut current = month.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("legacy attachment path is unsafe".to_string());
        };
        current.push(name);
        let metadata = fs::symlink_metadata(&current)
            .map_err(|error| format!("legacy attachment missing: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err("legacy attachment contains a symlink".to_string());
        }
    }
    let metadata = fs::symlink_metadata(&current)
        .map_err(|error| format!("inspect legacy attachment: {error}"))?;
    if !metadata.is_file() {
        return Err("legacy attachment is not a regular file".to_string());
    }
    let canonical_root = fs::canonicalize(legacy_root)
        .map_err(|error| format!("canonicalize legacy root: {error}"))?;
    let canonical_source = fs::canonicalize(&current)
        .map_err(|error| format!("canonicalize legacy attachment: {error}"))?;
    if !canonical_source.starts_with(canonical_root) {
        return Err("legacy attachment escapes legacy root".to_string());
    }
    Ok(current)
}

fn path_to_forward_slashes(path: &Path) -> Result<String, String> {
    let parts = path
        .components()
        .map(|component| match component {
            Component::Normal(value) => value
                .to_str()
                .map(str::to_string)
                .ok_or_else(|| "attachment path is not UTF-8".to_string()),
            _ => Err("attachment path is unsafe".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(parts.join("/"))
}

fn remove_plain_file_if_present(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(format!("refusing to remove non-file {}", path.display()))
        }
        Ok(_) => fs::remove_file(path).map_err(|error| format!("remove legacy source: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("inspect legacy source: {error}")),
    }
}

fn remove_empty_legacy_directories(root: &Path) -> Result<(), String> {
    fn visit(path: &Path) -> Result<bool, String> {
        let entries = fs::read_dir(path)
            .map_err(|error| format!("scan legacy cleanup directory: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("scan legacy cleanup entry: {error}"))?;
        for entry in entries {
            let child = entry.path();
            let metadata = fs::symlink_metadata(&child)
                .map_err(|error| format!("inspect legacy cleanup entry: {error}"))?;
            if metadata.is_dir() && !metadata.file_type().is_symlink() && visit(&child)? {
                fs::remove_dir(&child)
                    .map_err(|error| format!("remove empty legacy directory: {error}"))?;
            }
        }
        fs::read_dir(path)
            .map_err(|error| format!("rescan legacy cleanup directory: {error}"))
            .map(|mut entries| entries.next().is_none())
    }
    let _ = visit(root)?;
    Ok(())
}

fn parse_legacy_thought(raw: &str) -> Result<LegacyThought, String> {
    let (frontmatter, body) =
        extract_frontmatter(raw).ok_or_else(|| "missing or malformed frontmatter".to_string())?;
    let mut id = None;
    let mut created_at = None;
    let mut updated_at = None;
    let mut tags = Vec::new();
    let mut images = Vec::new();
    let mut converted_task_ids = Vec::new();
    let mut archived = false;
    for line in frontmatter.lines() {
        let line = line.trim();
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "id" => id = Some(value.to_string()),
            "createdAt" => created_at = value.parse().ok(),
            "updatedAt" => updated_at = value.parse().ok(),
            "tags" => tags = decode_string_list(value)?,
            "images" => images = decode_string_list(value)?,
            "convertedTaskIds" => converted_task_ids = decode_string_list(value)?,
            "archived" => archived = value == "true",
            _ => {}
        }
    }
    let created_at = created_at.ok_or_else(|| "missing createdAt".to_string())?;
    Ok(LegacyThought {
        id: id.ok_or_else(|| "missing id".to_string())?,
        content: body.trim_start_matches(['\n', '\r']).trim_end().to_string(),
        tags,
        images,
        created_at,
        updated_at: updated_at.unwrap_or(created_at),
        converted_task_ids,
        archived,
    })
}

fn extract_frontmatter(raw: &str) -> Option<(&str, &str)> {
    let rest = raw
        .strip_prefix("---\n")
        .or_else(|| raw.strip_prefix("---\r\n"))?;
    for marker in ["\n---\n", "\n---\r\n"] {
        if let Some(position) = rest.find(marker) {
            return Some((&rest[..position], &rest[position + marker.len()..]));
        }
    }
    None
}

fn decode_string_list(raw: &str) -> Result<Vec<String>, String> {
    let trimmed = raw.trim();
    if let Ok(values) = serde_json::from_str::<Vec<String>>(trimmed) {
        return Ok(values);
    }
    if let Some(inner) = trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
    {
        return Ok(inner
            .split(',')
            .map(|value| value.trim().trim_matches('"').to_string())
            .filter(|value| !value.is_empty())
            .collect());
    }
    Err("invalid string list".to_string())
}

static RECORD_STORE: OnceLock<Arc<RecordStore>> = OnceLock::new();

pub type ManagedRecordStore = Arc<RecordStore>;

pub fn set_record_store(store: Arc<RecordStore>) {
    let _ = RECORD_STORE.set(store);
}

pub fn get_record_store() -> Option<&'static Arc<RecordStore>> {
    RECORD_STORE.get()
}

#[tauri::command]
pub async fn cmd_record_create(
    state: tauri::State<'_, ManagedRecordStore>,
    input: TextRecordCreateInput,
    surface: Option<AnalyticsSurface>,
) -> Result<Record, String> {
    let record = state.create_text(input).await?;
    record_analytics::emit_record_create(
        &record,
        AnalyticsSource::Desktop,
        surface.unwrap_or(AnalyticsSurface::Unknown),
    );
    Ok(record)
}

#[tauri::command]
pub async fn cmd_record_list(
    state: tauri::State<'_, ManagedRecordStore>,
    filter: Option<RecordListFilter>,
) -> Result<Vec<RecordSummary>, String> {
    Ok(state.list(filter.unwrap_or_default()).await)
}

#[tauri::command]
pub async fn cmd_record_get(
    state: tauri::State<'_, ManagedRecordStore>,
    id: String,
) -> Result<Option<Record>, String> {
    Ok(state.get(&id).await)
}

#[tauri::command]
pub async fn cmd_record_discussion_context(
    state: tauri::State<'_, ManagedRecordStore>,
    id: String,
) -> Result<RecordDiscussionContext, String> {
    state.ensure_audio_discussion_context(&id).await
}

#[tauri::command]
pub async fn cmd_record_transcript(
    state: tauri::State<'_, ManagedRecordStore>,
    id: String,
) -> Result<Option<RecordTranscriptSnapshot>, String> {
    state.read_transcript_projection(&id).await
}

#[tauri::command]
pub async fn cmd_record_transcript_delta(
    state: tauri::State<'_, ManagedRecordStore>,
    id: String,
    cursor: Option<RecordTranscriptCursor>,
) -> Result<Option<RecordTranscriptDelta>, String> {
    state.read_live_transcript_delta(&id, cursor).await
}

#[tauri::command]
pub async fn cmd_record_diarization(
    state: tauri::State<'_, ManagedRecordStore>,
    id: String,
) -> Result<Option<RecordDiarizationProjection>, String> {
    state.read_diarization_projection(&id).await
}

#[tauri::command]
pub async fn cmd_record_rename_speaker(
    state: tauri::State<'_, ManagedRecordStore>,
    input: RecordSpeakerRenameInput,
) -> Result<RecordDiarizationProjection, String> {
    let record_id = input.record_id.clone();
    let projection = state.rename_speaker(input).await?;
    if let Some(record) = state.get(&record_id).await {
        record_analytics::emit_record_use(
            &record,
            RecordUseOperation::SpeakerRename,
            AnalyticsSource::Desktop,
            AnalyticsSurface::RecordDetail,
        );
    }
    Ok(projection)
}

#[tauri::command]
pub async fn cmd_record_merge_speakers(
    state: tauri::State<'_, ManagedRecordStore>,
    input: RecordSpeakerMergeInput,
) -> Result<RecordDiarizationProjection, String> {
    let record_id = input.record_id.clone();
    let projection = state.merge_speakers(input).await?;
    if let Some(record) = state.get(&record_id).await {
        record_analytics::emit_record_use(
            &record,
            RecordUseOperation::SpeakerMerge,
            AnalyticsSource::Desktop,
            AnalyticsSurface::RecordDetail,
        );
    }
    Ok(projection)
}

#[tauri::command]
pub async fn cmd_record_reassign_segment_speaker(
    state: tauri::State<'_, ManagedRecordStore>,
    input: RecordSegmentSpeakerReassignInput,
) -> Result<RecordDiarizationProjection, String> {
    let record_id = input.record_id.clone();
    let projection = state.reassign_segment_speaker(input).await?;
    if let Some(record) = state.get(&record_id).await {
        record_analytics::emit_record_use(
            &record,
            RecordUseOperation::SpeakerReassign,
            AnalyticsSource::Desktop,
            AnalyticsSurface::RecordDetail,
        );
    }
    Ok(projection)
}

#[tauri::command]
pub async fn cmd_record_timeline(
    state: tauri::State<'_, ManagedRecordStore>,
    id: String,
) -> Result<RecordTimelineProjection, String> {
    state.read_timeline(&id).await
}

#[tauri::command]
pub async fn cmd_record_add_note(
    state: tauri::State<'_, ManagedRecordStore>,
    input: RecordNoteCreateInput,
) -> Result<RecordTimelineProjection, String> {
    state.add_note(input).await
}

#[tauri::command]
pub async fn cmd_record_add_mark(
    state: tauri::State<'_, ManagedRecordStore>,
    input: RecordMarkCreateInput,
) -> Result<RecordTimelineProjection, String> {
    state.add_mark(input).await
}

#[tauri::command]
pub async fn cmd_record_update_note(
    state: tauri::State<'_, ManagedRecordStore>,
    input: RecordNoteUpdateInput,
) -> Result<RecordTimelineProjection, String> {
    state.update_note(input).await
}

#[tauri::command]
pub async fn cmd_record_delete_timeline_item(
    state: tauri::State<'_, ManagedRecordStore>,
    input: RecordTimelineDeleteInput,
) -> Result<RecordTimelineProjection, String> {
    state.delete_timeline_item(input).await
}

#[tauri::command]
pub async fn cmd_record_update_text(
    state: tauri::State<'_, ManagedRecordStore>,
    input: TextRecordUpdateInput,
) -> Result<Record, String> {
    state.update_text(input).await
}

#[tauri::command]
pub async fn cmd_record_update_audio_metadata(
    state: tauri::State<'_, ManagedRecordStore>,
    input: AudioRecordMetadataUpdateInput,
) -> Result<Record, String> {
    state.update_audio_metadata(input).await
}

#[tauri::command]
pub async fn cmd_record_export_audio(
    state: tauri::State<'_, ManagedRecordStore>,
    input: RecordAudioExportInput,
) -> Result<RecordExportResult, String> {
    let record_id = input.record_id.clone();
    let result = state.export_audio(input).await?;
    if let Some(record) = state.get(&record_id).await {
        record_analytics::emit_record_use(
            &record,
            RecordUseOperation::ExportAudio,
            AnalyticsSource::Desktop,
            AnalyticsSurface::RecordDetail,
        );
    }
    Ok(result)
}

#[tauri::command]
pub async fn cmd_record_export_text(
    state: tauri::State<'_, ManagedRecordStore>,
    input: RecordTextExportInput,
) -> Result<RecordExportResult, String> {
    let record_id = input.record_id.clone();
    let result = state.export_text(input).await?;
    if let Some(record) = state.get(&record_id).await {
        record_analytics::emit_record_use(
            &record,
            RecordUseOperation::ExportTranscript,
            AnalyticsSource::Desktop,
            AnalyticsSurface::RecordDetail,
        );
    }
    Ok(result)
}

#[tauri::command]
pub async fn cmd_record_set_archived(
    state: tauri::State<'_, ManagedRecordStore>,
    id: String,
    archived: bool,
    surface: Option<AnalyticsSurface>,
) -> Result<Record, String> {
    let record = state.set_archived(&id, archived).await?;
    if archived {
        record_analytics::emit_record_use(
            &record,
            RecordUseOperation::Archive,
            AnalyticsSource::Desktop,
            surface.unwrap_or(AnalyticsSurface::Unknown),
        );
    }
    Ok(record)
}

#[tauri::command]
pub async fn cmd_record_delete(
    state: tauri::State<'_, ManagedRecordStore>,
    id: String,
    surface: Option<AnalyticsSurface>,
) -> Result<(), String> {
    let record = state
        .get(&id)
        .await
        .ok_or_else(|| format!("Record not found: {id}"))?;
    state.delete(&id).await?;
    record_analytics::emit_record_use(
        &record,
        RecordUseOperation::Delete,
        AnalyticsSource::Desktop,
        surface.unwrap_or(AnalyticsSurface::Unknown),
    );
    Ok(())
}

#[tauri::command]
pub async fn cmd_record_merge_text(
    state: tauri::State<'_, ManagedRecordStore>,
    source_ids: Vec<String>,
) -> Result<RecordMergeResult, String> {
    let result = state.merge_text(source_ids).await?;
    record_analytics::emit_record_create(
        &result.merged,
        AnalyticsSource::Desktop,
        AnalyticsSurface::TaskCenter,
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store_at(path: &Path) -> RecordStore {
        RecordStore::new(path.join("records"), Some(path.join("thoughts")))
    }

    #[test]
    fn title_is_shared_unicode_safe_policy() {
        assert_eq!(derive_text_title("\n  ## 会议标题\n正文"), "会议标题");
        assert_eq!(derive_text_title("#tag 不是标题"), "#tag 不是标题");
        assert_eq!(
            derive_text_title("####### 也不是标题"),
            "####### 也不是标题"
        );
        assert_eq!(derive_text_title("   \n"), "");
        assert_eq!(derive_text_title(&"你".repeat(100)).chars().count(), 80);
    }

    #[tokio::test]
    async fn text_record_round_trip_and_stable_sort() {
        let temp = tempdir().unwrap();
        let store = store_at(temp.path());
        let first = store
            .create_text(TextRecordCreateInput {
                content: "# First\nbody #tag".to_string(),
                images: Vec::new(),
            })
            .await
            .unwrap();
        let second = store
            .create_text(TextRecordCreateInput {
                content: "Second".to_string(),
                images: Vec::new(),
            })
            .await
            .unwrap();
        assert_eq!(first.title, "First");
        assert_eq!(first.tags, vec!["tag"]);
        let listed = store.list(RecordListFilter::default()).await;
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, second.id);
        drop(store);
        let reloaded = store_at(temp.path());
        assert_eq!(
            reloaded.get(&first.id).await.unwrap().content.as_deref(),
            Some("# First\nbody #tag")
        );
    }

    #[tokio::test]
    async fn committed_mutations_publish_exact_search_observer_changes() {
        let temp = tempdir().unwrap();
        let store = store_at(temp.path());
        let mut changes = store.subscribe_changes();
        let record = store
            .create_text(TextRecordCreateInput {
                content: "observer".to_string(),
                images: Vec::new(),
            })
            .await
            .unwrap();
        let created = changes.recv().await.unwrap();
        assert_eq!(created.id, record.id);
        assert_eq!(created.kind, RecordChangeKind::Upsert);
        assert_eq!(created.sequence, 1);
        assert!(store.has_published_record(&record.id));

        store.delete(&record.id).await.unwrap();
        let deleted = changes.recv().await.unwrap();
        assert_eq!(deleted.id, record.id);
        assert_eq!(deleted.kind, RecordChangeKind::Delete);
        assert_eq!(deleted.sequence, 2);
        assert!(!store.has_published_record(&record.id));
    }

    #[tokio::test]
    async fn legacy_migration_is_per_item_and_idempotent() {
        let temp = tempdir().unwrap();
        let month = temp.path().join("thoughts/2026-08");
        fs::create_dir_all(&month).unwrap();
        fs::write(
            month.join("good.md"),
            "---\r\nid: good\r\ncreatedAt: 1700000000000\r\nupdatedAt: 1700000000100\r\ntags: [\"维护\",\"escaped tag\"]\r\nimages: []\r\nconvertedTaskIds: [\"task-1\"]\r\narchived: true\r\n---\r\n\r\n## 标题\r\n正文\r\n",
        )
        .unwrap();
        let bad_bytes = b"not frontmatter";
        fs::write(month.join("bad.md"), bad_bytes).unwrap();

        let store = store_at(temp.path());
        let migrated = store.get("good").await.unwrap();
        assert_eq!(migrated.title, "标题");
        assert!(migrated.archived);
        assert_eq!(migrated.converted_task_ids, vec!["task-1"]);
        assert_eq!(fs::read(month.join("bad.md")).unwrap(), bad_bytes);
        assert!(
            month.join("good.md").is_file(),
            "all legacy files stay until every item succeeds"
        );
        drop(store);

        fs::remove_file(month.join("bad.md")).unwrap();
        let reloaded = store_at(temp.path());
        assert!(reloaded.get("good").await.is_some());
        assert!(!month.join("good.md").exists());
    }

    #[tokio::test]
    async fn missing_attachment_fails_only_that_legacy_item() {
        let temp = tempdir().unwrap();
        let month = temp.path().join("thoughts/2026-08");
        fs::create_dir_all(&month).unwrap();
        let missing = "---\nid: missing\ncreatedAt: 1700000000000\nupdatedAt: 1700000000000\ntags: []\nimages: [\"images/missing.png\"]\nconvertedTaskIds: []\n---\n\nbody\n";
        fs::write(month.join("missing.md"), missing).unwrap();
        fs::write(
            month.join("good.md"),
            "---\nid: good\ncreatedAt: 1700000000000\nupdatedAt: 1700000000000\ntags: []\nimages: []\nconvertedTaskIds: []\n---\n\ngood\n",
        )
        .unwrap();
        let store = store_at(temp.path());
        assert!(store.get("good").await.is_some());
        assert!(store.get("missing").await.is_none());
        assert_eq!(
            fs::read_to_string(month.join("missing.md")).unwrap(),
            missing
        );
    }

    #[tokio::test]
    async fn migrated_attachments_are_inventoried_and_survive_merge() {
        let temp = tempdir().unwrap();
        let month = temp.path().join("thoughts/2023-11");
        let images = month.join("images");
        fs::create_dir_all(&images).unwrap();
        fs::write(images.join("a.png"), b"image-a").unwrap();
        fs::write(images.join("b.png"), b"image-b").unwrap();
        fs::write(
            month.join("alpha.md"),
            "---\nid: alpha\ncreatedAt: 1700000000000\nupdatedAt: 1700000000000\ntags: []\nimages: [\"images/a.png\"]\nconvertedTaskIds: []\n---\n\nAlpha ![a](images/a.png)\n",
        )
        .unwrap();
        fs::write(
            month.join("bravo.md"),
            "---\nid: bravo\ncreatedAt: 1700000001000\nupdatedAt: 1700000001000\ntags: []\nimages: [\"images/b.png\"]\nconvertedTaskIds: []\n---\n\nBravo ![b](images/b.png)\n",
        )
        .unwrap();

        let store = store_at(temp.path());
        let alpha = store.get("alpha").await.unwrap();
        assert_eq!(alpha.images, vec!["attachments/images/a.png"]);
        assert_eq!(alpha.artifacts.len(), 1);
        assert_eq!(alpha.artifacts[0].size_bytes, 7);
        assert_eq!(alpha.artifacts[0].sha256, sha256_bytes(b"image-a"));

        let source_paths = [
            record_path(store.root_dir(), &alpha),
            record_path(store.root_dir(), &store.get("bravo").await.unwrap()),
        ];
        let merged = store
            .merge_text(vec!["alpha".to_string(), "bravo".to_string()])
            .await
            .unwrap()
            .merged;
        assert!(source_paths.iter().all(|path| !path.exists()));
        assert_eq!(
            merged.images,
            vec![
                "attachments/alpha/images/a.png",
                "attachments/bravo/images/b.png"
            ]
        );
        assert_eq!(merged.artifacts.len(), 2);
        let merged_path = record_path(store.root_dir(), &merged);
        assert_eq!(
            fs::read(merged_path.join(&merged.images[0])).unwrap(),
            b"image-a"
        );
        assert_eq!(
            fs::read(merged_path.join(&merged.images[1])).unwrap(),
            b"image-b"
        );
        assert!(merged
            .content
            .as_deref()
            .unwrap()
            .contains("attachments/alpha/images/a.png"));

        drop(store);
        let reloaded = store_at(temp.path());
        assert_eq!(reloaded.get(&merged.id).await.unwrap(), merged);
    }

    #[tokio::test]
    async fn conflicting_target_keeps_legacy_bytes() {
        let temp = tempdir().unwrap();
        let records = temp.path().join("records");
        fs::create_dir_all(records.join("2023-11/conflict")).unwrap();
        let content = "different";
        let record = Record {
            id: "conflict".to_string(),
            kind: RecordKind::Text,
            title: "different".to_string(),
            tags: Vec::new(),
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
            archived: false,
            converted_task_ids: Vec::new(),
            revision: 1,
            audio: None,
            content: Some(content.to_string()),
            images: Vec::new(),
            artifacts: Vec::new(),
        };
        let path = records.join("2023-11/conflict");
        fs::write(path.join("content.md"), content).unwrap();
        fs::write(
            path.join("record.json"),
            serde_json::to_vec_pretty(&RecordManifest::from_record(&record, None)).unwrap(),
        )
        .unwrap();
        let month = temp.path().join("thoughts/2023-11");
        fs::create_dir_all(&month).unwrap();
        let legacy = "---\nid: conflict\ncreatedAt: 1700000000000\nupdatedAt: 1700000000000\ntags: []\nimages: []\nconvertedTaskIds: []\n---\n\nlegacy\n";
        fs::write(month.join("conflict.md"), legacy).unwrap();
        let store = store_at(temp.path());
        assert_eq!(
            store.get("conflict").await.unwrap().content.as_deref(),
            Some("different")
        );
        assert_eq!(
            fs::read_to_string(month.join("conflict.md")).unwrap(),
            legacy
        );
    }

    #[tokio::test]
    async fn live_transcript_journal_deduplicates_replay_and_projects_from_disk() {
        let temp = tempdir().unwrap();
        let store = store_at(temp.path());
        let record = store
            .create_audio(AudioRecordCreateInput {
                title: "Live meeting".into(),
                tracks: vec![AudioTrackKind::Microphone, AudioTrackKind::System],
                transcription_status: TranscriptionStatus::Queued,
            })
            .await
            .unwrap();
        let provenance = RecordSpeechProvenance {
            provider: "local".into(),
            model_pack_revision: "local-standard-speech-v2".into(),
            onnx_runtime_version: "1.28.0".into(),
        };
        let mut journal = store
            .begin_live_transcript(&record.id, provenance.clone())
            .await
            .unwrap();
        journal
            .append_generation_started(
                7,
                vec![
                    RecordTranscriptTrackOffset {
                        track: AudioTrackKind::Microphone,
                        sample: 0,
                    },
                    RecordTranscriptTrackOffset {
                        track: AudioTrackKind::System,
                        sample: 0,
                    },
                ],
            )
            .unwrap();
        let first = journal
            .append_segment(
                AudioTrackKind::Microphone,
                1_000,
                5_000,
                "private live canary".into(),
                Some("zh".into()),
            )
            .unwrap()
            .unwrap();
        assert_eq!(first.segment_id, "live-microphone-1000-5000");
        assert_eq!(first.revision, 1);
        assert!(journal
            .append_segment(
                AudioTrackKind::Microphone,
                1_000,
                5_000,
                "private live canary".into(),
                Some("zh".into()),
            )
            .unwrap()
            .is_none());
        let corrected = journal
            .append_segment(
                AudioTrackKind::Microphone,
                1_000,
                5_000,
                "private corrected canary".into(),
                Some("zh".into()),
            )
            .unwrap()
            .unwrap();
        assert_eq!(corrected.revision, 2);
        assert_eq!(
            journal.replay_offsets(),
            vec![
                RecordTranscriptTrackOffset {
                    track: AudioTrackKind::Microphone,
                    sample: 5_000,
                },
                RecordTranscriptTrackOffset {
                    track: AudioTrackKind::System,
                    sample: 0,
                },
            ]
        );
        journal.finish().unwrap();
        drop(journal);
        fs::write(
            store
                .audio_workspace_path(&record.id)
                .await
                .unwrap()
                .join("audio/microphone.opus"),
            b"partial archive",
        )
        .unwrap();
        store
            .finalize_audio_capture(
                &record.id,
                CaptureStatus::Interrupted,
                1_000,
                vec![AudioTrackArtifactInput {
                    track: AudioTrackKind::Microphone,
                    relative_path: "audio/microphone.opus".into(),
                }],
            )
            .await
            .unwrap();

        let discussion_document = store
            .ensure_audio_discussion_document(&record.id)
            .await
            .unwrap();
        assert!(fs::read_to_string(discussion_document)
            .unwrap()
            .contains("private corrected canary"));

        let projection = store
            .read_live_transcript_revisions(&record.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(projection.state, "finalizing");
        assert_eq!(projection.provenance, provenance);
        assert_eq!(projection.segments, vec![corrected]);
        assert!(!format!("{projection:?}").contains("private corrected canary"));
    }

    #[tokio::test]
    async fn live_transcript_delta_reads_only_entries_after_its_cursor() {
        let temp = tempdir().unwrap();
        let store = store_at(temp.path());
        let record = store
            .create_audio(AudioRecordCreateInput {
                title: "Live delta".into(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Queued,
            })
            .await
            .unwrap();
        let mut journal = store
            .begin_live_transcript(
                &record.id,
                RecordSpeechProvenance {
                    provider: "local".into(),
                    model_pack_revision: "local-standard-speech-v2".into(),
                    onnx_runtime_version: "1.28.0".into(),
                },
            )
            .await
            .unwrap();

        let initial = store
            .read_live_transcript_delta(&record.id, None)
            .await
            .unwrap()
            .unwrap();
        assert!(initial.reset_snapshot.is_some());
        assert!(initial.upserts.is_empty());

        journal
            .append_generation_started(
                1,
                vec![RecordTranscriptTrackOffset {
                    track: AudioTrackKind::Microphone,
                    sample: 0,
                }],
            )
            .unwrap();
        let appended = journal
            .append_segment(
                AudioTrackKind::Microphone,
                0,
                16_000,
                "private delta canary".into(),
                Some("zh".into()),
            )
            .unwrap()
            .unwrap();

        let delta = store
            .read_live_transcript_delta(&record.id, Some(initial.cursor))
            .await
            .unwrap()
            .unwrap();
        assert!(delta.reset_snapshot.is_none());
        assert_eq!(delta.upserts, vec![appended]);
        assert!(delta.cursor.journal_bytes > initial.cursor.journal_bytes);
        assert!(store
            .read_live_transcript_delta(&record.id, Some(delta.cursor))
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn recording_final_and_diarization_commit_through_record_authority() {
        let temp = tempdir().unwrap();
        let store = store_at(temp.path());
        let record = store
            .create_audio(AudioRecordCreateInput {
                title: "Meeting".into(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Queued,
            })
            .await
            .unwrap();
        let record_root = store.audio_workspace_path(&record.id).await.unwrap();
        fs::write(record_root.join("audio/microphone.opus"), b"record-opus").unwrap();
        store
            .finalize_audio_capture(
                &record.id,
                CaptureStatus::Ready,
                5_000,
                vec![AudioTrackArtifactInput {
                    track: AudioTrackKind::Microphone,
                    relative_path: "audio/microphone.opus".into(),
                }],
            )
            .await
            .unwrap();
        let provenance = RecordSpeechProvenance {
            provider: "local".into(),
            model_pack_revision: "local-standard-speech-v2".into(),
            onnx_runtime_version: "1.28.0".into(),
        };
        let transcript = store
            .commit_recording_final_transcript(
                &record.id,
                vec![RecordTranscriptSegment {
                    segment_id: "segment-1".into(),
                    track: AudioTrackKind::Microphone,
                    start_sample: 1_000,
                    end_sample: 20_000,
                    text: "private transcript canary".into(),
                    language: Some("zh".into()),
                    revision: 1,
                }],
                provenance.clone(),
            )
            .await
            .unwrap();
        assert_eq!(transcript.projection_revision, 1);
        assert_eq!(transcript.segments.len(), 1);
        assert!(!format!("{transcript:?}").contains("private transcript canary"));
        let after_transcript = store.get(&record.id).await.unwrap();
        let audio = after_transcript.audio.unwrap();
        assert_eq!(audio.transcription_status, TranscriptionStatus::Ready);
        assert_eq!(audio.diarization_status, DiarizationStatus::Queued);
        assert!(after_transcript.artifacts.iter().any(|artifact| {
            artifact.kind == "transcript/recording-final+json"
                && artifact.path == "transcript/snapshot.json"
        }));

        fs::write(
            record_root.join("diarization/overrides.json"),
            b"user-speaker-override-canary",
        )
        .unwrap();
        for expected_revision in [1, 2] {
            let result = store
                .commit_diarization_result(
                    &record.id,
                    vec![RecordSpeakerTurn {
                        start_sample: 1_000,
                        end_sample: 20_000,
                        global_speaker: 0,
                    }],
                    provenance.clone(),
                )
                .await
                .unwrap();
            assert_eq!(result.projection_revision, expected_revision);
        }
        assert_eq!(
            fs::read(record_root.join("diarization/overrides.json")).unwrap(),
            b"user-speaker-override-canary"
        );
        let after_diarization = store.get(&record.id).await.unwrap();
        assert_eq!(
            after_diarization.audio.unwrap().diarization_status,
            DiarizationStatus::Ready
        );
        assert!(after_diarization.artifacts.iter().any(|artifact| {
            artifact.kind == "diarization/model-projection+json"
                && artifact.path == "diarization/result.json"
        }));

        let snapshot_path = record_root.join("transcript/snapshot.json");
        let original_snapshot = fs::read(&snapshot_path).unwrap();
        fs::write(&snapshot_path, b"tampered transcript canary").unwrap();
        assert!(store
            .read_recording_final_transcript(&record.id)
            .await
            .unwrap_err()
            .contains("inventory"));
        fs::write(&snapshot_path, original_snapshot).unwrap();

        drop(store);
        let reloaded = store_at(temp.path());
        assert_eq!(
            reloaded
                .read_recording_final_transcript(&record.id)
                .await
                .unwrap()
                .unwrap()
                .segments
                .len(),
            1
        );
        assert_eq!(
            reloaded
                .read_diarization_result(&record.id)
                .await
                .unwrap()
                .unwrap()
                .projection_revision,
            2
        );
    }

    #[tokio::test]
    async fn speech_projection_rejects_track_timeline_and_content_bounds() {
        let temp = tempdir().unwrap();
        let store = store_at(temp.path());
        let record = store
            .create_audio(AudioRecordCreateInput {
                title: "Meeting".into(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Queued,
            })
            .await
            .unwrap();
        let record_root = store.audio_workspace_path(&record.id).await.unwrap();
        fs::write(record_root.join("audio/microphone.opus"), b"record-opus").unwrap();
        store
            .finalize_audio_capture(
                &record.id,
                CaptureStatus::Ready,
                1_000,
                vec![AudioTrackArtifactInput {
                    track: AudioTrackKind::Microphone,
                    relative_path: "audio/microphone.opus".into(),
                }],
            )
            .await
            .unwrap();
        let error = store
            .commit_recording_final_transcript(
                &record.id,
                vec![RecordTranscriptSegment {
                    segment_id: "segment-1".into(),
                    track: AudioTrackKind::System,
                    start_sample: 0,
                    end_sample: 32_001,
                    text: "must not publish".into(),
                    language: Some("zh".into()),
                    revision: 1,
                }],
                RecordSpeechProvenance {
                    provider: "local".into(),
                    model_pack_revision: "revision".into(),
                    onnx_runtime_version: "1.28.0".into(),
                },
            )
            .await
            .unwrap_err();
        assert!(error.contains("inventory"));
        assert!(!record_root.join("transcript/snapshot.json").exists());
        assert_eq!(
            store
                .get(&record.id)
                .await
                .unwrap()
                .audio
                .unwrap()
                .transcription_status,
            TranscriptionStatus::Queued
        );
    }

    #[tokio::test]
    async fn audio_timeline_is_durable_ordered_and_operation_idempotent() {
        let temp = tempdir().unwrap();
        let store = store_at(temp.path());
        let record = store
            .create_audio(AudioRecordCreateInput {
                title: "Meeting".into(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Unavailable,
            })
            .await
            .unwrap();
        let note_operation = Uuid::new_v4().to_string();
        let note = RecordNoteCreateInput {
            record_id: record.id.clone(),
            operation_id: note_operation.clone(),
            anchor_media_ms: 2_000,
            started_at_wall_time: 10_000,
            submitted_at_wall_time: 12_000,
            text: "private note canary".into(),
        };
        let first = store.add_note(note.clone()).await.unwrap();
        let duplicate = store.add_note(note).await.unwrap();
        assert!(first.items == duplicate.items);
        assert_eq!(duplicate.items.len(), 1);
        let note_id = match &duplicate.items[0] {
            RecordTimelineItem::Note { note_id, .. } => note_id.clone(),
            _ => panic!("expected note"),
        };

        let with_mark = store
            .add_mark(RecordMarkCreateInput {
                record_id: record.id.clone(),
                operation_id: Uuid::new_v4().to_string(),
                media_ms: 1_000,
                wall_time: 11_000,
            })
            .await
            .unwrap();
        assert_eq!(with_mark.items.len(), 2);
        assert!(matches!(
            with_mark.items.first(),
            Some(RecordTimelineItem::Mark {
                media_ms: 1_000,
                ..
            })
        ));
        let mark_id = with_mark
            .items
            .iter()
            .find_map(|item| match item {
                RecordTimelineItem::Mark { mark_id, .. } => Some(mark_id.clone()),
                _ => None,
            })
            .unwrap();

        let update = RecordNoteUpdateInput {
            record_id: record.id.clone(),
            operation_id: Uuid::new_v4().to_string(),
            note_id,
            updated_at_wall_time: 13_000,
            text: "corrected note".into(),
        };
        let updated = store.update_note(update.clone()).await.unwrap();
        let duplicate_update = store.update_note(update).await.unwrap();
        assert!(updated.items == duplicate_update.items);
        assert!(matches!(
            updated.items.iter().find(|item| matches!(item, RecordTimelineItem::Note { .. })),
            Some(RecordTimelineItem::Note { text, .. }) if text == "corrected note"
        ));

        let projection = store
            .delete_timeline_item(RecordTimelineDeleteInput {
                record_id: record.id.clone(),
                operation_id: Uuid::new_v4().to_string(),
                item_id: mark_id,
                item_type: "mark".into(),
                deleted_at_wall_time: 14_000,
            })
            .await
            .unwrap();
        assert_eq!(projection.items.len(), 1);

        drop(store);
        let reloaded = store_at(temp.path());
        let recovered = reloaded.read_timeline(&record.id).await.unwrap();
        assert!(recovered.items == projection.items);
    }

    #[tokio::test]
    async fn audio_metadata_requires_exact_revision_and_valid_tags() {
        let temp = tempdir().unwrap();
        let store = store_at(temp.path());
        let record = store
            .create_audio(AudioRecordCreateInput {
                title: "Meeting".into(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Unavailable,
            })
            .await
            .unwrap();
        let updated = store
            .update_audio_metadata(AudioRecordMetadataUpdateInput {
                id: record.id.clone(),
                expected_revision: record.revision,
                title: "Product review".into(),
                tags: vec!["#work".into(), "work".into(), "中文".into()],
            })
            .await
            .unwrap();
        assert_eq!(updated.title, "Product review");
        assert_eq!(updated.tags, vec!["work", "中文"]);
        assert_eq!(
            store
                .update_audio_metadata(AudioRecordMetadataUpdateInput {
                    id: record.id,
                    expected_revision: record.revision,
                    title: "stale".into(),
                    tags: Vec::new(),
                })
                .await
                .unwrap_err(),
            "RECORD_REVISION_CONFLICT"
        );
    }

    #[tokio::test]
    async fn speaker_overrides_are_durable_revisioned_and_survive_model_rerun() {
        let temp = tempdir().unwrap();
        let store = store_at(temp.path());
        let record = store
            .create_audio(AudioRecordCreateInput {
                title: "Meeting".into(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Queued,
            })
            .await
            .unwrap();
        let root = store.audio_workspace_path(&record.id).await.unwrap();
        assert!(!root.join(AUDIO_DISCUSSION_DOCUMENT_PATH).exists());
        assert_eq!(
            store
                .ensure_audio_discussion_document(&record.id)
                .await
                .unwrap_err(),
            "RECORD_DISCUSSION_DOCUMENT_NOT_READY"
        );
        fs::write(root.join("audio/microphone.opus"), b"record-opus").unwrap();
        store
            .finalize_audio_capture(
                &record.id,
                CaptureStatus::Ready,
                5_000,
                vec![AudioTrackArtifactInput {
                    track: AudioTrackKind::Microphone,
                    relative_path: "audio/microphone.opus".into(),
                }],
            )
            .await
            .unwrap();
        assert!(root.join(AUDIO_DISCUSSION_DOCUMENT_PATH).is_file());
        let discussion_context = store
            .ensure_audio_discussion_context(&record.id)
            .await
            .unwrap();
        assert_eq!(
            discussion_context.document_path,
            fs::canonicalize(root.join(AUDIO_DISCUSSION_DOCUMENT_PATH))
                .unwrap()
                .to_string_lossy()
                .into_owned()
        );
        assert_eq!(
            discussion_context.audio_sources,
            vec![RecordDiscussionAudioSource {
                track: AudioTrackKind::Microphone,
                path: fs::canonicalize(root.join("audio/microphone.opus"))
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            }]
        );
        let provenance = RecordSpeechProvenance {
            provider: "local".into(),
            model_pack_revision: "speech-pack-1".into(),
            onnx_runtime_version: "1.28.0".into(),
        };
        store
            .commit_recording_final_transcript(
                &record.id,
                vec![
                    RecordTranscriptSegment {
                        segment_id: "segment-1".into(),
                        track: AudioTrackKind::Microphone,
                        start_sample: 0,
                        end_sample: 20_000,
                        text: "hello".into(),
                        language: Some("en".into()),
                        revision: 1,
                    },
                    RecordTranscriptSegment {
                        segment_id: "segment-2".into(),
                        track: AudioTrackKind::Microphone,
                        start_sample: 20_000,
                        end_sample: 40_000,
                        text: "world".into(),
                        language: Some("en".into()),
                        revision: 1,
                    },
                ],
                provenance.clone(),
            )
            .await
            .unwrap();
        store
            .commit_diarization_result(
                &record.id,
                vec![
                    RecordSpeakerTurn {
                        start_sample: 0,
                        end_sample: 20_000,
                        global_speaker: 0,
                    },
                    RecordSpeakerTurn {
                        start_sample: 20_000,
                        end_sample: 40_000,
                        global_speaker: 1,
                    },
                ],
                provenance.clone(),
            )
            .await
            .unwrap();

        let renamed = store
            .rename_speaker(RecordSpeakerRenameInput {
                record_id: record.id.clone(),
                expected_override_revision: 0,
                speaker_id: 0,
                name: "Alice".into(),
                updated_at_wall_time: 10_000,
            })
            .await
            .unwrap();
        assert_eq!(renamed.override_revision, 1);
        assert_eq!(renamed.speakers[0].custom_name.as_deref(), Some("Alice"));

        let merged = store
            .merge_speakers(RecordSpeakerMergeInput {
                record_id: record.id.clone(),
                expected_override_revision: 1,
                source_speaker_id: 1,
                target_speaker_id: 0,
                updated_at_wall_time: 11_000,
            })
            .await
            .unwrap();
        assert_eq!(merged.override_revision, 2);
        assert_eq!(merged.speakers[1].merged_into, Some(0));

        let reassigned = store
            .reassign_segment_speaker(RecordSegmentSpeakerReassignInput {
                record_id: record.id.clone(),
                expected_override_revision: 2,
                segment_id: "segment-2".into(),
                speaker_id: 0,
                updated_at_wall_time: 12_000,
            })
            .await
            .unwrap();
        assert_eq!(reassigned.override_revision, 3);
        assert_eq!(
            reassigned.segment_speaker_overrides.get("segment-2"),
            Some(&0)
        );
        assert!(store
            .rename_speaker(RecordSpeakerRenameInput {
                record_id: record.id.clone(),
                expected_override_revision: 2,
                speaker_id: 0,
                name: "stale".into(),
                updated_at_wall_time: 13_000,
            })
            .await
            .unwrap_err()
            .contains("REVISION_CONFLICT"));

        store
            .commit_diarization_result(
                &record.id,
                vec![RecordSpeakerTurn {
                    start_sample: 0,
                    end_sample: 40_000,
                    global_speaker: 2,
                }],
                provenance,
            )
            .await
            .unwrap();
        let after_rerun = store
            .read_diarization_projection(&record.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(after_rerun.override_revision, 3);
        assert!(!after_rerun.conflicts.is_empty());

        drop(store);
        let reloaded = store_at(temp.path());
        assert_eq!(
            reloaded
                .read_diarization_projection(&record.id)
                .await
                .unwrap()
                .unwrap()
                .override_revision,
            3
        );
    }

    #[tokio::test]
    async fn record_export_streams_audio_and_renders_user_corrections_without_overwrite() {
        let temp = tempdir().unwrap();
        let export_temp = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
        let store = store_at(temp.path());
        let empty_record = store
            .create_audio(AudioRecordCreateInput {
                title: "Empty interrupted recording".into(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::NotStarted,
            })
            .await
            .unwrap();
        store
            .finalize_audio_capture(&empty_record.id, CaptureStatus::Interrupted, 0, Vec::new())
            .await
            .unwrap();
        assert_eq!(
            store
                .ensure_audio_discussion_document(&empty_record.id)
                .await
                .unwrap_err(),
            "RECORD_DISCUSSION_DOCUMENT_NOT_READY"
        );
        let record = store
            .create_audio(AudioRecordCreateInput {
                title: "Meeting".into(),
                tracks: vec![AudioTrackKind::Microphone, AudioTrackKind::System],
                transcription_status: TranscriptionStatus::Queued,
            })
            .await
            .unwrap();
        let root = store.audio_workspace_path(&record.id).await.unwrap();
        fs::write(root.join("audio/microphone.opus"), b"record-opus").unwrap();
        fs::write(root.join("audio/system.opus"), b"system-opus").unwrap();
        store
            .finalize_audio_capture(
                &record.id,
                CaptureStatus::Ready,
                5_000,
                vec![
                    AudioTrackArtifactInput {
                        track: AudioTrackKind::Microphone,
                        relative_path: "audio/microphone.opus".into(),
                    },
                    AudioTrackArtifactInput {
                        track: AudioTrackKind::System,
                        relative_path: "audio/system.opus".into(),
                    },
                ],
            )
            .await
            .unwrap();
        let provenance = RecordSpeechProvenance {
            provider: "local".into(),
            model_pack_revision: "speech-pack-1".into(),
            onnx_runtime_version: "1.28.0".into(),
        };
        store
            .commit_recording_final_transcript(
                &record.id,
                vec![RecordTranscriptSegment {
                    segment_id: "segment-1".into(),
                    track: AudioTrackKind::Mixed,
                    start_sample: 16_000,
                    end_sample: 32_000,
                    text: "hello".into(),
                    language: Some("en".into()),
                    revision: 1,
                }],
                provenance.clone(),
            )
            .await
            .unwrap();
        store
            .commit_diarization_result(
                &record.id,
                vec![RecordSpeakerTurn {
                    start_sample: 16_000,
                    end_sample: 32_000,
                    global_speaker: 0,
                }],
                provenance,
            )
            .await
            .unwrap();
        store
            .rename_speaker(RecordSpeakerRenameInput {
                record_id: record.id.clone(),
                expected_override_revision: 0,
                speaker_id: 0,
                name: "Alice".into(),
                updated_at_wall_time: 10_000,
            })
            .await
            .unwrap();
        store
            .add_note(RecordNoteCreateInput {
                record_id: record.id.clone(),
                operation_id: Uuid::new_v4().to_string(),
                anchor_media_ms: 2_000,
                started_at_wall_time: 11_000,
                submitted_at_wall_time: 12_000,
                text: "corrected note".into(),
            })
            .await
            .unwrap();
        store
            .add_mark(RecordMarkCreateInput {
                record_id: record.id.clone(),
                operation_id: Uuid::new_v4().to_string(),
                media_ms: 3_000,
                wall_time: 13_000,
            })
            .await
            .unwrap();
        let before_metadata = store.get(&record.id).await.unwrap();
        store
            .update_audio_metadata(AudioRecordMetadataUpdateInput {
                id: record.id.clone(),
                expected_revision: before_metadata.revision,
                title: "Updated meeting".into(),
                tags: vec!["project".into(), "weekly".into()],
            })
            .await
            .unwrap();

        let document_path = store
            .ensure_audio_discussion_document(&record.id)
            .await
            .unwrap();
        assert_eq!(
            document_path,
            fs::canonicalize(root.join(AUDIO_DISCUSSION_DOCUMENT_PATH)).unwrap()
        );
        let document = fs::read_to_string(&document_path).unwrap();
        assert!(document.contains("# Updated meeting"));
        assert!(document.contains("- Tags: #project #weekly"));
        assert!(document.contains("[00:01] **Alice**: hello"));
        assert!(!document.contains("**Me**"));
        assert!(document.contains("[00:02] corrected note"));
        assert!(document.contains("[00:03] Highlight"));
        let current = store.get(&record.id).await.unwrap();
        let document_artifact = current
            .artifacts
            .iter()
            .find(|artifact| artifact.kind == AUDIO_DISCUSSION_DOCUMENT_KIND)
            .unwrap();
        assert_eq!(document_artifact.path, AUDIO_DISCUSSION_DOCUMENT_PATH);
        assert_eq!(document_artifact.source_revision, Some(current.revision));
        assert_eq!(document_artifact.sha256, sha256_text(&document));

        let search_documents = store.search_documents(&record.id).await.unwrap();
        assert!(search_documents.iter().any(|document| {
            document.media_ms == Some(1_000)
                && document.content.contains("Alice")
                && document.content.contains("hello")
        }));
        assert!(search_documents.iter().any(|document| {
            document.media_ms == Some(2_000) && document.content == "corrected note"
        }));

        let audio_destination = export_temp.path().join("meeting.opus");
        let audio_export = store
            .export_audio(RecordAudioExportInput {
                record_id: record.id.clone(),
                track: AudioTrackKind::Microphone,
                destination_path: audio_destination.to_string_lossy().to_string(),
            })
            .await
            .unwrap();
        assert_eq!(audio_export.bytes, 11);
        assert_eq!(fs::read(&audio_destination).unwrap(), b"record-opus");
        assert_eq!(
            store
                .export_audio(RecordAudioExportInput {
                    record_id: record.id.clone(),
                    track: AudioTrackKind::Microphone,
                    destination_path: audio_destination.to_string_lossy().to_string(),
                })
                .await
                .unwrap_err(),
            "RECORD_EXPORT_DESTINATION_EXISTS"
        );

        let text_destination = export_temp.path().join("meeting.md");
        store
            .export_text(RecordTextExportInput {
                record_id: record.id.clone(),
                format: RecordTextExportFormat::Markdown,
                destination_path: text_destination.to_string_lossy().to_string(),
                locale: "zh-CN".into(),
            })
            .await
            .unwrap();
        let exported = fs::read_to_string(text_destination).unwrap();
        assert!(exported.contains("[00:01] **Alice**: hello"));
        assert!(exported.contains("[00:02] corrected note"));
        assert!(exported.contains("[00:03] 标记重点"));

        store
            .update_audio_processing_status(&record.id, None, Some(DiarizationStatus::Failed))
            .await
            .unwrap();
        let failed_document = fs::read_to_string(
            store
                .ensure_audio_discussion_document(&record.id)
                .await
                .unwrap(),
        )
        .unwrap();
        assert!(failed_document.contains("- Status: Processing failed"));

        fs::remove_file(&document_path).unwrap();
        drop(store);
        let reloaded = store_at(temp.path());
        assert!(reloaded.get(&record.id).await.is_some());
        let rebuilt = reloaded
            .ensure_audio_discussion_document(&record.id)
            .await
            .unwrap();
        assert!(fs::read_to_string(rebuilt)
            .unwrap()
            .contains("# Updated meeting"));
    }

    #[test]
    fn record_search_projection_removes_private_attachment_paths() {
        let record = Record {
            id: "record-1".into(),
            kind: RecordKind::Text,
            title: "插图".into(),
            tags: Vec::new(),
            created_at: 1,
            updated_at: 1,
            archived: false,
            converted_task_ids: Vec::new(),
            revision: 1,
            audio: None,
            content: Some("说明 ![diagram](attachments/private-name.png)".into()),
            images: vec!["attachments/private-name.png".into()],
            artifacts: Vec::new(),
        };
        let stored = StoredRecord {
            record,
            path: PathBuf::from("unused"),
            legacy_thought_digest: None,
        };
        let document = base_record_search_document(&stored);
        assert!(document.content.contains("说明"));
        assert!(!document.content.contains("private-name"));
    }
}
