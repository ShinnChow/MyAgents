//! App-owned authority for durable text and audio Records.
//!
//! The legacy Thought directory is read only by the startup migration adapter.
//! Every business mutation, including legacy Thought compatibility commands,
//! commits through this store.

use chrono::{DateTime, Datelike, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, RwLock as StdRwLock};
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

use crate::durable_fs::{rename_directory_noreplace, sync_directory};
use crate::utils::file_lock::{with_file_lock_blocking, FileLockError, FileLockOptions};
use crate::{ulog_info, ulog_warn};

const RECORD_SCHEMA_VERSION: u32 = 1;
const RECORD_MANIFEST_MAX_BYTES: u64 = 1024 * 1024;
const TEXT_CONTENT_MAX_BYTES: u64 = 16 * 1024 * 1024;
const TEXT_ATTACHMENT_MAX_BYTES: u64 = 16 * 1024 * 1024;
const LEGACY_THOUGHT_MAX_BYTES: u64 = 16 * 1024 * 1024;

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
struct StoredRecord {
    record: Record,
    path: PathBuf,
    legacy_thought_digest: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordChangeKind {
    Upsert,
    Delete,
}

#[derive(Debug, Clone)]
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
    let manifest: RecordManifest =
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
    validate_record_artifacts(path, &manifest.artifacts, allow_staging_name)?;
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
) -> Result<Record, String> {
    state.create_text(input).await
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
pub async fn cmd_record_update_text(
    state: tauri::State<'_, ManagedRecordStore>,
    input: TextRecordUpdateInput,
) -> Result<Record, String> {
    state.update_text(input).await
}

#[tauri::command]
pub async fn cmd_record_set_archived(
    state: tauri::State<'_, ManagedRecordStore>,
    id: String,
    archived: bool,
) -> Result<Record, String> {
    state.set_archived(&id, archived).await
}

#[tauri::command]
pub async fn cmd_record_delete(
    state: tauri::State<'_, ManagedRecordStore>,
    id: String,
) -> Result<(), String> {
    state.delete(&id).await
}

#[tauri::command]
pub async fn cmd_record_merge_text(
    state: tauri::State<'_, ManagedRecordStore>,
    source_ids: Vec<String>,
) -> Result<RecordMergeResult, String> {
    state.merge_text(source_ids).await
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
}
