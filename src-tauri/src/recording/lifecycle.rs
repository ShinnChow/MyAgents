//! Checksummed lifecycle journal for capture/device/recovery facts.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const LIFECYCLE_SCHEMA_VERSION: u32 = 1;
const MAX_JOURNAL_LINE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LifecycleEvent {
    CaptureAdmitted {
        operation_id: String,
        sources: Vec<String>,
    },
    CaptureStatusChanged {
        from: String,
        to: String,
        reason: String,
    },
    PauseStarted {
        operation_id: String,
    },
    PauseEnded {
        operation_id: String,
        paused_wall_ms: u64,
    },
    DeviceGap {
        source: String,
        error_code: String,
    },
    WakeLockWarning {
        error_code: String,
    },
    ArchiveFinalized {
        tracks: Vec<String>,
        size_bytes: u64,
        overrun_samples: u64,
    },
    RecoveryCommitted {
        repaired_tracks: Vec<String>,
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct JournalBody {
    schema_version: u32,
    record_id: String,
    seq: u64,
    event_id: String,
    wall_time_ms: i64,
    media_ms: u64,
    event: LifecycleEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct JournalLine {
    #[serde(flatten)]
    body: JournalBody,
    checksum: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleEntry {
    pub seq: u64,
    pub wall_time_ms: i64,
    pub media_ms: u64,
    pub event: LifecycleEvent,
}

pub struct LifecycleJournal {
    path: PathBuf,
    record_id: String,
    next_seq: u64,
}

impl LifecycleJournal {
    pub fn open(record_dir: &Path, record_id: &str) -> Result<Self, String> {
        let path = record_dir.join("lifecycle.jsonl");
        let entries = recover_and_read(&path, record_id)?;
        let next_seq = entries
            .last()
            .map_or(1, |entry| entry.seq.saturating_add(1));
        Ok(Self {
            path,
            record_id: record_id.to_string(),
            next_seq,
        })
    }

    pub fn append(
        &mut self,
        wall_time_ms: i64,
        media_ms: u64,
        event: LifecycleEvent,
    ) -> Result<LifecycleEntry, String> {
        let body = JournalBody {
            schema_version: LIFECYCLE_SCHEMA_VERSION,
            record_id: self.record_id.clone(),
            seq: self.next_seq,
            event_id: Uuid::new_v4().to_string(),
            wall_time_ms,
            media_ms,
            event: event.clone(),
        };
        let checksum = body_checksum(&body)?;
        let line = JournalLine { body, checksum };
        let mut bytes = serde_json::to_vec(&line)
            .map_err(|error| format!("serialize lifecycle journal: {error}"))?;
        if bytes.len() > MAX_JOURNAL_LINE_BYTES {
            return Err("lifecycle journal event exceeds size limit".to_string());
        }
        bytes.push(b'\n');
        ensure_regular_or_missing(&self.path)?;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| format!("open lifecycle journal: {error}"))?;
        file.write_all(&bytes)
            .and_then(|()| file.flush())
            .and_then(|()| file.sync_data())
            .map_err(|error| format!("append lifecycle journal: {error}"))?;
        let entry = LifecycleEntry {
            seq: self.next_seq,
            wall_time_ms,
            media_ms,
            event,
        };
        self.next_seq = self.next_seq.saturating_add(1);
        Ok(entry)
    }
}

pub fn recover_and_read(path: &Path, record_id: &str) -> Result<Vec<LifecycleEntry>, String> {
    ensure_regular_or_missing(path)?;
    if !path.exists() {
        File::create(path)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("create lifecycle journal: {error}"))?;
        return Ok(Vec::new());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| format!("open lifecycle journal: {error}"))?;
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
            .map_err(|error| format!("read lifecycle journal: {error}"))?;
        if count == 0 {
            break;
        }
        if count > MAX_JOURNAL_LINE_BYTES + 1 || !line.ends_with(b"\n") {
            break;
        }
        let parsed: JournalLine = match serde_json::from_slice(&line[..line.len() - 1]) {
            Ok(parsed) => parsed,
            Err(_) => break,
        };
        let checksum = match body_checksum(&parsed.body) {
            Ok(checksum) => checksum,
            Err(_) => break,
        };
        if parsed.body.schema_version != LIFECYCLE_SCHEMA_VERSION
            || parsed.body.record_id != record_id
        {
            identity_error = Some("lifecycle journal identity/schema mismatch".to_string());
            break;
        }
        if parsed.body.seq != expected_seq || parsed.checksum != checksum {
            break;
        }
        valid_len = valid_len.saturating_add(count as u64);
        expected_seq = expected_seq.saturating_add(1);
        entries.push(LifecycleEntry {
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
        .map_err(|error| format!("inspect lifecycle journal: {error}"))?
        .len();
    if actual_len != valid_len {
        file.set_len(valid_len)
            .and_then(|()| file.seek(SeekFrom::End(0)).map(|_| ()))
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("repair lifecycle journal tail: {error}"))?;
    }
    Ok(entries)
}

fn body_checksum(body: &JournalBody) -> Result<String, String> {
    let bytes = serde_json::to_vec(body)
        .map_err(|error| format!("serialize lifecycle checksum body: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn ensure_regular_or_missing(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(format!(
            "lifecycle journal is not a regular file: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("inspect lifecycle journal: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn journal_repairs_torn_tail_and_continues_sequence() {
        let root = tempdir().unwrap();
        let path = root.path().join("lifecycle.jsonl");
        File::create(&path).unwrap();
        let mut journal = LifecycleJournal::open(root.path(), "record-1").unwrap();
        journal
            .append(
                10,
                0,
                LifecycleEvent::CaptureStatusChanged {
                    from: "preparing".into(),
                    to: "recording".into(),
                    reason: "device_opened".into(),
                },
            )
            .unwrap();
        OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"{\"schemaVersion\":")
            .unwrap();

        let mut recovered = LifecycleJournal::open(root.path(), "record-1").unwrap();
        let second = recovered
            .append(
                20,
                100,
                LifecycleEvent::PauseStarted {
                    operation_id: "pause-1".into(),
                },
            )
            .unwrap();
        assert_eq!(second.seq, 2);
        let entries = recover_and_read(&path, "record-1").unwrap();
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn checksum_or_record_identity_mismatch_is_not_accepted() {
        let root = tempdir().unwrap();
        let path = root.path().join("lifecycle.jsonl");
        File::create(&path).unwrap();
        let mut journal = LifecycleJournal::open(root.path(), "record-1").unwrap();
        journal
            .append(
                10,
                0,
                LifecycleEvent::WakeLockWarning {
                    error_code: "unsupported".into(),
                },
            )
            .unwrap();
        assert!(recover_and_read(&path, "record-2").is_err());
        assert!(path.metadata().unwrap().len() > 0);
    }
}
