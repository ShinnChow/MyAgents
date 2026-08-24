//! Derived Tantivy index for canonical Records.
//!
//! RecordStore remains the authority. This module accepts only committed
//! Record snapshots and can always rebuild its entire directory from them.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;

use tantivy::collector::{Count, TopDocs};
use tantivy::query::QueryParser;
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, TantivyError, Term};

use crate::record::{RecordKind, RecordSearchDocument};

use super::schema::{self, RecordFields, RECORD_SCHEMA_VERSION};
use super::tokenizer;
use super::{make_snippet, RecordSearchHit, RecordSearchResult};

const INDEX_RECOVERY_REQUIRED: &str = "[recoverable-record-index-corruption]";

pub struct RecordIndex {
    state: StdMutex<RecordIndexState>,
}

struct RecordIndexState {
    index: Index,
    reader: IndexReader,
    writer: IndexWriter,
    fields: RecordFields,
}

impl RecordIndex {
    pub fn new(index_dir: PathBuf) -> Result<Self, String> {
        let state = match RecordIndexState::open(index_dir.clone()) {
            Ok(state) => state,
            Err(first_error) if is_recoverable_index_error(&first_error) => {
                reset_index_dir(&index_dir)?;
                RecordIndexState::open(index_dir.clone()).map_err(|second_error| {
                    format!(
                        "failed to recover Record search index ({first_error}); recreate failed: {second_error}"
                    )
                })?
            }
            Err(error) => return Err(error),
        };
        Ok(Self {
            state: StdMutex::new(state),
        })
    }

