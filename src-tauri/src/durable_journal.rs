//! Shared typed JSONL durability for Record-owned append-only facts.
//!
//! Domain modules own their event enums and projections. This module owns the
//! regular-file check, identity/schema binding, sequence/checksum validation,
//! durable append, and torn-tail repair so lifecycle and transcript revisions
//! cannot drift into subtly different storage protocols.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zeroize::Zeroize;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct JournalBody<Event> {
    schema_version: u32,
    record_id: String,
    seq: u64,
    event_id: String,
    wall_time_ms: i64,
    media_ms: u64,
    event: Event,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct JournalLine<Event> {
    #[serde(flatten)]
    body: JournalBody<Event>,
    checksum: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DurableJournalEntry<Event> {
    pub seq: u64,
    pub wall_time_ms: i64,
    pub media_ms: u64,
    pub event: Event,
}

pub(crate) struct DurableRecordJournal<Event> {
    path: PathBuf,
    record_id: String,
    schema_version: u32,
    max_line_bytes: usize,
    next_seq: u64,
    event: PhantomData<Event>,
}

impl<Event> DurableRecordJournal<Event>
where
    Event: DeserializeOwned + Serialize,
{
    pub fn open(
        path: PathBuf,
        record_id: &str,
        schema_version: u32,
        max_line_bytes: usize,
    ) -> Result<Self, String> {
        validate_configuration(record_id, schema_version, max_line_bytes)?;
        let entries = recover_and_read::<Event>(&path, record_id, schema_version, max_line_bytes)?;
        let next_seq = entries
            .last()
            .map_or(1, |entry| entry.seq.saturating_add(1));
        Ok(Self {
            path,
            record_id: record_id.to_string(),
            schema_version,
            max_line_bytes,
            next_seq,
            event: PhantomData,
        })
    }

    pub fn append(
        &mut self,
        wall_time_ms: i64,
        media_ms: u64,
        event: Event,
    ) -> Result<DurableJournalEntry<Event>, String> {
        ensure_regular_or_missing(&self.path)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| format!("open durable journal: {error}"))?;
        let next_seq = self
            .next_seq
            .checked_add(1)
            .ok_or_else(|| "durable journal sequence exhausted".to_string())?;
        let body = JournalBody {
            schema_version: self.schema_version,
            record_id: self.record_id.clone(),
            seq: self.next_seq,
            event_id: Uuid::new_v4().to_string(),
            wall_time_ms,
            media_ms,
            event,
        };
        let checksum = body_checksum(&body)?;
        let line = JournalLine { body, checksum };
        let mut bytes = serde_json::to_vec(&line)
            .map_err(|error| format!("serialize durable journal: {error}"))?;
        if bytes.len() > self.max_line_bytes {
            bytes.zeroize();
            return Err("durable journal event exceeds size limit".to_string());
        }
        bytes.push(b'\n');
        let write_result = file
            .write_all(&bytes)
            .and_then(|()| file.flush())
            .and_then(|()| file.sync_data())
            .map_err(|error| format!("append durable journal: {error}"));
        bytes.zeroize();
        write_result?;
        let JournalBody {
            seq,
            wall_time_ms,
            media_ms,
            event,
            ..
        } = line.body;
        let entry = DurableJournalEntry {
            seq,
            wall_time_ms,
            media_ms,
            event,
        };
        self.next_seq = next_seq;
        Ok(entry)
    }
}

