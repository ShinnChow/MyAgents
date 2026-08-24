//! App-global recording state machine and admission owner.

use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use sysinfo::Disks;
use tokio::sync::{broadcast, mpsc, Mutex};

use super::archive::{
    recover_ogg_opus_archive, ArchiveResult, TrackArchiveHandle, ARCHIVE_SAMPLE_RATE,
};
use super::capture::{
    CaptureBackend, CaptureEvent, CapturePlan, CaptureSelection, CaptureSession, CaptureSinks,
    PlatformCaptureBackend, PreparedSource,
};
use super::lifecycle::{LifecycleEvent, LifecycleJournal};
use crate::record::{
    audio_track_relative_path, AudioRecordCreateInput, AudioTrackArtifactInput, AudioTrackKind,
    CaptureStatus, ManagedRecordStore, Record, RecordArchiveFilter, RecordKind, RecordListFilter,
    TranscriptionStatus,
};
use crate::wake_lock::WakeLock;
use crate::{ulog_info, ulog_warn};

const MIN_RECORDING_FREE_BYTES: u64 = 512 * 1024 * 1024;
const MONITOR_INTERVAL: Duration = Duration::from_secs(10);
const COMPLETED_OPERATION_LIMIT: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingWarning {
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSnapshot {
    pub record_id: String,
    pub revision: u64,
    pub generation: u64,
    pub capture_status: CaptureStatus,
    pub started_at_wall_time: i64,
    pub media_duration_ms: u64,
    pub paused_wall_ms: u64,
    pub sources: Vec<PreparedSource>,
    pub warnings: Vec<RecordingWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingChange {
    pub sequence: u64,
    pub record_id: String,
    pub revision: u64,
    pub capture_status: CaptureStatus,
    pub snapshot: Option<RecordingSnapshot>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStartInput {
    pub operation_id: String,
    #[serde(default)]
    pub selection: CaptureSelection,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStartResult {
    pub snapshot: RecordingSnapshot,
    pub attached_to_existing: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingCommandInput {
    pub record_id: String,
    pub expected_revision: u64,
    pub operation_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OperationKind {
    Start,
    Pause,
    Resume,
    Stop,
}

struct OperationResult {
    kind: OperationKind,
    snapshot: RecordingSnapshot,
}

#[derive(Default)]
struct ManagerState {
    slot: Option<RecordingSlot>,
    operation_results: HashMap<String, OperationResult>,
    operation_order: VecDeque<String>,
}

enum RecordingSlot {
    Live(ActiveRecording),
    Settling(RecordingSnapshot),
}

impl RecordingSlot {
    fn snapshot(&self) -> RecordingSnapshot {
        match self {
            Self::Live(active) => active.snapshot(),
            Self::Settling(snapshot) => snapshot.clone(),
        }
    }
}

struct ActiveRecording {
    record_id: String,
    revision: u64,
    generation: u64,
    capture_status: CaptureStatus,
    started_at_wall_time: i64,
    media_before_segment_ms: u64,
    segment_started: Option<Instant>,
    pause_started: Option<Instant>,
    paused_wall_ms: u64,
    sources: Vec<PreparedSource>,
    warnings: Vec<RecordingWarning>,
    journal: LifecycleJournal,
    session: Option<Arc<StdMutex<Box<dyn CaptureSession>>>>,
    archives: Vec<TrackArchiveHandle>,
    _wake_lock: Option<WakeLock>,
}

impl ActiveRecording {
    fn media_duration_ms(&self) -> u64 {
        self.media_before_segment_ms.saturating_add(
            self.segment_started
                .map(|started| duration_ms(started.elapsed()))
                .unwrap_or(0),
        )
    }

    fn snapshot(&self) -> RecordingSnapshot {
        RecordingSnapshot {
            record_id: self.record_id.clone(),
            revision: self.revision,
            generation: self.generation,
            capture_status: self.capture_status,
            started_at_wall_time: self.started_at_wall_time,
            media_duration_ms: self.media_duration_ms(),
            paused_wall_ms: self.paused_wall_ms.saturating_add(
                self.pause_started
                    .map(|started| duration_ms(started.elapsed()))
                    .unwrap_or(0),
            ),
            sources: self.sources.clone(),
            warnings: self.warnings.clone(),
        }
    }
}

pub struct RecordingManager {
    state: Mutex<ManagerState>,
    operation_gate: Mutex<()>,
    record_store: ManagedRecordStore,
    backend: Arc<dyn CaptureBackend>,
    changes: broadcast::Sender<RecordingChange>,
    change_sequence: AtomicU64,
    next_generation: AtomicU64,
    acquire_wake_lock: bool,
}

pub type ManagedRecordingManager = Arc<RecordingManager>;

impl RecordingManager {
    pub fn new(record_store: ManagedRecordStore) -> ManagedRecordingManager {
        Self::with_backend(record_store, Arc::new(PlatformCaptureBackend), true)
    }

    fn with_backend(
        record_store: ManagedRecordStore,
        backend: Arc<dyn CaptureBackend>,
        acquire_wake_lock: bool,
    ) -> ManagedRecordingManager {
        let (changes, _) = broadcast::channel(128);
        Arc::new(Self {
            state: Mutex::new(ManagerState::default()),
            operation_gate: Mutex::new(()),
            record_store,
            backend,
            changes,
            change_sequence: AtomicU64::new(0),
            next_generation: AtomicU64::new(0),
            acquire_wake_lock,
        })
    }

    pub fn subscribe_changes(&self) -> broadcast::Receiver<RecordingChange> {
        self.changes.subscribe()
    }

    pub async fn snapshot(&self) -> Option<RecordingSnapshot> {
        self.state
            .lock()
            .await
            .slot
            .as_ref()
            .map(RecordingSlot::snapshot)
    }

    /// Reconciles Records that were left in a slot-owning state by a prior
    /// process. Recovery never opens a capture device or repopulates the live
    /// slot; it only repairs durable checkpoints and commits a terminal state.
    pub async fn recover_interrupted(self: &Arc<Self>) {
        let _operation = self.operation_gate.lock().await;
        let records = self
            .record_store
            .list_full(RecordListFilter {
                kind: Some(RecordKind::Audio),
                archived: Some(RecordArchiveFilter::All),
                ..RecordListFilter::default()
            })
            .await;
        for record in records {
            let Some(audio) = record.audio.as_ref() else {
                continue;
            };
            if !is_slot_owning_status(audio.capture_status) {
                continue;
            }
            if let Err(error) = self.recover_record(record).await {
                ulog_warn!("[recording] startup recovery failed: {}", error);
            }
        }
    }

    async fn recover_record(&self, record: Record) -> Result<(), String> {
        let workspace = self.record_store.audio_workspace_path(&record.id).await?;
        let tracks = record
            .audio
            .as_ref()
            .map(|audio| audio.tracks.clone())
            .unwrap_or_default();
        let repair_inputs: Vec<(AudioTrackKind, std::path::PathBuf)> = tracks
            .into_iter()
            .map(|track| (track, workspace.join(audio_track_relative_path(track))))
            .filter(|(_, path)| path.exists())
            .collect();
        let repair_results = tokio::task::spawn_blocking(move || {
            repair_inputs
                .into_iter()
                .map(|(track, path)| (track, recover_ogg_opus_archive(&path)))
                .collect::<Vec<_>>()
        })
        .await
        .map_err(|error| format!("recording recovery worker panicked: {error}"))?;

        let mut artifacts = Vec::new();
        let mut repaired_tracks = Vec::new();
        let mut media_samples = 0_u64;
        for (track, result) in repair_results {
            match result {
                Ok(Some(recovered)) => {
                    artifacts.push(AudioTrackArtifactInput {
                        track,
                        relative_path: audio_track_relative_path(track),
                    });
                    media_samples = media_samples.max(recovered.media_samples_48k);
                    if recovered.repaired {
                        repaired_tracks.push(format!("{track:?}").to_ascii_lowercase());
                    }
                }
                Ok(None) => {}
                Err(error) => ulog_warn!(
                    "[recording] skipped unrecoverable track recordId={} track={:?} error={}",
                    record.id,
                    track,
                    error
                ),
            }
        }
        let media_ms = media_samples.saturating_mul(1_000) / ARCHIVE_SAMPLE_RATE as u64;
        let status = if artifacts.is_empty() {
            CaptureStatus::Failed
        } else {
            CaptureStatus::Interrupted
        };
        let terminal = if artifacts.is_empty() {
            self.record_store
                .update_audio_capture(&record.id, status, 0, Some(Vec::new()))
                .await?
        } else {
            self.record_store
                .finalize_audio_capture(&record.id, status, media_ms, artifacts)
                .await?
        };
        let mut journal = LifecycleJournal::open(&workspace, &record.id)?;
        journal.append(
            now_ms(),
            media_ms,
            LifecycleEvent::RecoveryCommitted {
                repaired_tracks,
                reason: "app_restart".to_string(),
            },
        )?;
        self.emit_change(
            snapshot_from_record(&terminal, 0, Vec::new(), Vec::new()),
            false,
        );
        ulog_info!(
            "[recording] startup recovery committed recordId={} status={:?} mediaMs={}",
            record.id,
            status,
            media_ms
        );
        Ok(())
    }

    pub async fn start(
        self: &Arc<Self>,
        input: RecordingStartInput,
    ) -> Result<RecordingStartResult, String> {
        validate_operation_id(&input.operation_id)?;
        let _operation = self.operation_gate.lock().await;
        {
            let mut state = self.state.lock().await;
            if let Some(result) =
                operation_result(&state, &input.operation_id, OperationKind::Start)?
            {
                return Ok(RecordingStartResult {
                    snapshot: result,
                    attached_to_existing: true,
                });
            }
            if let Some(slot) = state.slot.as_ref() {
                let snapshot = slot.snapshot();
                remember_operation(
                    &mut state,
                    input.operation_id,
                    OperationKind::Start,
                    snapshot.clone(),
                );
                return Ok(RecordingStartResult {
                    snapshot,
                    attached_to_existing: true,
                });
            }
        }

        ensure_disk_budget(self.record_store.root_dir())?;
        let backend = self.backend.clone();
        let selection = input.selection;
        let plan = tokio::task::spawn_blocking(move || backend.preflight(selection))
            .await
            .map_err(|error| format!("recording preflight panicked: {error}"))??;
        ensure_disk_budget(self.record_store.root_dir())?;

        let title = format!("录音 {}", Local::now().format("%Y-%m-%d %H:%M"));
        let tracks = plan.sources.iter().map(|source| source.track).collect();
        let record = self
            .record_store
            .create_audio(AudioRecordCreateInput {
                title,
                tracks,
                transcription_status: TranscriptionStatus::Unavailable,
            })
            .await?;
        let workspace = match self.record_store.audio_workspace_path(&record.id).await {
            Ok(workspace) => workspace,
            Err(error) => {
                self.fail_created_record(&record, "workspace_unavailable")
                    .await;
                return Err(error);
            }
        };
        let mut journal = match LifecycleJournal::open(&workspace, &record.id) {
            Ok(journal) => journal,
            Err(error) => {
                self.fail_created_record(&record, "journal_open_failed")
                    .await;
                return Err(error);
            }
        };
        let started_at_wall_time = now_ms();
        if let Err(error) = journal.append(
            started_at_wall_time,
            0,
            LifecycleEvent::CaptureAdmitted {
                operation_id: input.operation_id.clone(),
                sources: plan
                    .sources
                    .iter()
                    .map(|source| format!("{:?}", source.track).to_ascii_lowercase())
                    .collect(),
            },
        ) {
            self.fail_created_record(&record, "journal_admission_failed")
                .await;
            return Err(error);
        }

        let (wake_lock, wake_warning) = if self.acquire_wake_lock {
            match WakeLock::acquire(&format!("MyAgents recording {}", record.id)) {
                Ok(lock) => (Some(lock), None),
                Err(error) => {
                    if let Err(journal_error) = journal.append(
                        now_ms(),
                        0,
                        LifecycleEvent::WakeLockWarning {
                            error_code: "RECORDING_WAKE_LOCK_UNAVAILABLE".to_string(),
                        },
                    ) {
                        self.fail_created_record(&record, "wake_warning_journal_failed")
                            .await;
                        return Err(journal_error);
                    }
                    ulog_warn!("[recording] wake-lock unavailable: {}", error);
                    (
                        None,
                        Some(RecordingWarning {
                            code: "RECORDING_WAKE_LOCK_UNAVAILABLE".to_string(),
                        }),
                    )
                }
            }
        } else {
            (None, None)
        };

        let archives = match start_archives(&workspace, &plan) {
            Ok(archives) => archives,
            Err(error) => {
                let failed = self
                    .record_store
                    .update_audio_capture(&record.id, CaptureStatus::Failed, 0, None)
                    .await?;
                self.emit_change(
                    snapshot_from_record(&failed, 0, Vec::new(), Vec::new()),
                    false,
                );
                return Err(error);
            }
        };
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let mut warnings = Vec::new();
        if let Some(warning) = wake_warning {
            warnings.push(warning);
        }
        let preparing = ActiveRecording {
            record_id: record.id.clone(),
            revision: record.revision,
            generation,
            capture_status: CaptureStatus::Preparing,
            started_at_wall_time,
            media_before_segment_ms: 0,
            segment_started: None,
            pause_started: None,
            paused_wall_ms: 0,
            sources: plan.sources.clone(),
            warnings,
            journal,
            session: None,
            archives,
            _wake_lock: wake_lock,
        };
        let preparing_snapshot = preparing.snapshot();
        {
            let mut state = self.state.lock().await;
            state.slot = Some(RecordingSlot::Live(preparing));
            remember_operation(
                &mut state,
                input.operation_id.clone(),
                OperationKind::Start,
                preparing_snapshot.clone(),
            );
        }
        self.emit_change(preparing_snapshot, true);

        let sinks = {
            let state = self.state.lock().await;
            let Some(RecordingSlot::Live(active)) = state.slot.as_ref() else {
                return Err("recording admission was superseded".to_string());
            };
            archive_sinks(&active.archives)
        };
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let backend = self.backend.clone();
        let open_result = tokio::task::spawn_blocking(move || backend.open(&plan, sinks, event_tx))
            .await
            .map_err(|error| format!("capture backend panicked: {error}"))?;
        let session = match open_result {
            Ok(session) => session,
            Err(error) => {
                self.settle_generation_locked(
                    generation,
                    CaptureStatus::Failed,
                    "device_open_failed",
                    None,
                )
                .await?;
                return Err(error);
            }
        };

        let session = Arc::new(StdMutex::new(session));
        {
            let mut state = self.state.lock().await;
            let Some(RecordingSlot::Live(active)) = state.slot.as_mut() else {
                return Err("recording admission was superseded".to_string());
            };
            if active.generation != generation {
                return Err("recording generation changed during admission".to_string());
            }
            active.segment_started = Some(Instant::now());
            active.session = Some(session);
        }
        let updated = match self
            .record_store
            .update_audio_capture(&record.id, CaptureStatus::Recording, 0, None)
            .await
        {
            Ok(updated) => updated,
            Err(error) => {
                let _ = self
                    .settle_generation_locked(
                        generation,
                        CaptureStatus::Interrupted,
                        "recording_state_commit_failed",
                        None,
                    )
                    .await;
                return Err(error);
            }
        };
        let snapshot_result = {
            let mut state = self.state.lock().await;
            let Some(RecordingSlot::Live(active)) = state.slot.as_mut() else {
                return Err("recording admission was superseded".to_string());
            };
            if active.generation != generation {
                return Err("recording generation changed during admission".to_string());
            }
            active.revision = updated.revision;
            active.capture_status = CaptureStatus::Recording;
            active
                .journal
                .append(
                    now_ms(),
                    0,
                    LifecycleEvent::CaptureStatusChanged {
                        from: "preparing".to_string(),
                        to: "recording".to_string(),
                        reason: "devices_opened".to_string(),
                    },
                )
                .map(|_| active.snapshot())
        };
        let snapshot = match snapshot_result {
            Ok(snapshot) => {
                let mut state = self.state.lock().await;
                remember_operation(
                    &mut state,
                    input.operation_id,
                    OperationKind::Start,
                    snapshot.clone(),
                );
                snapshot
            }
            Err(error) => {
                let _ = self
                    .settle_generation_locked(
                        generation,
                        CaptureStatus::Interrupted,
                        "recording_journal_commit_failed",
                        None,
                    )
                    .await;
                return Err(error);
            }
        };
        self.emit_change(snapshot.clone(), true);
        self.spawn_monitor(generation, event_rx);
        ulog_info!(
            "[recording] admitted recordId={} generation={}",
            snapshot.record_id,
            generation
        );
        Ok(RecordingStartResult {
            snapshot,
            attached_to_existing: false,
        })
    }

    async fn fail_created_record(&self, record: &Record, reason: &str) {
        match self
            .record_store
            .update_audio_capture(&record.id, CaptureStatus::Failed, 0, Some(Vec::new()))
            .await
        {
            Ok(failed) => self.emit_change(
                snapshot_from_record(&failed, 0, Vec::new(), Vec::new()),
                false,
            ),
            Err(error) => ulog_warn!(
                "[recording] failed to terminalize rejected Record recordId={} reason={} error={}",
                record.id,
                reason,
                error
            ),
        }
    }

    pub async fn pause(
        self: &Arc<Self>,
        input: RecordingCommandInput,
    ) -> Result<RecordingSnapshot, String> {
        self.transition_pause(input, true).await
    }

    pub async fn resume(
        self: &Arc<Self>,
        input: RecordingCommandInput,
    ) -> Result<RecordingSnapshot, String> {
        self.transition_pause(input, false).await
    }

    async fn transition_pause(
        self: &Arc<Self>,
        input: RecordingCommandInput,
        pause: bool,
    ) -> Result<RecordingSnapshot, String> {
        validate_operation_id(&input.operation_id)?;
        let kind = if pause {
            OperationKind::Pause
        } else {
            OperationKind::Resume
        };
        let _operation = self.operation_gate.lock().await;
        {
            let state = self.state.lock().await;
            if let Some(result) = operation_result(&state, &input.operation_id, kind)? {
                return Ok(result);
            }
        }
        self.validate_command_revision(&input).await?;

        let (session, generation, media_ms, paused_started_at) = {
            let mut state = self.state.lock().await;
            let Some(RecordingSlot::Live(active)) = state.slot.as_mut() else {
                return Err("RECORDING_NOT_ACTIVE".to_string());
            };
            if active.record_id != input.record_id {
                return Err("RECORDING_RECORD_MISMATCH".to_string());
            }
            if pause && active.capture_status == CaptureStatus::Paused
                || !pause && active.capture_status == CaptureStatus::Recording
            {
                let snapshot = active.snapshot();
                remember_operation(&mut state, input.operation_id, kind, snapshot.clone());
                return Ok(snapshot);
            }
            let expected = if pause {
                CaptureStatus::Recording
            } else {
                CaptureStatus::Paused
            };
            if active.capture_status != expected {
                return Err("RECORDING_TRANSITION_NOT_ALLOWED".to_string());
            }
            for archive in &active.archives {
                archive.sink.set_accepting(!pause);
            }
            (
                active
                    .session
                    .as_ref()
                    .cloned()
                    .ok_or_else(|| "capture session missing".to_string())?,
                active.generation,
                active.media_duration_ms(),
                active.pause_started,
            )
        };
        let result = tokio::task::spawn_blocking(move || {
            let mut session = session
                .lock()
                .map_err(|_| "capture session lock poisoned".to_string())?;
            if pause {
                session.pause()
            } else {
                session.resume()
            }
        })
        .await
        .map_err(|error| format!("capture transition panicked: {error}"))?;
        if let Err(error) = result {
            self.settle_generation_locked(
                generation,
                CaptureStatus::Interrupted,
                "pause_resume_failed",
                None,
            )
            .await?;
            return Err(error);
        }

        let status = if pause {
            CaptureStatus::Paused
        } else {
            CaptureStatus::Recording
        };
        let updated = match self
            .record_store
            .update_audio_capture(&input.record_id, status, media_ms, None)
            .await
        {
            Ok(updated) => updated,
            Err(error) => {
                let _ = self
                    .settle_generation_locked(
                        generation,
                        CaptureStatus::Interrupted,
                        "pause_resume_state_commit_failed",
                        None,
                    )
                    .await;
                return Err(error);
            }
        };
        let snapshot_result = {
            let mut state = self.state.lock().await;
            let Some(RecordingSlot::Live(active)) = state.slot.as_mut() else {
                return Err("recording ended during transition".to_string());
            };
            if active.generation != generation {
                return Err("recording generation changed during transition".to_string());
            }
            active.revision = updated.revision;
            active.capture_status = status;
            let journal_result = if pause {
                active.media_before_segment_ms = media_ms;
                active.segment_started = None;
                active.pause_started = Some(Instant::now());
                active.journal.append(
                    now_ms(),
                    media_ms,
                    LifecycleEvent::PauseStarted {
                        operation_id: input.operation_id.clone(),
                    },
                )
            } else {
                let paused_wall_ms = paused_started_at
                    .map(|started| duration_ms(started.elapsed()))
                    .unwrap_or(0);
                active.paused_wall_ms = active.paused_wall_ms.saturating_add(paused_wall_ms);
                active.pause_started = None;
                active.segment_started = Some(Instant::now());
                active.journal.append(
                    now_ms(),
                    media_ms,
                    LifecycleEvent::PauseEnded {
                        operation_id: input.operation_id.clone(),
                        paused_wall_ms,
                    },
                )
            };
            journal_result.map(|_| active.snapshot())
        };
        let snapshot = match snapshot_result {
            Ok(snapshot) => {
                let mut state = self.state.lock().await;
                remember_operation(&mut state, input.operation_id, kind, snapshot.clone());
                snapshot
            }
            Err(error) => {
                let _ = self
                    .settle_generation_locked(
                        generation,
                        CaptureStatus::Interrupted,
                        "pause_resume_journal_failed",
                        None,
                    )
                    .await;
                return Err(error);
            }
        };
        self.emit_change(snapshot.clone(), true);
        Ok(snapshot)
    }

    pub async fn stop(
        self: &Arc<Self>,
        input: RecordingCommandInput,
    ) -> Result<RecordingSnapshot, String> {
        validate_operation_id(&input.operation_id)?;
        let _operation = self.operation_gate.lock().await;
        {
            let state = self.state.lock().await;
            if let Some(result) =
                operation_result(&state, &input.operation_id, OperationKind::Stop)?
            {
                return Ok(result);
            }
        }
        self.validate_command_revision(&input).await?;
        let generation = {
            let state = self.state.lock().await;
            let Some(slot) = state.slot.as_ref() else {
                return Err("RECORDING_NOT_ACTIVE".to_string());
            };
            let snapshot = slot.snapshot();
            if snapshot.record_id != input.record_id {
                return Err("RECORDING_RECORD_MISMATCH".to_string());
            }
            snapshot.generation
        };
        self.settle_generation_locked(
            generation,
            CaptureStatus::Ready,
            "user_stop",
            Some(input.operation_id),
        )
        .await
    }

    pub async fn stop_for_app_exit(self: &Arc<Self>) -> Result<(), String> {
        let _operation = self.operation_gate.lock().await;
        let generation = {
            let state = self.state.lock().await;
            let Some(slot) = state.slot.as_ref() else {
                return Ok(());
            };
            slot.snapshot().generation
        };
        let snapshot = self
            .settle_generation_locked(generation, CaptureStatus::Ready, "app_exit", None)
            .await?;
        if matches!(
            snapshot.capture_status,
            CaptureStatus::Ready | CaptureStatus::Interrupted | CaptureStatus::Failed
        ) {
            Ok(())
        } else {
            Err("RECORDING_EXIT_FINALIZATION_INCOMPLETE".to_string())
        }
    }

    async fn validate_command_revision(&self, input: &RecordingCommandInput) -> Result<(), String> {
        let record = self
            .record_store
            .get(&input.record_id)
            .await
            .ok_or_else(|| "RECORDING_RECORD_NOT_FOUND".to_string())?;
        if record.revision != input.expected_revision {
            return Err(format!(
                "RECORDING_REVISION_CONFLICT expected={} actual={}",
                input.expected_revision, record.revision
            ));
        }
        Ok(())
    }

    async fn settle_generation(
        self: &Arc<Self>,
        generation: u64,
        desired_terminal: CaptureStatus,
        reason: &str,
        operation_id: Option<String>,
    ) -> Result<RecordingSnapshot, String> {
        let _operation = self.operation_gate.lock().await;
        self.settle_generation_locked(generation, desired_terminal, reason, operation_id)
            .await
    }

    async fn settle_generation_locked(
        self: &Arc<Self>,
        generation: u64,
        desired_terminal: CaptureStatus,
        reason: &str,
        operation_id: Option<String>,
    ) -> Result<RecordingSnapshot, String> {
        let mut active = {
            let mut state = self.state.lock().await;
            let Some(slot) = state.slot.take() else {
                return Err("RECORDING_NOT_ACTIVE".to_string());
            };
            match slot {
                RecordingSlot::Live(active) if active.generation == generation => active,
                other => {
                    let snapshot = other.snapshot();
                    state.slot = Some(other);
                    return Ok(snapshot);
                }
            }
        };
        let media_ms = active.media_duration_ms();
        active.capture_status = CaptureStatus::Stopping;
        active.media_before_segment_ms = media_ms;
        active.segment_started = None;
        for archive in &active.archives {
            archive.sink.set_accepting(false);
        }
        if let Err(error) = active.journal.append(
            now_ms(),
            media_ms,
            LifecycleEvent::CaptureStatusChanged {
                from: "active".to_string(),
                to: "stopping".to_string(),
                reason: reason.to_string(),
            },
        ) {
            ulog_warn!(
                "[recording] failed to journal stopping recordId={} error={}",
                active.record_id,
                error
            );
        }
        let stopping_record = self
            .record_store
            .update_audio_capture(&active.record_id, CaptureStatus::Stopping, media_ms, None)
            .await;
        match stopping_record {
            Ok(stopping_record) => active.revision = stopping_record.revision,
            Err(error) => ulog_warn!(
                "[recording] failed to persist stopping state recordId={} error={}",
                active.record_id,
                error
            ),
        }
        let stopping = active.snapshot();
        {
            self.state.lock().await.slot = Some(RecordingSlot::Settling(stopping.clone()));
        }
        self.emit_change(stopping, true);

        let session = active.session.take();
        let archives = std::mem::take(&mut active.archives);
        let settled =
            tokio::task::spawn_blocking(move || settle_capture_resources(session, archives))
                .await
                .map_err(|error| format!("recording finalization panicked: {error}"))?;

        let finalizing_record = self
            .record_store
            .update_audio_capture(&active.record_id, CaptureStatus::Finalizing, media_ms, None)
            .await;
        let mut finalizing = active.snapshot();
        match finalizing_record {
            Ok(finalizing_record) => finalizing.revision = finalizing_record.revision,
            Err(error) => ulog_warn!(
                "[recording] failed to persist finalizing state recordId={} error={}",
                active.record_id,
                error
            ),
        }
        finalizing.capture_status = CaptureStatus::Finalizing;
        {
            self.state.lock().await.slot = Some(RecordingSlot::Settling(finalizing.clone()));
        }
        self.emit_change(finalizing, true);

        let overrun_samples = settled
            .archives
            .iter()
            .map(|archive| archive.overrun_samples)
            .sum::<u64>();
        let mut terminal = desired_terminal;
        if !settled.errors.is_empty() || overrun_samples > 0 {
            terminal = CaptureStatus::Interrupted;
        }
        let usable_archives: Vec<&ArchiveResult> = settled
            .archives
            .iter()
            .filter(|archive| archive.media_samples_48k > 0)
            .collect();
        if usable_archives.is_empty() {
            terminal = if desired_terminal == CaptureStatus::Failed {
                CaptureStatus::Failed
            } else {
                CaptureStatus::Interrupted
            };
        }
        let archive_media_ms = usable_archives
            .iter()
            .map(|archive| {
                archive.media_samples_48k.saturating_mul(1_000) / ARCHIVE_SAMPLE_RATE as u64
            })
            .max()
            .unwrap_or(media_ms);
        let final_media_ms = media_ms.max(archive_media_ms);
        let artifacts: Vec<AudioTrackArtifactInput> = usable_archives
            .iter()
            .map(|archive| AudioTrackArtifactInput {
                track: archive.track,
                relative_path: audio_track_relative_path(archive.track),
            })
            .collect();
        let terminal_record_result = if artifacts.is_empty() {
            self.record_store
                .update_audio_capture(
                    &active.record_id,
                    terminal,
                    final_media_ms,
                    Some(Vec::new()),
                )
                .await
        } else {
            self.record_store
                .finalize_audio_capture(&active.record_id, terminal, final_media_ms, artifacts)
                .await
        };
        let terminal_record = match terminal_record_result {
            Ok(record) => record,
            Err(error) => {
                ulog_warn!(
                    "[recording] terminal manifest commit failed recordId={} error={}",
                    active.record_id,
                    error
                );
                return Err(error);
            }
        };
        if let Err(error) = active.journal.append(
            now_ms(),
            final_media_ms,
            LifecycleEvent::ArchiveFinalized {
                tracks: usable_archives
                    .iter()
                    .map(|archive| format!("{:?}", archive.track).to_ascii_lowercase())
                    .collect(),
                size_bytes: usable_archives
                    .iter()
                    .map(|archive| archive.size_bytes)
                    .sum(),
                overrun_samples,
            },
        ) {
            ulog_warn!(
                "[recording] terminal manifest is durable but lifecycle append failed recordId={} error={}",
                active.record_id,
                error
            );
        }
        let terminal_snapshot = RecordingSnapshot {
            record_id: active.record_id.clone(),
            revision: terminal_record.revision,
            generation,
            capture_status: terminal,
            started_at_wall_time: active.started_at_wall_time,
            media_duration_ms: final_media_ms,
            paused_wall_ms: active.snapshot().paused_wall_ms,
            sources: active.sources,
            warnings: active.warnings,
        };
        {
            let mut state = self.state.lock().await;
            state.slot = None;
            if let Some(operation_id) = operation_id {
                remember_operation(
                    &mut state,
                    operation_id,
                    OperationKind::Stop,
                    terminal_snapshot.clone(),
                );
            }
        }
        self.emit_change(terminal_snapshot.clone(), false);
        if !settled.errors.is_empty() {
            ulog_warn!(
                "[recording] finalized interrupted recordId={} errors={}",
                terminal_snapshot.record_id,
                settled.errors.join("; ")
            );
        }
        Ok(terminal_snapshot)
    }

    fn spawn_monitor(
        self: &Arc<Self>,
        generation: u64,
        mut events: mpsc::UnboundedReceiver<CaptureEvent>,
    ) {
        let manager = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(MONITOR_INTERVAL);
            interval.tick().await;
            loop {
                tokio::select! {
                    event = events.recv() => {
                        let Some(event) = event else { break; };
                        let Some(manager) = manager.upgrade() else { break; };
                        manager.record_capture_event(generation, &event).await;
                        if matches!(event, CaptureEvent::Fatal { .. }) {
                            let _ = manager
                                .settle_generation(
                                    generation,
                                    CaptureStatus::Interrupted,
                                    "device_fatal",
                                    None,
                                )
                                .await;
                            break;
                        }
                    }
                    _ = interval.tick() => {
                        let Some(manager) = manager.upgrade() else { break; };
                        if !manager.is_generation_active(generation).await { break; }
                        if let Err(error) = ensure_disk_budget(manager.record_store.root_dir()) {
                            ulog_warn!("[recording] low disk safe stop: {}", error);
                            let _ = manager
                                .settle_generation(generation, CaptureStatus::Interrupted, "low_disk", None)
                                .await;
                            break;
                        }
                    }
                }
            }
        });
    }

    async fn record_capture_event(&self, generation: u64, event: &CaptureEvent) {
        let mut state = self.state.lock().await;
        let Some(RecordingSlot::Live(active)) = state.slot.as_mut() else {
            return;
        };
        if active.generation != generation {
            return;
        }
        let (track, code) = match event {
            CaptureEvent::DeviceGap { track, code } | CaptureEvent::Fatal { track, code } => {
                (*track, code.clone())
            }
        };
        let _ = active.journal.append(
            now_ms(),
            active.media_duration_ms(),
            LifecycleEvent::DeviceGap {
                source: format!("{track:?}").to_ascii_lowercase(),
                error_code: code,
            },
        );
    }

    async fn is_generation_active(&self, generation: u64) -> bool {
        self.state.lock().await.slot.as_ref().is_some_and(|slot| {
            slot.snapshot().generation == generation
                && matches!(
                    slot.snapshot().capture_status,
                    CaptureStatus::Preparing | CaptureStatus::Recording | CaptureStatus::Paused
                )
        })
    }

    fn emit_change(&self, snapshot: RecordingSnapshot, active: bool) {
        let sequence = self.change_sequence.fetch_add(1, Ordering::Relaxed) + 1;
        let _ = self.changes.send(RecordingChange {
            sequence,
            record_id: snapshot.record_id.clone(),
            revision: snapshot.revision,
            capture_status: snapshot.capture_status,
            snapshot: active.then_some(snapshot),
        });
    }
}

struct SettledResources {
    archives: Vec<ArchiveResult>,
    errors: Vec<String>,
}

fn settle_capture_resources(
    session: Option<Arc<StdMutex<Box<dyn CaptureSession>>>>,
    archives: Vec<TrackArchiveHandle>,
) -> SettledResources {
    let mut errors = Vec::new();
    if let Some(session) = session {
        match session.lock() {
            Ok(mut session) => {
                if let Err(error) = session.stop() {
                    errors.push(error);
                }
            }
            Err(_) => errors.push("capture session lock poisoned".to_string()),
        }
    }
    let mut finalized = Vec::new();
    for archive in archives {
        match archive.finish() {
            Ok(result) => finalized.push(result),
            Err(error) => errors.push(error),
        }
    }
    SettledResources {
        archives: finalized,
        errors,
    }
}

fn start_archives(workspace: &Path, plan: &CapturePlan) -> Result<Vec<TrackArchiveHandle>, String> {
    let mut archives = Vec::with_capacity(plan.sources.len());
    for source in &plan.sources {
        let path = workspace.join(audio_track_relative_path(source.track));
        match TrackArchiveHandle::start(source.track, path, source.format.into()) {
            Ok(archive) => archives.push(archive),
            Err(error) => {
                for archive in archives {
                    let _ = archive.finish();
                }
                return Err(error);
            }
        }
    }
    Ok(archives)
}

fn archive_sinks(archives: &[TrackArchiveHandle]) -> CaptureSinks {
    let mut sinks = CaptureSinks {
        microphone: None,
        system: None,
    };
    for archive in archives {
        match archive.track {
            AudioTrackKind::Microphone => sinks.microphone = Some(archive.sink.clone()),
            AudioTrackKind::System => sinks.system = Some(archive.sink.clone()),
            _ => {}
        }
    }
    sinks
}

fn operation_result(
    state: &ManagerState,
    operation_id: &str,
    expected_kind: OperationKind,
) -> Result<Option<RecordingSnapshot>, String> {
    let Some(result) = state.operation_results.get(operation_id) else {
        return Ok(None);
    };
    if result.kind != expected_kind {
        return Err("RECORDING_OPERATION_ID_REUSED".to_string());
    }
    Ok(Some(result.snapshot.clone()))
}

fn remember_operation(
    state: &mut ManagerState,
    operation_id: String,
    kind: OperationKind,
    snapshot: RecordingSnapshot,
) {
    if let Some(result) = state.operation_results.get_mut(&operation_id) {
        *result = OperationResult { kind, snapshot };
        return;
    }
    state.operation_order.push_back(operation_id.clone());
    state
        .operation_results
        .insert(operation_id, OperationResult { kind, snapshot });
    while state.operation_order.len() > COMPLETED_OPERATION_LIMIT {
        if let Some(expired) = state.operation_order.pop_front() {
            state.operation_results.remove(&expired);
        }
    }
}

fn validate_operation_id(operation_id: &str) -> Result<(), String> {
    if operation_id.is_empty()
        || operation_id.len() > 128
        || !operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("RECORDING_OPERATION_ID_INVALID".to_string());
    }
    Ok(())
}

fn ensure_disk_budget(path: &Path) -> Result<(), String> {
    let disks = Disks::new_with_refreshed_list();
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let available = disks
        .list()
        .iter()
        .filter(|disk| canonical.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count())
        .map(|disk| disk.available_space())
        .ok_or_else(|| "RECORDING_DISK_UNAVAILABLE".to_string())?;
    if available < MIN_RECORDING_FREE_BYTES {
        return Err("RECORDING_DISK_LOW".to_string());
    }
    Ok(())
}

fn is_slot_owning_status(status: CaptureStatus) -> bool {
    matches!(
        status,
        CaptureStatus::Preparing
            | CaptureStatus::Recording
            | CaptureStatus::Paused
            | CaptureStatus::Stopping
            | CaptureStatus::Finalizing
    )
}

fn snapshot_from_record(
    record: &Record,
    generation: u64,
    sources: Vec<PreparedSource>,
    warnings: Vec<RecordingWarning>,
) -> RecordingSnapshot {
    let audio = record.audio.as_ref();
    RecordingSnapshot {
        record_id: record.id.clone(),
        revision: record.revision,
        generation,
        capture_status: audio.map_or(CaptureStatus::Failed, |audio| audio.capture_status),
        started_at_wall_time: record.created_at,
        media_duration_ms: audio.map_or(0, |audio| audio.media_duration_ms),
        paused_wall_ms: 0,
        sources,
        warnings,
    }
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[tauri::command]
pub async fn cmd_recording_snapshot(
    state: tauri::State<'_, ManagedRecordingManager>,
) -> Result<Option<RecordingSnapshot>, String> {
    Ok(state.snapshot().await)
}

#[tauri::command]
pub async fn cmd_recording_start(
    state: tauri::State<'_, ManagedRecordingManager>,
    input: RecordingStartInput,
) -> Result<RecordingStartResult, String> {
    state.inner().start(input).await
}

#[tauri::command]
pub async fn cmd_recording_pause(
    state: tauri::State<'_, ManagedRecordingManager>,
    input: RecordingCommandInput,
) -> Result<RecordingSnapshot, String> {
    state.inner().pause(input).await
}

#[tauri::command]
pub async fn cmd_recording_resume(
    state: tauri::State<'_, ManagedRecordingManager>,
    input: RecordingCommandInput,
) -> Result<RecordingSnapshot, String> {
    state.inner().resume(input).await
}

#[tauri::command]
pub async fn cmd_recording_stop(
    state: tauri::State<'_, ManagedRecordingManager>,
    input: RecordingCommandInput,
) -> Result<RecordingSnapshot, String> {
    state.inner().stop(input).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::RecordStore;
    use std::sync::atomic::AtomicBool;
    use std::thread::JoinHandle;
    use tempfile::tempdir;

    struct FakeBackend;

    impl CaptureBackend for FakeBackend {
        fn preflight(&self, selection: CaptureSelection) -> Result<CapturePlan, String> {
            let mut sources = Vec::new();
            if selection.microphone {
                sources.push(PreparedSource {
                    track: AudioTrackKind::Microphone,
                    label: "fake microphone".to_string(),
                    format: super::super::capture::CaptureFormat {
                        sample_rate: 48_000,
                        channels: 1,
                    },
                });
            }
            if selection.system {
                sources.push(PreparedSource {
                    track: AudioTrackKind::System,
                    label: "fake system".to_string(),
                    format: super::super::capture::CaptureFormat {
                        sample_rate: 48_000,
                        channels: 2,
                    },
                });
            }
            Ok(CapturePlan::for_test(sources))
        }

        fn open(
            &self,
            _plan: &CapturePlan,
            sinks: CaptureSinks,
            _events: mpsc::UnboundedSender<CaptureEvent>,
        ) -> Result<Box<dyn CaptureSession>, String> {
            Ok(Box::new(FakeSession::start(sinks)))
        }
    }

    struct FakeSession {
        running: Arc<AtomicBool>,
        paused: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
    }

    impl FakeSession {
        fn start(sinks: CaptureSinks) -> Self {
            let running = Arc::new(AtomicBool::new(true));
            let paused = Arc::new(AtomicBool::new(false));
            let running_worker = running.clone();
            let paused_worker = paused.clone();
            let worker = std::thread::spawn(move || {
                while running_worker.load(Ordering::Acquire) {
                    if !paused_worker.load(Ordering::Acquire) {
                        if let Some(sink) = sinks.microphone.as_ref() {
                            sink.push_f32(&[0.05; 480]);
                        }
                        if let Some(sink) = sinks.system.as_ref() {
                            sink.push_f32(&[0.03; 960]);
                        }
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            });
            Self {
                running,
                paused,
                worker: Some(worker),
            }
        }
    }

    impl CaptureSession for FakeSession {
        fn pause(&mut self) -> Result<(), String> {
            self.paused.store(true, Ordering::Release);
            Ok(())
        }

        fn resume(&mut self) -> Result<(), String> {
            self.paused.store(false, Ordering::Release);
            Ok(())
        }

        fn stop(&mut self) -> Result<(), String> {
            self.running.store(false, Ordering::Release);
            if let Some(worker) = self.worker.take() {
                worker
                    .join()
                    .map_err(|_| "fake capture panic".to_string())?;
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn one_global_slot_pause_freeze_and_durable_stop() {
        let root = tempdir().unwrap();
        let store = Arc::new(RecordStore::new(root.path().join("records"), None));
        let manager = RecordingManager::with_backend(store.clone(), Arc::new(FakeBackend), false);
        let started = manager
            .start(RecordingStartInput {
                operation_id: "start-1".to_string(),
                selection: CaptureSelection::default(),
            })
            .await
            .unwrap();
        let attached = manager
            .start(RecordingStartInput {
                operation_id: "start-2".to_string(),
                selection: CaptureSelection::default(),
            })
            .await
            .unwrap();
        assert!(attached.attached_to_existing);
        assert_eq!(attached.snapshot.record_id, started.snapshot.record_id);

        tokio::time::sleep(Duration::from_millis(35)).await;
        let paused = manager
            .pause(RecordingCommandInput {
                record_id: started.snapshot.record_id.clone(),
                expected_revision: started.snapshot.revision,
                operation_id: "pause-1".to_string(),
            })
            .await
            .unwrap();
        let frozen = paused.media_duration_ms;
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert_eq!(manager.snapshot().await.unwrap().media_duration_ms, frozen);
        let resumed = manager
            .resume(RecordingCommandInput {
                record_id: paused.record_id.clone(),
                expected_revision: paused.revision,
                operation_id: "resume-1".to_string(),
            })
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(25)).await;
        let stopped = manager
            .stop(RecordingCommandInput {
                record_id: resumed.record_id.clone(),
                expected_revision: resumed.revision,
                operation_id: "stop-1".to_string(),
            })
            .await
            .unwrap();
        assert_eq!(stopped.capture_status, CaptureStatus::Ready);
        assert!(manager.snapshot().await.is_none());

        let record = store.get(&stopped.record_id).await.unwrap();
        assert_eq!(
            record.audio.as_ref().unwrap().capture_status,
            CaptureStatus::Ready
        );
        assert_eq!(record.artifacts.len(), 2);
        assert!(record
            .artifacts
            .iter()
            .all(|artifact| artifact.kind == "audio/ogg-opus" && artifact.size_bytes > 0));
    }

    #[tokio::test]
    async fn exact_revision_and_operation_kind_are_enforced() {
        let root = tempdir().unwrap();
        let store = Arc::new(RecordStore::new(root.path().join("records"), None));
        let manager = RecordingManager::with_backend(store, Arc::new(FakeBackend), false);
        let started = manager
            .start(RecordingStartInput {
                operation_id: "same-op".to_string(),
                selection: CaptureSelection {
                    microphone: true,
                    system: false,
                },
            })
            .await
            .unwrap();
        let wrong_kind = manager
            .pause(RecordingCommandInput {
                record_id: started.snapshot.record_id.clone(),
                expected_revision: started.snapshot.revision,
                operation_id: "same-op".to_string(),
            })
            .await
            .unwrap_err();
        assert_eq!(wrong_kind, "RECORDING_OPERATION_ID_REUSED");
        let stale = manager
            .pause(RecordingCommandInput {
                record_id: started.snapshot.record_id,
                expected_revision: 1,
                operation_id: "pause-stale".to_string(),
            })
            .await
            .unwrap_err();
        assert!(stale.starts_with("RECORDING_REVISION_CONFLICT"));
    }

    #[tokio::test]
    async fn startup_recovery_never_reopens_devices_and_commits_available_audio() {
        let root = tempdir().unwrap();
        let store = Arc::new(RecordStore::new(root.path().join("records"), None));
        let record = store
            .create_audio(AudioRecordCreateInput {
                title: "recover me".to_string(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Unavailable,
            })
            .await
            .unwrap();
        let workspace = store.audio_workspace_path(&record.id).await.unwrap();
        let archive = TrackArchiveHandle::start(
            AudioTrackKind::Microphone,
            workspace.join(audio_track_relative_path(AudioTrackKind::Microphone)),
            super::super::archive::SourceFormat {
                sample_rate: 48_000,
                channels: 1,
            },
        )
        .unwrap();
        archive.sink.push_f32(&vec![0.04; 96_000]);
        archive.finish().unwrap();
        store
            .update_audio_capture(&record.id, CaptureStatus::Recording, 2_000, None)
            .await
            .unwrap();

        let manager = RecordingManager::with_backend(store.clone(), Arc::new(FakeBackend), false);
        manager.recover_interrupted().await;
        assert!(manager.snapshot().await.is_none());
        let recovered = store.get(&record.id).await.unwrap();
        assert_eq!(
            recovered.audio.as_ref().unwrap().capture_status,
            CaptureStatus::Interrupted
        );
        assert_eq!(recovered.artifacts.len(), 1);
        assert!(recovered.audio.as_ref().unwrap().media_duration_ms >= 2_000);

        let empty = store
            .create_audio(AudioRecordCreateInput {
                title: "never opened".to_string(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Unavailable,
            })
            .await
            .unwrap();
        manager.recover_interrupted().await;
        let empty = store.get(&empty.id).await.unwrap();
        assert_eq!(
            empty.audio.as_ref().unwrap().capture_status,
            CaptureStatus::Failed
        );
        assert!(empty.artifacts.is_empty());
    }
}
