//! Legacy Thought transport compatibility.
//!
//! There is intentionally no ThoughtStore here. All reads and writes map to
//! text Records; the only legacy-directory reader lives in `record`'s startup
//! migration adapter.

use serde::{Deserialize, Serialize};
use std::fs;

use crate::record::{
    ManagedRecordStore, Record, RecordArchiveFilter, RecordDeleteFailure, RecordKind,
    RecordListFilter, RecordMergeResult, TextRecordCreateInput, TextRecordUpdateInput,
};

pub use crate::record::parse_tags;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Thought {
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub images: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub converted_task_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub archived: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl TryFrom<Record> for Thought {
    type Error = String;

    fn try_from(record: Record) -> Result<Self, Self::Error> {
        if record.kind != RecordKind::Text {
            return Err(format!("Record is not text: {}", record.id));
        }
        Ok(Self {
            id: record.id,
            content: record.content.unwrap_or_default(),
            tags: record.tags,
            images: record.images,
            created_at: record.created_at,
            updated_at: record.updated_at,
            converted_task_ids: record.converted_task_ids,
            archived: record.archived,
        })
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThoughtArchiveFilter {
    Active,
    Archived,
    All,
}

impl From<ThoughtArchiveFilter> for RecordArchiveFilter {
    fn from(value: ThoughtArchiveFilter) -> Self {
        match value {
            ThoughtArchiveFilter::Active => Self::Active,
            ThoughtArchiveFilter::Archived => Self::Archived,
            ThoughtArchiveFilter::All => Self::All,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThoughtCreateInput {
    pub content: String,
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThoughtUpdateInput {
    pub id: String,
    pub content: Option<String>,
    pub images: Option<Vec<String>>,
    pub converted_task_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThoughtListFilter {
    pub tag: Option<String>,
    pub query: Option<String>,
    pub limit: Option<usize>,
    pub archived: Option<ThoughtArchiveFilter>,
}

impl From<ThoughtListFilter> for RecordListFilter {
    fn from(value: ThoughtListFilter) -> Self {
        Self {
            kind: Some(RecordKind::Text),
            tag: value.tag,
            query: value.query,
            limit: value.limit,
            archived: value.archived.map(Into::into),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSourceDeleteFailure {
    pub id: String,
    pub error: String,
}

impl From<RecordDeleteFailure> for MergeSourceDeleteFailure {
    fn from(value: RecordDeleteFailure) -> Self {
        Self {
            id: value.id,
            error: value.error,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub merged: Thought,
    pub failed_source_deletes: Vec<MergeSourceDeleteFailure>,
}

fn map_merge_result(value: RecordMergeResult) -> Result<MergeResult, String> {
    Ok(MergeResult {
        merged: value.merged.try_into()?,
        failed_source_deletes: value
            .failed_source_deletes
            .into_iter()
            .map(Into::into)
            .collect(),
    })
}

pub type ManagedThoughtStore = ManagedRecordStore;

#[tauri::command]
pub async fn cmd_thought_create(
    state: tauri::State<'_, ManagedRecordStore>,
    input: ThoughtCreateInput,
) -> Result<Thought, String> {
    state
        .create_text(TextRecordCreateInput {
            content: input.content,
            images: input.images,
        })
        .await?
        .try_into()
}

#[tauri::command]
pub async fn cmd_thought_list(
    state: tauri::State<'_, ManagedRecordStore>,
    filter: Option<ThoughtListFilter>,
) -> Result<Vec<Thought>, String> {
    state
        .list_full(filter.unwrap_or_default().into())
        .await
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

#[tauri::command]
pub async fn cmd_thought_get(
    state: tauri::State<'_, ManagedRecordStore>,
    id: String,
) -> Result<Option<Thought>, String> {
    state.get(&id).await.map(TryInto::try_into).transpose()
}

#[tauri::command]
pub async fn cmd_thought_update(
    state: tauri::State<'_, ManagedRecordStore>,
    input: ThoughtUpdateInput,
) -> Result<Thought, String> {
    state
        .update_text(TextRecordUpdateInput {
            id: input.id,
            content: input.content,
            images: input.images,
            converted_task_ids: input.converted_task_ids,
        })
        .await?
        .try_into()
}

#[tauri::command]
pub async fn cmd_thought_delete(
    state: tauri::State<'_, ManagedRecordStore>,
    id: String,
) -> Result<(), String> {
    state.delete(&id).await
}

#[tauri::command]
pub async fn cmd_thought_set_archived(
    state: tauri::State<'_, ManagedRecordStore>,
    id: String,
    archived: bool,
) -> Result<Thought, String> {
    state.set_archived(&id, archived).await?.try_into()
}

#[tauri::command]
pub async fn cmd_thought_merge(
    state: tauri::State<'_, ManagedRecordStore>,
    source_ids: Vec<String>,
) -> Result<MergeResult, String> {
    map_merge_result(state.merge_text(source_ids).await?)
}

#[tauri::command]
pub async fn cmd_thought_open_dir(
    state: tauri::State<'_, ManagedRecordStore>,
) -> Result<(), String> {
    let directory = state.root_dir();
    fs::create_dir_all(directory).map_err(|error| format!("mkdir record dir: {error}"))?;
    let path = directory.to_string_lossy().to_string();
    #[cfg(target_os = "macos")]
    crate::process_cmd::new("open")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("open finder: {error}"))?;
    #[cfg(target_os = "windows")]
    crate::process_cmd::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("open explorer: {error}"))?;
    #[cfg(target_os = "linux")]
    crate::process_cmd::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("xdg-open: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_conversion_preserves_legacy_json_shape() {
        let thought = Thought::try_from(Record {
            id: "record-1".to_string(),
            kind: RecordKind::Text,
            title: "Title".to_string(),
            tags: vec!["tag".to_string()],
            created_at: 1,
            updated_at: 2,
            archived: false,
            converted_task_ids: vec!["task-1".to_string()],
            revision: 3,
            audio: None,
            content: Some("body".to_string()),
            images: Vec::new(),
            artifacts: Vec::new(),
        })
        .unwrap();
        let value = serde_json::to_value(thought).unwrap();
        assert_eq!(value["content"], "body");
        assert!(value.get("kind").is_none());
        assert!(value.get("title").is_none());
        assert!(value.get("revision").is_none());
    }
}