pub(crate) fn recover_and_read<Event>(
    path: &Path,
    record_id: &str,
    schema_version: u32,
    max_line_bytes: usize,
) -> Result<Vec<DurableJournalEntry<Event>>, String>
where
    Event: DeserializeOwned + Serialize,
{
    validate_configuration(record_id, schema_version, max_line_bytes)?;
    ensure_regular_or_missing(path)?;
    if !path.exists() {
        File::create(path)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("create durable journal: {error}"))?;
        return Ok(Vec::new());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("open durable journal: {error}"))?;
    let mut reader = BufReader::new(file);
    let mut entries = Vec::new();
    let mut line = Vec::new();
    let mut valid_len = 0_u64;
    let mut expected_seq = 1_u64;
    let mut identity_error = None;
    loop {
        line.clear();
        let count = reader
            .read_until(b'\n', &mut line)
            .map_err(|error| format!("read durable journal: {error}"))?;
        if count == 0 {
            break;
        }
        if count > max_line_bytes + 1 || !line.ends_with(b"\n") {
            break;
        }
        let parsed: JournalLine<Event> = match serde_json::from_slice(&line[..line.len() - 1]) {
            Ok(parsed) => parsed,
            Err(_) => break,
        };
        let checksum = match body_checksum(&parsed.body) {
            Ok(checksum) => checksum,
            Err(_) => break,
        };
        if parsed.body.schema_version != schema_version || parsed.body.record_id != record_id {
            identity_error = Some("durable journal identity/schema mismatch".to_string());
            break;
        }
        if parsed.body.seq != expected_seq || parsed.checksum != checksum {
            break;
        }
        valid_len = valid_len.saturating_add(count as u64);
        expected_seq = expected_seq.saturating_add(1);
        entries.push(DurableJournalEntry {
            seq: parsed.body.seq,
            wall_time_ms: parsed.body.wall_time_ms,
            media_ms: parsed.body.media_ms,
            event: parsed.body.event,
        });
    }

    let mut file = reader.into_inner();
    if let Some(error) = identity_error {
        return Err(error);
    }
    let actual_len = file
        .metadata()
        .map_err(|error| format!("inspect durable journal: {error}"))?
        .len();
    if actual_len != valid_len {
        file.set_len(valid_len)
            .and_then(|()| file.seek(SeekFrom::End(0)).map(|_| ()))
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("repair durable journal tail: {error}"))?;
    }
    Ok(entries)
}

fn body_checksum<Event>(body: &JournalBody<Event>) -> Result<String, String>
where
    Event: Serialize,
{
    let mut bytes = serde_json::to_vec(body)
        .map_err(|error| format!("serialize durable journal checksum body: {error}"))?;
    let checksum = format!("{:x}", Sha256::digest(&bytes));
    bytes.zeroize();
    Ok(checksum)
}

fn validate_configuration(
    record_id: &str,
    schema_version: u32,
    max_line_bytes: usize,
) -> Result<(), String> {
    if record_id.is_empty() || schema_version == 0 || max_line_bytes == 0 {
        return Err("invalid durable journal configuration".to_string());
    }
    Ok(())
}

fn ensure_regular_or_missing(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(format!(
            "durable journal is not a regular file: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("inspect durable journal: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    const TEST_SCHEMA: u32 = 7;
    const TEST_LINE_LIMIT: usize = 4_096;

    #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
    #[serde(rename_all = "snake_case")]
    enum TestEvent {
        Started,
        Text(String),
    }

    #[test]
    fn typed_journal_repairs_torn_tail_and_continues_sequence() {
        let root = tempdir().unwrap();
        let path = root.path().join("events.jsonl");
        let mut journal =
            DurableRecordJournal::open(path.clone(), "record-1", TEST_SCHEMA, TEST_LINE_LIMIT)
                .unwrap();
        journal.append(10, 20, TestEvent::Started).unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{\"schemaVersion\":")
            .unwrap();

        let mut recovered =
            DurableRecordJournal::open(path.clone(), "record-1", TEST_SCHEMA, TEST_LINE_LIMIT)
                .unwrap();
        let second = recovered
            .append(30, 40, TestEvent::Text("stable".into()))
            .unwrap();
        assert_eq!(second.seq, 2);
        assert_eq!(
            recover_and_read::<TestEvent>(&path, "record-1", TEST_SCHEMA, TEST_LINE_LIMIT)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn identity_mismatch_is_not_repaired_as_a_tail() {
        let root = tempdir().unwrap();
        let path = root.path().join("events.jsonl");
        let mut journal =
            DurableRecordJournal::open(path.clone(), "record-1", TEST_SCHEMA, TEST_LINE_LIMIT)
                .unwrap();
        journal.append(10, 20, TestEvent::Started).unwrap();
        let original = std::fs::read(&path).unwrap();

        assert!(
            recover_and_read::<TestEvent>(&path, "record-2", TEST_SCHEMA, TEST_LINE_LIMIT).is_err()
        );
        assert_eq!(std::fs::read(path).unwrap(), original);
    }

    #[test]
    fn event_and_line_limits_are_enforced_by_the_shared_layer() {
        let root = tempdir().unwrap();
        let path = root.path().join("events.jsonl");
        let mut journal = DurableRecordJournal::open(path, "record-1", TEST_SCHEMA, 256).unwrap();
        assert!(journal
            .append(10, 20, TestEvent::Text("x".repeat(512)))
            .is_err());
    }
}
