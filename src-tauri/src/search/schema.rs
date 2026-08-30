//! Tantivy schema definitions for session and file indices.
//!
//! IMPORTANT: `title`/`content`/`name` fields MUST reference the `"chinese"`
//! tokenizer (registered in `tokenizer.rs`) so jieba is used at both index and
//! query time. Using plain `TEXT` falls back to Tantivy's default English
//! tokenizer, which splits Chinese text into single characters and then
//! truncates them via the default tokenizer's cut-off, producing no hits.
//!
//! If these definitions change, bump `SCHEMA_VERSION` so existing indices on
//! disk are rebuilt instead of opened with a mismatched schema (which panics
//! inside Tantivy).

use tantivy::schema::*;

use super::tokenizer::TOKENIZER_NAME;

/// Schema version marker. Bump whenever the field list or tokenizer changes
/// so existing indices are nuked and rebuilt on startup.
pub const SCHEMA_VERSION: u32 = 3;
pub const RECORD_SCHEMA_VERSION: u32 = 2;

fn chinese_text_options() -> TextOptions {
    TextOptions::default().set_stored().set_indexing_options(
        TextFieldIndexing::default()
            .set_tokenizer(TOKENIZER_NAME)
            .set_index_option(IndexRecordOption::WithFreqsAndPositions),
    )
}

/// Build the Tantivy schema for the session index.
pub fn session_schema() -> (Schema, SessionFields) {
    let mut builder = Schema::builder();

    let text_opts = chinese_text_options();

    let session_id = builder.add_text_field("session_id", STRING | STORED);
    let message_id = builder.add_text_field("message_id", STRING | STORED);
    let agent_dir = builder.add_text_field("agent_dir", STRING | STORED);
    let role = builder.add_text_field("role", STRING | STORED);
    let title = builder.add_text_field("title", text_opts.clone());
    let content = builder.add_text_field("content", text_opts);
    let timestamp = builder.add_text_field("timestamp", STRING | STORED);
    let last_active_at = builder.add_text_field("last_active_at", STRING | STORED);
    let source = builder.add_text_field("source", STRING | STORED);
    let message_count = builder.add_u64_field("message_count", STORED);

    let schema = builder.build();
    let fields = SessionFields {
        session_id,
        message_id,
        agent_dir,
        role,
        title,
        content,
        timestamp,
        last_active_at,
        source,
        message_count,
    };

    (schema, fields)
}

/// Named field handles for the session index.
#[derive(Clone)]
pub struct SessionFields {
    pub session_id: Field,
    pub message_id: Field,
    pub agent_dir: Field,
    pub role: Field,
    pub title: Field,
    pub content: Field,
    pub timestamp: Field,
    pub last_active_at: Field,
    pub source: Field,
    pub message_count: Field,
}

/// Build the Tantivy schema for the workspace file index.
pub fn file_schema() -> (Schema, FileFields) {
    let mut builder = Schema::builder();

    let text_opts = chinese_text_options();

    let path = builder.add_text_field("path", STRING | STORED);
    let name = builder.add_text_field("name", text_opts.clone());
    let content = builder.add_text_field("content", text_opts);
    let ext = builder.add_text_field("ext", STRING | STORED);

    let schema = builder.build();
    let fields = FileFields {
        path,
        name,
        content,
        ext,
    };

    (schema, fields)
}

/// Named field handles for the file index.
#[derive(Clone)]
pub struct FileFields {
    pub path: Field,
    pub name: Field,
    pub content: Field,
    pub ext: Field,
}

/// Build the global Record index schema. A Record may eventually produce
/// multiple stable search entries (final transcript segments, notes, speaker
/// names); `record_id` is therefore the delete/upsert grouping key.
pub fn record_schema() -> (Schema, RecordFields) {
    let mut builder = Schema::builder();
    let text_opts = chinese_text_options();

    let record_id = builder.add_text_field("record_id", STRING | STORED);
    let kind = builder.add_text_field("kind", STRING | STORED);
    let title = builder.add_text_field("title", text_opts.clone());
    let tags = builder.add_text_field("tags", text_opts.clone());
    let content = builder.add_text_field("content", text_opts);
    let media_ms = builder.add_u64_field("media_ms", STORED);

    let schema = builder.build();
    let fields = RecordFields {
        record_id,
        kind,
        title,
        tags,
        content,
        media_ms,
    };
    (schema, fields)
}

#[derive(Clone)]
pub struct RecordFields {
    pub record_id: Field,
    pub kind: Field,
    pub title: Field,
    pub tags: Field,
    pub content: Field,
    pub media_ms: Field,
}