    pub fn rebuild(&self, documents: &[RecordSearchDocument]) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| format!("Record index lock poisoned: {error}"))?;
        state
            .writer
            .delete_all_documents()
            .map_err(|error| format!("clear Record index: {error}"))?;
        for document in documents {
            state.add_document(document)?;
        }
        state.commit()
    }

    pub fn upsert(
        &self,
        record_id: &str,
        documents: &[RecordSearchDocument],
    ) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| format!("Record index lock poisoned: {error}"))?;
        state
            .writer
            .delete_term(Term::from_field_text(state.fields.record_id, record_id));
        for document in documents {
            state.add_document(document)?;
        }
        state.commit()
    }

    pub fn delete(&self, record_id: &str) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| format!("Record index lock poisoned: {error}"))?;
        state
            .writer
            .delete_term(Term::from_field_text(state.fields.record_id, record_id));
        state.commit()
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<RecordSearchResult, String> {
        let started = std::time::Instant::now();
        let state = self
            .state
            .lock()
            .map_err(|error| format!("Record index lock poisoned: {error}"))?;
        let searcher = state.reader.searcher();
        let fields = &state.fields;
        let mut parser = QueryParser::for_index(
            &state.index,
            vec![fields.title, fields.tags, fields.content],
        );
        parser.set_field_boost(fields.title, 3.0);
        parser.set_field_boost(fields.tags, 2.0);
        let parsed = parser
            .parse_query(query)
            .map_err(|error| format!("Record query parse error: {error}"))?;
        let matching_documents = searcher
            .search(&parsed, &Count)
            .map_err(|error| format!("Record count search failed: {error}"))?;
        let top_docs = if matching_documents == 0 {
            Vec::new()
        } else {
            searcher
                .search(&parsed, &TopDocs::with_limit(matching_documents))
                .map_err(|error| format!("Record search failed: {error}"))?
        };
        let needle = query.to_lowercase();
        let mut hits = Vec::with_capacity(limit.min(top_docs.len()));
        let mut matching_records = HashSet::new();
        for (_score, address) in top_docs {
            let document = searcher
                .doc::<tantivy::TantivyDocument>(address)
                .map_err(|error| format!("read Record search result: {error}"))?;
            let content = get_text(&document, fields.content);
            let title = get_text(&document, fields.title);
            let tags = get_text(&document, fields.tags);
            let snippet_source = if content.to_lowercase().contains(&needle) {
                &content
            } else if tags.to_lowercase().contains(&needle) {
                &tags
            } else {
                &title
            };
            let record_id = get_text(&document, fields.record_id);
            if !matching_records.insert(record_id.clone()) {
                continue;
            }
            let snippet = make_snippet(snippet_source, &needle, 180);
            if hits.len() == limit {
                continue;
            }
            hits.push(RecordSearchHit {
                record_id,
                kind: get_text(&document, fields.kind),
                title,
                snippet,
                media_ms: get_optional_u64(&document, fields.media_ms),
            });
        }
        Ok(RecordSearchResult {
            hits,
            total: matching_records.len(),
            query_time_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    }

    pub fn doc_count(&self) -> Result<u64, String> {
        let state = self
            .state
            .lock()
            .map_err(|error| format!("Record index lock poisoned: {error}"))?;
        Ok(state.reader.searcher().num_docs())
    }
}

impl RecordIndexState {
    fn open(index_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&index_dir)
            .map_err(|error| format!("create Record index directory: {error}"))?;
        let version_path = index_dir.join(".schema_version");
        let stored_version = fs::read_to_string(&version_path)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok());
        if stored_version != Some(RECORD_SCHEMA_VERSION) && index_dir.join("meta.json").exists() {
            clear_directory_contents(&index_dir)?;
        }

        let (schema, fields) = schema::record_schema();
        let index = if index_dir.join("meta.json").exists() {
            Index::open_in_dir(&index_dir)
                .map_err(|error| tantivy_error("open Record index", error))?
        } else {
            Index::create_in_dir(&index_dir, schema)
                .map_err(|error| tantivy_error("create Record index", error))?
        };
        fs::write(&version_path, RECORD_SCHEMA_VERSION.to_string())
            .map_err(|error| format!("write Record index schema version: {error}"))?;
        index.tokenizers().register(
            tokenizer::TOKENIZER_NAME,
            tokenizer::build_chinese_tokenizer(),
        );
        let writer = index
            .writer(50_000_000)
            .map_err(|error| tantivy_error("create Record index writer", error))?;
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::OnCommitWithDelay)
            .try_into()
            .map_err(|error| tantivy_error("create Record index reader", error))?;
        Ok(Self {
            index,
            reader,
            writer,
            fields,
        })
    }

    fn add_document(&mut self, document: &RecordSearchDocument) -> Result<(), String> {
        let kind = match document.kind {
            RecordKind::Text => "text",
            RecordKind::Audio => "audio",
        };
        let mut tantivy_document = doc!(
            self.fields.record_id => document.record_id.clone(),
            self.fields.kind => kind,
            self.fields.title => document.title.clone(),
            self.fields.tags => document.tags.join("\n"),
            self.fields.content => document.content.clone(),
        );
        if let Some(media_ms) = document.media_ms {
            tantivy_document.add_u64(self.fields.media_ms, media_ms);
        }
        self.writer
            .add_document(tantivy_document)
            .map_err(|error| {
                format!(
                    "index Record {} search document: {error}",
                    document.record_id
                )
            })?;
        Ok(())
    }

    fn commit(&mut self) -> Result<(), String> {
        self.writer
            .commit()
            .map_err(|error| format!("commit Record index: {error}"))?;
        self.reader
            .reload()
            .map_err(|error| format!("reload Record index: {error}"))
    }
}

fn get_text(document: &tantivy::TantivyDocument, field: tantivy::schema::Field) -> String {
    document
        .get_first(field)
        .and_then(|value| match value {
            tantivy::schema::OwnedValue::Str(value) => Some(value.clone()),
            _ => None,
        })
        .unwrap_or_default()
}

fn get_optional_u64(
    document: &tantivy::TantivyDocument,
    field: tantivy::schema::Field,
) -> Option<u64> {
    document.get_first(field).and_then(|value| match value {
        tantivy::schema::OwnedValue::U64(value) => Some(*value),
        _ => None,
    })
}

fn reset_index_dir(index_dir: &Path) -> Result<(), String> {
    match fs::symlink_metadata(index_dir) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(index_dir)
                .map_err(|error| format!("remove corrupt Record index: {error}"))
        }
        Ok(_) => fs::remove_file(index_dir)
            .map_err(|error| format!("remove corrupt Record index path: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("inspect corrupt Record index: {error}")),
    }
}

fn is_recoverable_index_error(error: &str) -> bool {
    error.starts_with(INDEX_RECOVERY_REQUIRED)
}

fn tantivy_error(context: &str, error: TantivyError) -> String {
    let detail = error.to_string();
    if matches!(error, TantivyError::DataCorruption(_)) || detail.contains("FileDoesNotExist") {
        format!("{INDEX_RECOVERY_REQUIRED} {context}: {detail}")
    } else {
        format!("{context}: {detail}")
    }
}

