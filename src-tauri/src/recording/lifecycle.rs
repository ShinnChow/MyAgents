//! Checksummed lifecycle journal for capture/device/recovery facts.

use crate::durable_journal::DurableRecordJournal;
use serde::{Deserialize, Serialize};
use std::path::Path;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleEntry {
    pub seq: u64,
    pub wall_time_ms: i64,
    pub media_ms: u64,
    pub event: LifecycleEvent,
}

pub struct LifecycleJournal {
    inner: DurableRecordJournal<LifecycleEvent>,
}

impl LifecycleJournal {
    pub fn open(record_dir: &Path, record_id: &str) -> Result<Self, String> {
        let path = record_dir.join("lifecycle.jsonl");
        Ok(Self {
            inner: DurableRecordJournal::open(
                path,
                record_id,
                LIFECYCLE_SCHEMA_VERSION,
                MAX_JOURNAL_LINE_BYTES,
            )?,
        })
    }

    pub fn append(
        &mut self,
        wall_time_ms: i64,
        media_ms: u64,
        event: LifecycleEvent,
    ) -> Result<LifecycleEntry, String> {
        let entry = self.inner.append(wall_time_ms, media_ms, event)?;
        Ok(LifecycleEntry {
            seq: entry.seq,
            wall_time_ms: entry.wall_time_ms,
            media_ms: entry.media_ms,
            event: entry.event,
        })
    }

    pub fn read_entries(record_dir: &Path, record_id: &str) -> Result<Vec<LifecycleEntry>, String> {
        crate::durable_journal::recover_and_read::<LifecycleEvent>(
            &record_dir.join("lifecycle.jsonl"),
            record_id,
            LIFECYCLE_SCHEMA_VERSION,
            MAX_JOURNAL_LINE_BYTES,
        )
        .map(|entries| {
            entries
                .into_iter()
                .map(|entry| LifecycleEntry {
                    seq: entry.seq,
                    wall_time_ms: entry.wall_time_ms,
                    media_ms: entry.media_ms,
                    event: entry.event,
                })
                .collect()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{File, OpenOptions};
    use std::io::Write;
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
        let entries = LifecycleJournal::read_entries(root.path(), "record-1").unwrap();
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
        assert!(LifecycleJournal::read_entries(root.path(), "record-2").is_err());
        assert!(path.metadata().unwrap().len() > 0);
    }

    #[test]
    fn pre_extraction_lifecycle_bytes_remain_readable() {
        let root = tempdir().unwrap();
        let path = root.path().join("lifecycle.jsonl");
        let legacy_line = concat!(
            "{\"schemaVersion\":1,\"recordId\":\"record-1\",\"seq\":1,",
            "\"eventId\":\"event-1\",\"wallTimeMs\":10,\"mediaMs\":0,",
            "\"event\":{\"type\":\"wake_lock_warning\",\"error_code\":\"unsupported\"},",
            "\"checksum\":\"60e4600439af99c25a5a0144c3b9abc28d23520dec0876751c92565211c925cc\"}\n"
        );
        std::fs::write(&path, legacy_line).unwrap();

        let entries = LifecycleJournal::read_entries(root.path(), "record-1").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].event,
            LifecycleEvent::WakeLockWarning {
                error_code: "unsupported".into()
            }
        );
        assert_eq!(std::fs::read_to_string(path).unwrap(), legacy_line);
    }
}