fn clear_directory_contents(index_dir: &Path) -> Result<(), String> {
    for entry in
        fs::read_dir(index_dir).map_err(|error| format!("scan stale Record index: {error}"))?
    {
        let path = entry
            .map_err(|error| format!("read stale Record index entry: {error}"))?
            .path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("inspect stale Record index entry: {error}"))?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            fs::remove_dir_all(&path)
                .map_err(|error| format!("remove stale Record index directory: {error}"))?;
        } else {
            fs::remove_file(&path)
                .map_err(|error| format!("remove stale Record index file: {error}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn text_record(id: &str, title: &str, content: &str) -> RecordSearchDocument {
        RecordSearchDocument {
            record_id: id.to_string(),
            kind: RecordKind::Text,
            title: title.to_string(),
            tags: vec!["项目".to_string()],
            content: content.to_string(),
            media_ms: None,
        }
    }

    #[test]
    fn rebuild_upsert_delete_and_reopen_are_derived_from_records() {
        let temp = tempdir().unwrap();
        let index_dir = temp.path().join("records");
        let index = RecordIndex::new(index_dir.clone()).unwrap();
        let first = text_record("one", "会议规划", "讨论离线转写");
        index.rebuild(std::slice::from_ref(&first)).unwrap();
        assert_eq!(
            index.search("离线转写", 10).unwrap().hits[0].record_id,
            "one"
        );
        assert_eq!(
            index.search("会议规划", 10).unwrap().hits[0].snippet,
            "会议规划"
        );
        assert_eq!(index.search("项目", 10).unwrap().hits[0].snippet, "项目");

        let updated = text_record("one", "会议规划", "内容已经替换");
        index.upsert("one", &[updated]).unwrap();
        assert_eq!(index.search("离线转写", 10).unwrap().total, 0);
        assert_eq!(index.search("已经替换", 10).unwrap().total, 1);
        index.delete("one").unwrap();
        assert_eq!(index.search("已经替换", 10).unwrap().total, 0);
        drop(index);

        let reopened = RecordIndex::new(index_dir).unwrap();
        reopened.rebuild(std::slice::from_ref(&first)).unwrap();
        assert_eq!(reopened.doc_count().unwrap(), 1);
    }

    #[test]
    fn corrupt_derived_index_is_recreated_but_writer_contention_is_not_deleted() {
        let temp = tempdir().unwrap();
        let corrupt_dir = temp.path().join("corrupt");
        fs::create_dir_all(&corrupt_dir).unwrap();
        fs::write(
            corrupt_dir.join(".schema_version"),
            RECORD_SCHEMA_VERSION.to_string(),
        )
        .unwrap();
        fs::write(corrupt_dir.join("meta.json"), b"not-json").unwrap();
        let recovered = RecordIndex::new(corrupt_dir).unwrap();
        assert_eq!(recovered.doc_count().unwrap(), 0);

        let live_dir = temp.path().join("live");
        let live = RecordIndex::new(live_dir.clone()).unwrap();
        live.rebuild(&[text_record("one", "仍然可用", "正文")])
            .unwrap();
        assert!(RecordIndex::new(live_dir).is_err());
        assert_eq!(live.search("仍然可用", 10).unwrap().total, 1);
    }

    #[test]
    fn search_limits_unique_records_after_segment_documents() {
        let temp = tempdir().unwrap();
        let index = RecordIndex::new(temp.path().join("records")).unwrap();
        let mut documents = (0..250)
            .map(|index| RecordSearchDocument {
                record_id: "long-record".to_string(),
                kind: RecordKind::Audio,
                title: "Long meeting".to_string(),
                tags: Vec::new(),
                content: format!("roadmap segment {index}"),
                media_ms: Some(index * 1_000),
            })
            .collect::<Vec<_>>();
        documents.push(RecordSearchDocument {
            record_id: "short-record".to_string(),
            kind: RecordKind::Audio,
            title: "Short meeting".to_string(),
            tags: Vec::new(),
            content: "roadmap decision".to_string(),
            media_ms: Some(1_000),
        });
        index.rebuild(&documents).unwrap();

        let result = index.search("roadmap", 200).unwrap();
        assert_eq!(result.total, 2);
        assert_eq!(result.hits.len(), 2);
        assert!(result.hits.iter().any(|hit| hit.record_id == "long-record"));
        assert!(result
            .hits
            .iter()
            .any(|hit| hit.record_id == "short-record"));
    }
}
