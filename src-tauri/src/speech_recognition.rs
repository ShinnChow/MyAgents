//! App-owned speech workload metadata, recovery, and scheduling authority.
//!
//! The media Worker owns one exact generation's decode/inference state. This
//! module owns durable job identity and decides whether a Worker result may
//! become an Agent artifact or a Record projection.

use crate::local_inference::{
    ComputeWorkloadIdentity, ComputeWorkloadKind, InferenceRuntimeKind, LocalComputeCoordinator,
    LocalComputeLease, LocalInferenceRuntimeIdentity, LocalInferenceRuntimeRegistry,
};
use crate::process_cmd;
use crate::record::{
    AudioTrackKind, DiarizationStatus, ManagedRecordStore, RecordKind, RecordSpeakerTurn,
    RecordSpeechProvenance, RecordTranscriptSegment, TranscriptionStatus,
};
use chrono::{DateTime, Duration, Utc};
use myagents_media_worker_protocol::{
    read_worker_response, write_control_frame, RecordArtifactInput, SpeakerTurn, StartRequest,
    TrackKind, WorkerCommand, WorkerMetrics, WorkerResponse, WorkerStage, WorkloadIdentity,
    WorkloadInput, WorkloadKind, PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, ChildStdout, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Notify;
use uuid::Uuid;
use zeroize::Zeroize;

const JOB_SCHEMA_VERSION: u32 = 1;
const MAX_JOB_METADATA_BYTES: u64 = 1024 * 1024;
const MAX_WORKER_ATTEMPTS: u32 = 3;
const MAX_WORKER_STDERR_BYTES: u64 = 64 * 1024;
const MAX_PENDING_JOBS: usize = 256;
const YIELD_GRACE_SECONDS: u64 = 15;
const MAX_TRANSCRIPT_SEGMENTS: usize = 100_000;
const MAX_TRANSCRIPT_CHARACTERS: usize = 5_000_000;
const MAX_DIARIZATION_TURNS: usize = 200_000;
pub const SPEECH_HISTORY_RETENTION_DAYS: i64 = 30;

pub type ManagedSpeechRecognition = Arc<SpeechRecognitionManager>;

static SPEECH_RECOGNITION: OnceLock<ManagedSpeechRecognition> = OnceLock::new();

pub fn set_global(manager: ManagedSpeechRecognition) -> Result<(), String> {
    SPEECH_RECOGNITION
        .set(manager)
        .map_err(|_| "SpeechRecognitionManager already initialized".to_string())
}

pub fn global() -> Option<&'static ManagedSpeechRecognition> {
    SPEECH_RECOGNITION.get()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechJobState {
    Queued,
    Running,
    Cancelling,
    Succeeded,
    SucceededWithWarnings,
    Failed,
    Cancelled,
    Interrupted,
}

impl SpeechJobState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded
                | Self::SucceededWithWarnings
                | Self::Failed
                | Self::Cancelled
                | Self::Interrupted
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechJobKind {
    AgentAttachmentAsr,
    RecordBackfillAsr,
    RecordDiarization,
}

impl SpeechJobKind {
    fn is_agent(self) -> bool {
        matches!(self, Self::AgentAttachmentAsr)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechJobStage {
    Validating,
    Copying,
    Decoding,
    Transcribing,
    Diarizing,
    Publishing,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum SpeechJobOrigin {
    Agent {
        initiator_session_id: String,
        workspace_identity: String,
    },
    Record {
        record_id: String,
    },
}

impl std::fmt::Debug for SpeechJobOrigin {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Agent { .. } => formatter.write_str("SpeechJobOrigin::Agent([REDACTED])"),
            Self::Record { record_id } => formatter
                .debug_struct("SpeechJobOrigin::Record")
                .field("record_id", record_id)
                .finish(),
        }
    }
}

impl SpeechJobOrigin {
    fn agent_session_id(&self) -> Option<&str> {
        match self {
            Self::Agent {
                initiator_session_id,
                ..
            } => Some(initiator_session_id),
            Self::Record { .. } => None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechJobSource {
    pub path: String,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_kind: Option<String>,
}

impl std::fmt::Debug for SpeechJobSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SpeechJobSource")
            .field("path", &"[REDACTED]")
            .field("size_bytes", &self.size_bytes)
            .field("has_sha256", &self.sha256.is_some())
            .field("media_kind", &self.media_kind)
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechJobOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_markdown_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_json_path: Option<String>,
    pub artifact_available: bool,
}

impl std::fmt::Debug for SpeechJobOutput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SpeechJobOutput")
            .field("paths", &"[REDACTED]")
            .field("artifact_available", &self.artifact_available)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechJobError {
    pub code: String,
    pub retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechJobMetrics {
    pub source_samples: u64,
    pub segments: u32,
    pub speakers: u32,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_working_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechPipelineSnapshot {
    pub provider: String,
    pub model_pack_revision: String,
    pub onnx_runtime_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechJob {
    pub schema_version: u32,
    pub job_id: String,
    pub kind: SpeechJobKind,
    pub state: SpeechJobState,
    pub stage: SpeechJobStage,
    pub origin: SpeechJobOrigin,
    pub source: SpeechJobSource,
    pub output: SpeechJobOutput,
    pub pipeline: SpeechPipelineSnapshot,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_generation: Option<u64>,
    #[serde(default)]
    pub worker_attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SpeechJobError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<SpeechJobMetrics>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechResourceStatus {
    NotInstalled,
    NativeUnavailable,
    Ready,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCapabilitySnapshot {
    pub resource_status: SpeechResourceStatus,
    pub model_pack_revision: Option<String>,
    pub onnx_runtime_version: Option<String>,
}

struct ManagerState {
    accepting: bool,
    jobs: HashMap<String, SpeechJob>,
    queue: VecDeque<String>,
    active_job: Option<(String, u64)>,
    running: Option<RunningWorker>,
    next_generation: u64,
}

struct RunningWorker {
    job_id: String,
    generation: u64,
    child: Arc<Mutex<process_cmd::ChildTree>>,
    stdin: Arc<Mutex<std::process::ChildStdin>>,
}

type SpawnedWorker = (
    Arc<Mutex<process_cmd::ChildTree>>,
    Arc<Mutex<std::process::ChildStdin>>,
    ChildStdout,
);

#[derive(Clone)]
struct SpeechExecutionResources {
    worker_path: PathBuf,
    native_manifest_path: PathBuf,
    onnx_runtime_path: PathBuf,
    model_pack_manifest_path: PathBuf,
    provenance: RecordSpeechProvenance,
}

#[derive(Default)]
struct SensitiveTranscriptSegments(Vec<RecordTranscriptSegment>);

impl Drop for SensitiveTranscriptSegments {
    fn drop(&mut self) {
        for segment in &mut self.0 {
            segment.text.zeroize();
            if let Some(language) = &mut segment.language {
                language.zeroize();
            }
        }
    }
}

enum SpeechWorkerOutcome {
    Completed {
        transcripts: SensitiveTranscriptSegments,
        turns: Vec<RecordSpeakerTurn>,
        metrics: WorkerMetrics,
    },
    Yielded,
    Failed {
        code: String,
        retryable: bool,
    },
}

pub struct SpeechRecognitionManager {
    root: PathBuf,
    native_manifest_path: PathBuf,
    worker_path: PathBuf,
    model_pack_manifest_path: PathBuf,
    runtime_identity: Option<LocalInferenceRuntimeIdentity>,
    compute_coordinator: Arc<LocalComputeCoordinator>,
    record_store: ManagedRecordStore,
    state: Mutex<ManagerState>,
    wake: Notify,
}

impl SpeechRecognitionManager {
    pub fn initialize(
        data_root: PathBuf,
        resource_root: PathBuf,
        runtime_registry: &LocalInferenceRuntimeRegistry,
        compute_coordinator: Arc<LocalComputeCoordinator>,
        record_store: ManagedRecordStore,
    ) -> Result<ManagedSpeechRecognition, String> {
        Self::initialize_inner(
            data_root,
            resource_root,
            runtime_registry,
            compute_coordinator,
            record_store,
            true,
        )
    }

    fn initialize_inner(
        data_root: PathBuf,
        resource_root: PathBuf,
        runtime_registry: &LocalInferenceRuntimeRegistry,
        compute_coordinator: Arc<LocalComputeCoordinator>,
        record_store: ManagedRecordStore,
        start_runner: bool,
    ) -> Result<ManagedSpeechRecognition, String> {
        let root = data_root.join("speech-recognition");
        for directory in [
            root.clone(),
            root.join("jobs"),
            root.join("private"),
            root.join("models"),
        ] {
            ensure_private_directory(&directory)?;
        }

        let native_root = resource_root.join("speech-inference").join("v1");
        let worker_name = if cfg!(windows) {
            "myagents-media-worker.exe"
        } else {
            "myagents-media-worker"
        };
        let runtime_identity = runtime_registry
            .identity(InferenceRuntimeKind::OnnxCpu)
            .ok();
        let mut jobs = load_jobs(&root)?;
        recover_nonterminal_jobs(&root, &mut jobs);
        prune_expired_jobs(&root, &mut jobs);
        let queue = recovered_record_queue(&jobs);

        let manager = Arc::new(Self {
            root: root.clone(),
            native_manifest_path: native_root.join("manifest.json"),
            worker_path: native_root.join(worker_name),
            model_pack_manifest_path: root.join("models").join("active").join("manifest.json"),
            runtime_identity,
            compute_coordinator,
            record_store,
            state: Mutex::new(ManagerState {
                accepting: true,
                jobs,
                queue,
                active_job: None,
                running: None,
                next_generation: 1,
            }),
            wake: Notify::new(),
        });
        if start_runner {
            let runner = Arc::clone(&manager);
            tauri::async_runtime::spawn(async move { runner.run_queue().await });
            if !manager.queue_snapshot()?.is_empty() {
                manager.wake.notify_one();
            }
        }
        Ok(manager)
    }

    pub fn capability_snapshot(&self) -> SpeechCapabilitySnapshot {
        let native_ready = plain_file(&self.worker_path) && plain_file(&self.native_manifest_path);
        let model_pack_revision = verify_model_pack(&self.model_pack_manifest_path);
        let resource_status = if !native_ready || self.runtime_identity.is_none() {
            SpeechResourceStatus::NativeUnavailable
        } else if model_pack_revision.is_none() {
            SpeechResourceStatus::NotInstalled
        } else {
            SpeechResourceStatus::Ready
        };
        SpeechCapabilitySnapshot {
            resource_status,
            model_pack_revision,
            onnx_runtime_version: self
                .runtime_identity
                .as_ref()
                .map(|identity| identity.version().to_string()),
        }
    }

    fn execution_resources(&self) -> Result<SpeechExecutionResources, &'static str> {
        if !plain_file(&self.worker_path) || !plain_file(&self.native_manifest_path) {
            return Err("SPEECH_NATIVE_RUNTIME_UNAVAILABLE");
        }
        let runtime = self
            .runtime_identity
            .as_ref()
            .ok_or("SPEECH_NATIVE_RUNTIME_UNAVAILABLE")?;
        let model_pack_revision = verify_model_pack(&self.model_pack_manifest_path)
            .ok_or("SPEECH_MODEL_PACK_UNAVAILABLE")?;
        Ok(SpeechExecutionResources {
            worker_path: self.worker_path.clone(),
            native_manifest_path: self.native_manifest_path.clone(),
            onnx_runtime_path: runtime.path().to_path_buf(),
            model_pack_manifest_path: self.model_pack_manifest_path.clone(),
            provenance: RecordSpeechProvenance {
                provider: "local".into(),
                model_pack_revision,
                onnx_runtime_version: runtime.version().to_string(),
            },
        })
    }

    pub async fn submit_record_backfill(
        self: &Arc<Self>,
        record_id: &str,
    ) -> Result<SpeechJob, String> {
        validate_job_id(record_id).map_err(str::to_string)?;
        let resources = self.execution_resources().map_err(str::to_string)?;
        let record = self
            .record_store
            .get(record_id)
            .await
            .ok_or_else(|| "SPEECH_RECORD_NOT_FOUND".to_string())?;
        if record.kind != RecordKind::Audio
            || record
                .audio
                .as_ref()
                .map_or(true, |audio| audio.tracks.is_empty())
        {
            return Err("SPEECH_RECORD_AUDIO_UNAVAILABLE".to_string());
        }

        let source_size = record
            .artifacts
            .iter()
            .filter(|artifact| artifact.kind == "audio/ogg-opus")
            .try_fold(0_u64, |total, artifact| {
                total.checked_add(artifact.size_bytes)
            })
            .ok_or_else(|| "SPEECH_MEDIA_LIMIT_EXCEEDED".to_string())?;
        if source_size == 0 {
            return Err("SPEECH_RECORD_AUDIO_UNAVAILABLE".to_string());
        }

        let job = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
            if !state.accepting {
                return Err("SPEECH_MANAGER_SHUTTING_DOWN".to_string());
            }
            if let Some(existing) = state.jobs.values().find(|job| {
                job.kind == SpeechJobKind::RecordBackfillAsr
                    && !job.state.is_terminal()
                    && matches!(
                        &job.origin,
                        SpeechJobOrigin::Record { record_id: existing } if existing == record_id
                    )
            }) {
                return Ok(existing.clone());
            }
            if state.queue.len() >= MAX_PENDING_JOBS {
                return Err("SPEECH_QUEUE_FULL".to_string());
            }
            let now = Utc::now();
            let job = SpeechJob {
                schema_version: JOB_SCHEMA_VERSION,
                job_id: new_job_id(),
                kind: SpeechJobKind::RecordBackfillAsr,
                state: SpeechJobState::Queued,
                stage: SpeechJobStage::Validating,
                origin: SpeechJobOrigin::Record {
                    record_id: record_id.to_string(),
                },
                source: SpeechJobSource {
                    path: format!("record:{record_id}"),
                    size_bytes: source_size,
                    sha256: None,
                    media_kind: Some("record/ogg-opus".into()),
                },
                output: empty_output(),
                pipeline: pipeline_from_provenance(&resources.provenance),
                created_at: now,
                updated_at: now,
                started_at: None,
                finished_at: None,
                worker_generation: None,
                worker_attempts: 0,
                error: None,
                metrics: None,
            };
            persist_job(&self.root, &job)?;
            state.queue.push_back(job.job_id.clone());
            state.jobs.insert(job.job_id.clone(), job.clone());
            job
        };

        if let Err(error) = self
            .record_store
            .update_audio_processing_status(record_id, Some(TranscriptionStatus::Queued), None)
            .await
        {
            self.fail_admission(&job.job_id, "SPEECH_RECORD_UPDATE_FAILED");
            return Err(format!("SPEECH_RECORD_UPDATE_FAILED: {error}"));
        }
        self.wake.notify_one();
        Ok(job)
    }

    fn fail_admission(&self, job_id: &str, code: &str) {
        let snapshot = if let Ok(mut state) = self.state.lock() {
            state.queue.retain(|queued| queued != job_id);
            state.jobs.get_mut(job_id).map(|job| {
                let now = Utc::now();
                job.state = SpeechJobState::Failed;
                job.updated_at = now;
                job.finished_at = Some(now);
                job.error = Some(SpeechJobError {
                    code: code.into(),
                    retryable: true,
                });
                job.clone()
            })
        } else {
            None
        };
        if let Some(snapshot) = snapshot {
            let _ = persist_job(&self.root, &snapshot);
        }
    }

    pub fn get_agent_job(&self, session_id: &str, job_id: &str) -> Result<SpeechJob, &'static str> {
        validate_session_id(session_id)?;
        validate_job_id(job_id)?;
        self.state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?
            .jobs
            .get(job_id)
            .filter(|job| job.kind.is_agent())
            .filter(|job| job.origin.agent_session_id() == Some(session_id))
            .cloned()
            .ok_or("SPEECH_JOB_NOT_FOUND")
    }

    pub fn list_agent_jobs(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<SpeechJob>, &'static str> {
        validate_session_id(session_id)?;
        if !(1..=100).contains(&limit) {
            return Err("SPEECH_LIST_LIMIT_INVALID");
        }
        let state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        let mut jobs = state
            .jobs
            .values()
            .filter(|job| job.kind.is_agent())
            .filter(|job| job.origin.agent_session_id() == Some(session_id))
            .cloned()
            .collect::<Vec<_>>();
        jobs.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        jobs.truncate(limit);
        Ok(jobs)
    }

    pub fn shutdown(&self) -> Result<(), String> {
        let (snapshots, running) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "speech manager lock poisoned".to_string())?;
            state.accepting = false;
            state.active_job = None;
            state.queue.clear();
            let running = state.running.take();
            let now = Utc::now();
            let mut snapshots = Vec::new();
            for job in state
                .jobs
                .values_mut()
                .filter(|job| !job.state.is_terminal())
            {
                settle_for_process_boundary(job, now);
                snapshots.push(job.clone());
            }
            (snapshots, running)
        };
        if let Some(running) = running {
            let identity = WorkloadIdentity {
                workload_id: running.job_id.clone(),
                worker_generation: running.generation,
            };
            let _ = send_worker_command(
                &running.stdin,
                &WorkerCommand::Cancel {
                    protocol_version: PROTOCOL_VERSION,
                    identity,
                },
            );
            if let Ok(mut child) = running.child.lock() {
                let _ = child.kill_and_wait();
            }
        }
        for job in snapshots {
            persist_job(&self.root, &job)?;
        }
        self.wake.notify_waiters();
        Ok(())
    }

    pub fn queue_snapshot(&self) -> Result<Vec<String>, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "speech manager lock poisoned".to_string())?;
        let _next_generation = state.next_generation;
        Ok(state.queue.iter().cloned().collect())
    }

    pub fn active_compute_workload(&self) -> Option<String> {
        self.compute_coordinator
            .active_identity()
            .map(|identity| identity.id)
    }

    pub fn record_root(&self) -> &Path {
        self.record_store.root_dir()
    }

    async fn run_queue(self: Arc<Self>) {
        loop {
            self.wake.notified().await;
            loop {
                let next = match self.take_next_job() {
                    Ok(next) => next,
                    Err(error) => {
                        crate::ulog_error!("[speech] queue state error: {}", error);
                        break;
                    }
                };
                let Some((job, generation)) = next else {
                    break;
                };
                let resources = self.execution_resources();
                let compute = ComputeWorkloadIdentity {
                    kind: compute_kind(job.kind),
                    id: job.job_id.clone(),
                    generation,
                };
                let manager = Arc::clone(&self);
                let job_id = job.job_id.clone();
                let result = match resources {
                    Ok(resources) => {
                        let lease = self.compute_coordinator.acquire(compute).await;
                        if !self.job_can_execute(&job_id, generation) {
                            drop(lease);
                            self.clear_active(&job_id, generation);
                            continue;
                        }
                        tauri::async_runtime::spawn_blocking(move || {
                            manager.execute_record_job(&job, generation, resources, lease)
                        })
                        .await
                    }
                    Err(code) => {
                        tauri::async_runtime::spawn_blocking(move || {
                            manager.finish_failed(&job, generation, code, false)
                        })
                        .await
                    }
                };
                if let Err(error) = result {
                    let manager = Arc::clone(&self);
                    let failed_job_id = job_id.clone();
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        manager.finish_join_failure(&failed_job_id, generation)
                    })
                    .await;
                    crate::ulog_error!("[speech] Worker join failed: {}", error);
                }
                self.clear_active(&job_id, generation);
            }
        }
    }

    fn take_next_job(&self) -> Result<Option<(SpeechJob, u64)>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "speech manager lock poisoned".to_string())?;
        if !state.accepting || state.active_job.is_some() {
            return Ok(None);
        }
        let Some(job_id) = state.queue.front().cloned() else {
            return Ok(None);
        };
        let generation = state.next_generation;
        let now = Utc::now();
        let mut job = state
            .jobs
            .get(&job_id)
            .cloned()
            .ok_or_else(|| "queued speech job is missing".to_string())?;
        if job.state != SpeechJobState::Queued || job.kind.is_agent() {
            return Err("speech queue contains an ineligible job".to_string());
        }
        job.state = SpeechJobState::Running;
        job.stage = SpeechJobStage::Validating;
        job.started_at = Some(now);
        job.updated_at = now;
        job.finished_at = None;
        job.worker_generation = Some(generation);
        job.worker_attempts = job.worker_attempts.saturating_add(1);
        job.error = None;
        persist_job(&self.root, &job)?;
        state.queue.pop_front();
        state.jobs.insert(job_id.clone(), job.clone());
        state.active_job = Some((job_id, generation));
        state.next_generation = state.next_generation.saturating_add(1).max(1);
        Ok(Some((job, generation)))
    }

    fn execute_record_job(
        self: &Arc<Self>,
        job: &SpeechJob,
        generation: u64,
        resources: SpeechExecutionResources,
        lease: LocalComputeLease,
    ) {
        if !self.update_generation_pipeline(job, generation, &resources.provenance) {
            self.finish_failed(job, generation, "SPEECH_JOB_STORE_WRITE_FAILED", true);
            return;
        }
        if let Err(code) = self.update_record_running_status(job, generation) {
            self.finish_failed(job, generation, code, true);
            return;
        }
        let input = match self.resolve_record_worker_input(job, generation) {
            Ok(input) => input,
            Err(code) => {
                self.finish_failed(job, generation, code, false);
                return;
            }
        };
        let lifecycle_spawn_permit = match crate::sidecar::begin_lifecycle_spawn_permit() {
            Ok(permit) => permit,
            Err(_) => {
                self.finish_interrupted_if_needed(job, generation);
                return;
            }
        };
        let (child, stdin, stdout) = match self.spawn_registered_worker(job, generation, &resources)
        {
            Ok(worker) => worker,
            Err(code) => {
                self.finish_failed(job, generation, code, true);
                return;
            }
        };
        drop(lifecycle_spawn_permit);

        let identity = WorkloadIdentity {
            workload_id: job.job_id.clone(),
            worker_generation: generation,
        };
        let start = WorkerCommand::Start(StartRequest {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            workload_kind: protocol_workload_kind(job.kind),
            input,
            native_manifest_path: match path_for_protocol(&resources.native_manifest_path) {
                Ok(path) => path,
                Err(code) => {
                    kill_worker(&child);
                    self.clear_running(&job.job_id, generation);
                    self.finish_failed(job, generation, code, false);
                    return;
                }
            },
            onnx_runtime_path: match path_for_protocol(&resources.onnx_runtime_path) {
                Ok(path) => path,
                Err(code) => {
                    kill_worker(&child);
                    self.clear_running(&job.job_id, generation);
                    self.finish_failed(job, generation, code, false);
                    return;
                }
            },
            model_pack_manifest_path: match path_for_protocol(&resources.model_pack_manifest_path) {
                Ok(path) => path,
                Err(code) => {
                    kill_worker(&child);
                    self.clear_running(&job.job_id, generation);
                    self.finish_failed(job, generation, code, false);
                    return;
                }
            },
        });
        if send_worker_command(&stdin, &start).is_err() {
            kill_worker(&child);
            self.clear_running(&job.job_id, generation);
            self.finish_failed(job, generation, "SPEECH_WORKER_PROTOCOL_ERROR", true);
            return;
        }

        let outcome =
            self.collect_worker_result(job, generation, &identity, stdout, &stdin, &child, &lease);
        if let Ok(mut child) = child.lock() {
            let _ = child.wait();
        }
        self.clear_running(&job.job_id, generation);
        if !self.job_can_publish(&job.job_id, generation) {
            return;
        }
        match outcome {
            SpeechWorkerOutcome::Completed {
                transcripts,
                turns,
                metrics,
            } => self.publish_record_success(
                job,
                generation,
                &resources.provenance,
                transcripts,
                turns,
                metrics,
            ),
            SpeechWorkerOutcome::Yielded => self.requeue_yielded(job, generation),
            SpeechWorkerOutcome::Failed { code, retryable } => {
                self.finish_failed(job, generation, &code, retryable)
            }
        }
    }

    fn resolve_record_worker_input(
        &self,
        job: &SpeechJob,
        generation: u64,
    ) -> Result<WorkloadInput, &'static str> {
        if !self.job_can_execute(&job.job_id, generation) {
            return Err("SPEECH_INTERRUPTED");
        }
        let SpeechJobOrigin::Record { record_id } = &job.origin else {
            return Err("SPEECH_WORKLOAD_NOT_READY");
        };
        let record = tauri::async_runtime::block_on(self.record_store.get(record_id))
            .ok_or("SPEECH_RECORD_NOT_FOUND")?;
        let audio = record
            .audio
            .as_ref()
            .filter(|_| record.kind == RecordKind::Audio)
            .ok_or("SPEECH_RECORD_AUDIO_UNAVAILABLE")?;
        let selected = match job.kind {
            SpeechJobKind::RecordBackfillAsr => {
                [AudioTrackKind::Microphone, AudioTrackKind::System]
                    .into_iter()
                    .filter(|track| audio.tracks.contains(track))
                    .collect::<Vec<_>>()
            }
            SpeechJobKind::RecordDiarization => {
                if audio.tracks.contains(&AudioTrackKind::System) {
                    vec![AudioTrackKind::System]
                } else if audio.tracks.contains(&AudioTrackKind::Microphone) {
                    vec![AudioTrackKind::Microphone]
                } else {
                    Vec::new()
                }
            }
            SpeechJobKind::AgentAttachmentAsr => return Err("SPEECH_WORKLOAD_NOT_READY"),
        };
        if selected.is_empty() {
            return Err("SPEECH_NO_AUDIO_TRACK");
        }
        let mut total_size = 0_u64;
        let mut inputs = Vec::with_capacity(selected.len());
        for track in selected {
            let media = tauri::async_runtime::block_on(
                self.record_store
                    .resolve_record_media_for_processing(record_id, track),
            )
            .map_err(|_| "SPEECH_SOURCE_UNSAFE")?;
            total_size = total_size
                .checked_add(media.size_bytes)
                .ok_or("SPEECH_MEDIA_LIMIT_EXCEEDED")?;
            inputs.push(RecordArtifactInput {
                input_path: path_for_protocol(&media.path)?,
                track: protocol_track(track)?,
            });
        }
        if total_size == 0 || total_size > job.source.size_bytes {
            return Err("SPEECH_SOURCE_CHANGED");
        }
        Ok(WorkloadInput::RecordArtifacts { inputs })
    }

    fn spawn_registered_worker(
        &self,
        job: &SpeechJob,
        generation: u64,
        resources: &SpeechExecutionResources,
    ) -> Result<SpawnedWorker, &'static str> {
        let private_dir = self.root.join("private").join(&job.job_id);
        ensure_private_directory(&private_dir).map_err(|_| "SPEECH_JOB_STORE_WRITE_FAILED")?;
        let mut command = process_cmd::new(&resources.worker_path);
        command
            .current_dir(&private_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear();

        let mut state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        if !state.accepting
            || !state
                .active_job
                .as_ref()
                .is_some_and(|active| active == &(job.job_id.clone(), generation))
            || !state.jobs.get(&job.job_id).is_some_and(|current| {
                current.state == SpeechJobState::Running
                    && current.worker_generation == Some(generation)
            })
        {
            return Err("SPEECH_INTERRUPTED");
        }
        let mut child =
            process_cmd::spawn_tree(&mut command).map_err(|_| "SPEECH_WORKER_START_FAILED")?;
        let Some(stdin) = child.stdin.take() else {
            let _ = child.kill_and_wait();
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill_and_wait();
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        };
        let Some(stderr) = child.stderr.take() else {
            let _ = child.kill_and_wait();
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        };
        drain_worker_stderr(stderr, job.job_id.clone(), generation);
        let child = Arc::new(Mutex::new(child));
        let stdin = Arc::new(Mutex::new(stdin));
        state.running = Some(RunningWorker {
            job_id: job.job_id.clone(),
            generation,
            child: Arc::clone(&child),
            stdin: Arc::clone(&stdin),
        });
        Ok((child, stdin, stdout))
    }

    #[allow(clippy::too_many_arguments)]
    fn collect_worker_result(
        &self,
        job: &SpeechJob,
        generation: u64,
        identity: &WorkloadIdentity,
        stdout: ChildStdout,
        stdin: &Arc<Mutex<std::process::ChildStdin>>,
        child: &Arc<Mutex<process_cmd::ChildTree>>,
        lease: &LocalComputeLease,
    ) -> SpeechWorkerOutcome {
        let mut reader = BufReader::new(stdout);
        let mut ready = false;
        let mut yield_sent = false;
        let yield_settled = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _yield_guard = YieldReadGuard(Arc::clone(&yield_settled));
        let mut transcripts = SensitiveTranscriptSegments::default();
        let mut turns = Vec::new();
        let mut transcript_characters = 0_usize;
        let mut next_transcript_revision = 1_u64;
        let mut speaker_revision = None;
        let mut next_speaker_batch = 0_u32;
        let mut speaker_last_seen = false;

        loop {
            let response = match read_worker_response(&mut reader) {
                Ok(Some(response)) => response,
                Ok(None) if yield_sent => return SpeechWorkerOutcome::Yielded,
                Ok(None) => {
                    return failed_outcome("SPEECH_WORKER_CRASHED", true);
                }
                Err(_) if yield_sent => return SpeechWorkerOutcome::Yielded,
                Err(_) => {
                    return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                }
            };
            if response.identity() != identity {
                let mut response = response;
                response.zeroize_sensitive();
                return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
            }

            match response {
                WorkerResponse::Ready { .. } if !ready => ready = true,
                WorkerResponse::Ready { .. } => {
                    return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                }
                WorkerResponse::Heartbeat { stage, .. }
                | WorkerResponse::Progress { stage, .. }
                    if ready =>
                {
                    self.update_worker_stage(&job.job_id, generation, stage);
                }
                WorkerResponse::TranscriptSegment {
                    segment_id,
                    track,
                    start_sample,
                    end_sample,
                    text,
                    language,
                    revision,
                    ..
                } if ready && job.kind == SpeechJobKind::RecordBackfillAsr => {
                    let next_characters = transcript_characters
                        .checked_add(text.chars().count())
                        .filter(|count| *count <= MAX_TRANSCRIPT_CHARACTERS);
                    if revision != next_transcript_revision
                        || transcripts.0.len() >= MAX_TRANSCRIPT_SEGMENTS
                        || next_characters.is_none()
                    {
                        let mut text = text;
                        text.zeroize();
                        let mut language = language;
                        if let Some(language) = &mut language {
                            language.zeroize();
                        }
                        return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                    }
                    transcript_characters = next_characters.expect("checked above");
                    let Some(next_revision) = next_transcript_revision.checked_add(1) else {
                        return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                    };
                    next_transcript_revision = next_revision;
                    transcripts.0.push(RecordTranscriptSegment {
                        segment_id,
                        track: match record_track(track) {
                            Ok(track) => track,
                            Err(code) => return failed_outcome(code, false),
                        },
                        start_sample,
                        end_sample,
                        text,
                        language,
                        revision,
                    });
                }
                WorkerResponse::SpeakerTurnBatch {
                    revision,
                    batch_index,
                    is_last,
                    turns: batch,
                    ..
                } if ready && job.kind == SpeechJobKind::RecordDiarization => {
                    if speaker_last_seen
                        || batch_index != next_speaker_batch
                        || speaker_revision.is_some_and(|expected| expected != revision)
                    {
                        return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                    }
                    speaker_revision.get_or_insert(revision);
                    let Some(next_batch) = next_speaker_batch.checked_add(1) else {
                        return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                    };
                    if turns
                        .len()
                        .checked_add(batch.len())
                        .map_or(true, |count| count > MAX_DIARIZATION_TURNS)
                    {
                        return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                    }
                    next_speaker_batch = next_batch;
                    speaker_last_seen = is_last;
                    turns.extend(batch.into_iter().map(record_speaker_turn));
                }
                WorkerResponse::Pong { .. } if ready => {}
                WorkerResponse::Yielded { .. } if ready && yield_sent => {
                    return SpeechWorkerOutcome::Yielded;
                }
                WorkerResponse::Completed { metrics, .. } if ready => {
                    if !completed_shape_matches(
                        job.kind,
                        &transcripts.0,
                        &turns,
                        speaker_last_seen,
                        &metrics,
                    ) {
                        return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                    }
                    transcripts.0.sort_by(|left, right| {
                        (left.start_sample, left.end_sample, left.segment_id.as_str()).cmp(&(
                            right.start_sample,
                            right.end_sample,
                            right.segment_id.as_str(),
                        ))
                    });
                    return SpeechWorkerOutcome::Completed {
                        transcripts,
                        turns,
                        metrics,
                    };
                }
                WorkerResponse::Failed { code, .. } => {
                    let retryable = worker_code_retryable(&code);
                    return SpeechWorkerOutcome::Failed { code, retryable };
                }
                mut response @ WorkerResponse::TranscriptSegment { .. } => {
                    response.zeroize_sensitive();
                    return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                }
                _ => return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true),
            }

            if ready
                && !yield_sent
                && protocol_workload_kind(job.kind).can_cooperatively_yield()
                && lease.should_yield()
            {
                let command = WorkerCommand::Yield {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                };
                if send_worker_command(stdin, &command).is_err() {
                    return failed_outcome("SPEECH_WORKER_PROTOCOL_ERROR", true);
                }
                yield_sent = true;
                arm_yield_watchdog(child, &yield_settled);
            }
        }
    }

    fn update_worker_stage(&self, job_id: &str, generation: u64, stage: WorkerStage) {
        let stage = speech_stage(stage);
        let snapshot = if let Ok(mut state) = self.state.lock() {
            state.jobs.get_mut(job_id).and_then(|job| {
                (job.state == SpeechJobState::Running
                    && job.worker_generation == Some(generation)
                    && job.stage != stage)
                    .then(|| {
                        job.stage = stage;
                        job.updated_at = Utc::now();
                        job.clone()
                    })
            })
        } else {
            None
        };
        if let Some(snapshot) = snapshot {
            let _ = persist_job(&self.root, &snapshot);
        }
    }

    fn publish_record_success(
        &self,
        source_job: &SpeechJob,
        generation: u64,
        provenance: &RecordSpeechProvenance,
        mut transcripts: SensitiveTranscriptSegments,
        turns: Vec<RecordSpeakerTurn>,
        metrics: WorkerMetrics,
    ) {
        let SpeechJobOrigin::Record { record_id } = &source_job.origin else {
            self.finish_failed(source_job, generation, "SPEECH_WORKLOAD_NOT_READY", false);
            return;
        };
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        if !exact_running_generation(&state, &source_job.job_id, generation) {
            return;
        }
        if let Some(job) = state.jobs.get_mut(&source_job.job_id) {
            job.stage = SpeechJobStage::Publishing;
            job.updated_at = Utc::now();
            let _ = persist_job(&self.root, job);
        }

        let commit = match source_job.kind {
            SpeechJobKind::RecordBackfillAsr => {
                tauri::async_runtime::block_on(self.record_store.commit_recording_final_transcript(
                    record_id,
                    std::mem::take(&mut transcripts.0),
                    provenance.clone(),
                ))
                .map(|_| ())
            }
            SpeechJobKind::RecordDiarization => tauri::async_runtime::block_on(
                self.record_store
                    .commit_diarization_result(record_id, turns, provenance.clone()),
            )
            .map(|_| ()),
            SpeechJobKind::AgentAttachmentAsr => Err("Agent publication is not ready".into()),
        };
        if commit.is_err() {
            finish_job_locked(
                &self.root,
                &mut state,
                &source_job.job_id,
                generation,
                SpeechJobState::Failed,
                Some(SpeechJobError {
                    code: "SPEECH_PUBLISH_FAILED".into(),
                    retryable: true,
                }),
                None,
            );
            update_record_terminal_status(&self.record_store, source_job.kind, record_id, false);
            return;
        }

        let job_metrics = SpeechJobMetrics {
            source_samples: metrics.source_samples,
            segments: metrics.segments,
            speakers: metrics.speakers,
            elapsed_ms: metrics.elapsed_ms,
            peak_working_bytes: metrics.peak_working_bytes,
        };
        finish_job_locked(
            &self.root,
            &mut state,
            &source_job.job_id,
            generation,
            SpeechJobState::Succeeded,
            None,
            Some(job_metrics),
        );
        if source_job.kind == SpeechJobKind::RecordBackfillAsr {
            if enqueue_diarization_locked(
                &self.root,
                &mut state,
                record_id,
                source_job.source.size_bytes,
                provenance,
            )
            .is_err()
            {
                if let Some(job) = state.jobs.get_mut(&source_job.job_id) {
                    job.state = SpeechJobState::SucceededWithWarnings;
                    job.error = Some(SpeechJobError {
                        code: "SPEECH_DIARIZATION_QUEUE_FAILED".into(),
                        retryable: true,
                    });
                    let _ = persist_job(&self.root, job);
                }
                update_record_terminal_status(
                    &self.record_store,
                    SpeechJobKind::RecordDiarization,
                    record_id,
                    false,
                );
            } else {
                self.wake.notify_one();
            }
        }
    }

    fn requeue_yielded(&self, source_job: &SpeechJob, generation: u64) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if !exact_running_generation(&state, &source_job.job_id, generation) {
            return;
        }
        let snapshot = state.jobs.get_mut(&source_job.job_id).map(|job| {
            job.state = SpeechJobState::Queued;
            job.stage = SpeechJobStage::Validating;
            job.updated_at = Utc::now();
            job.started_at = None;
            job.worker_generation = None;
            job.worker_attempts = job.worker_attempts.saturating_sub(1);
            job.error = None;
            job.clone()
        });
        state.queue.push_front(source_job.job_id.clone());
        if let Some(snapshot) = snapshot {
            let _ = persist_job(&self.root, &snapshot);
        }
        if let SpeechJobOrigin::Record { record_id } = &source_job.origin {
            update_record_queued_status(&self.record_store, source_job.kind, record_id);
        }
    }

    fn finish_failed(&self, source_job: &SpeechJob, generation: u64, code: &str, retryable: bool) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if !exact_running_generation(&state, &source_job.job_id, generation) {
            return;
        }
        let queued = retryable
            && state.accepting
            && state
                .jobs
                .get(&source_job.job_id)
                .is_some_and(|job| job.worker_attempts < MAX_WORKER_ATTEMPTS);
        if queued {
            if let Some(job) = state.jobs.get_mut(&source_job.job_id) {
                job.state = SpeechJobState::Queued;
                job.stage = SpeechJobStage::Validating;
                job.updated_at = Utc::now();
                job.started_at = None;
                job.worker_generation = None;
                job.error = Some(SpeechJobError {
                    code: code.into(),
                    retryable: true,
                });
                let snapshot = job.clone();
                let _ = persist_job(&self.root, &snapshot);
            }
            state.queue.push_back(source_job.job_id.clone());
        } else {
            finish_job_locked(
                &self.root,
                &mut state,
                &source_job.job_id,
                generation,
                if code == "SPEECH_CANCELLED" {
                    SpeechJobState::Cancelled
                } else if code == "SPEECH_INTERRUPTED" {
                    SpeechJobState::Interrupted
                } else {
                    SpeechJobState::Failed
                },
                Some(SpeechJobError {
                    code: code.into(),
                    retryable,
                }),
                None,
            );
        }
        if let SpeechJobOrigin::Record { record_id } = &source_job.origin {
            if queued {
                update_record_queued_status(&self.record_store, source_job.kind, record_id);
                self.wake.notify_one();
            } else {
                update_record_terminal_status(
                    &self.record_store,
                    source_job.kind,
                    record_id,
                    false,
                );
            }
        }
    }

    fn finish_interrupted_if_needed(&self, job: &SpeechJob, generation: u64) {
        self.finish_failed(job, generation, "SPEECH_INTERRUPTED", true);
    }

    fn finish_join_failure(&self, job_id: &str, generation: u64) {
        let job = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.jobs.get(job_id).cloned());
        if let Some(job) = job {
            self.finish_failed(&job, generation, "SPEECH_WORKER_CRASHED", true);
        }
    }

    fn update_record_running_status(
        &self,
        job: &SpeechJob,
        generation: u64,
    ) -> Result<(), &'static str> {
        let SpeechJobOrigin::Record { record_id } = &job.origin else {
            return Err("SPEECH_WORKLOAD_NOT_READY");
        };
        let state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        if !exact_running_generation(&state, &job.job_id, generation) {
            return Err("SPEECH_INTERRUPTED");
        }
        let result = match job.kind {
            SpeechJobKind::RecordBackfillAsr => {
                tauri::async_runtime::block_on(self.record_store.update_audio_processing_status(
                    record_id,
                    Some(TranscriptionStatus::Finalizing),
                    None,
                ))
            }
            SpeechJobKind::RecordDiarization => {
                tauri::async_runtime::block_on(self.record_store.update_audio_processing_status(
                    record_id,
                    None,
                    Some(DiarizationStatus::Running),
                ))
            }
            SpeechJobKind::AgentAttachmentAsr => return Err("SPEECH_WORKLOAD_NOT_READY"),
        };
        result
            .map(|_| ())
            .map_err(|_| "SPEECH_RECORD_UPDATE_FAILED")
    }

    fn update_generation_pipeline(
        &self,
        job: &SpeechJob,
        generation: u64,
        provenance: &RecordSpeechProvenance,
    ) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if !exact_running_generation(&state, &job.job_id, generation) {
            return false;
        }
        let Some(current) = state.jobs.get_mut(&job.job_id) else {
            return false;
        };
        current.pipeline = pipeline_from_provenance(provenance);
        current.updated_at = Utc::now();
        persist_job(&self.root, current).is_ok()
    }

    fn job_can_execute(&self, job_id: &str, generation: u64) -> bool {
        self.state.lock().ok().is_some_and(|state| {
            state.accepting && exact_running_generation(&state, job_id, generation)
        })
    }

    fn job_can_publish(&self, job_id: &str, generation: u64) -> bool {
        self.state
            .lock()
            .ok()
            .is_some_and(|state| exact_running_generation(&state, job_id, generation))
    }

    fn clear_running(&self, job_id: &str, generation: u64) {
        if let Ok(mut state) = self.state.lock() {
            if state
                .running
                .as_ref()
                .is_some_and(|running| running.job_id == job_id && running.generation == generation)
            {
                state.running = None;
            }
        }
    }

    fn clear_active(&self, job_id: &str, generation: u64) {
        if let Ok(mut state) = self.state.lock() {
            if state
                .active_job
                .as_ref()
                .is_some_and(|active| active == &(job_id.to_string(), generation))
            {
                state.active_job = None;
            }
        }
    }
}

struct YieldReadGuard(Arc<std::sync::atomic::AtomicBool>);

impl Drop for YieldReadGuard {
    fn drop(&mut self) {
        self.0.store(true, std::sync::atomic::Ordering::Release);
    }
}

fn exact_running_generation(state: &ManagerState, job_id: &str, generation: u64) -> bool {
    state
        .active_job
        .as_ref()
        .is_some_and(|(active_id, active_generation)| {
            active_id == job_id && *active_generation == generation
        })
        && state.jobs.get(job_id).is_some_and(|job| {
            job.state == SpeechJobState::Running && job.worker_generation == Some(generation)
        })
}

fn compute_kind(kind: SpeechJobKind) -> ComputeWorkloadKind {
    match kind {
        SpeechJobKind::AgentAttachmentAsr => ComputeWorkloadKind::AgentAttachmentAsr,
        SpeechJobKind::RecordBackfillAsr => ComputeWorkloadKind::RecordBackfill,
        SpeechJobKind::RecordDiarization => ComputeWorkloadKind::RecordDiarization,
    }
}

fn protocol_workload_kind(kind: SpeechJobKind) -> WorkloadKind {
    match kind {
        SpeechJobKind::AgentAttachmentAsr => WorkloadKind::AttachmentAsr,
        SpeechJobKind::RecordBackfillAsr => WorkloadKind::RecordBackfillAsr,
        SpeechJobKind::RecordDiarization => WorkloadKind::RecordDiarization,
    }
}

fn protocol_track(track: AudioTrackKind) -> Result<TrackKind, &'static str> {
    match track {
        AudioTrackKind::Microphone => Ok(TrackKind::Microphone),
        AudioTrackKind::System => Ok(TrackKind::System),
        AudioTrackKind::Mixed => Err("SPEECH_NO_AUDIO_TRACK"),
    }
}

fn record_track(track: TrackKind) -> Result<AudioTrackKind, &'static str> {
    match track {
        TrackKind::Microphone => Ok(AudioTrackKind::Microphone),
        TrackKind::System => Ok(AudioTrackKind::System),
        TrackKind::Mixed | TrackKind::Attachment => Err("SPEECH_WORKER_PROTOCOL_ERROR"),
    }
}

fn record_speaker_turn(turn: SpeakerTurn) -> RecordSpeakerTurn {
    RecordSpeakerTurn {
        start_sample: turn.start_sample,
        end_sample: turn.end_sample,
        global_speaker: turn.global_speaker,
    }
}

fn speech_stage(stage: WorkerStage) -> SpeechJobStage {
    match stage {
        WorkerStage::Loading | WorkerStage::Decoding => SpeechJobStage::Decoding,
        WorkerStage::Vad | WorkerStage::Transcribing => SpeechJobStage::Transcribing,
        WorkerStage::SegmentingSpeakers
        | WorkerStage::EmbeddingSpeakers
        | WorkerStage::ClusteringSpeakers
        | WorkerStage::ReconcilingSpeakers => SpeechJobStage::Diarizing,
        WorkerStage::Finalizing => SpeechJobStage::Publishing,
    }
}

fn completed_shape_matches(
    kind: SpeechJobKind,
    transcripts: &[RecordTranscriptSegment],
    turns: &[RecordSpeakerTurn],
    speaker_last_seen: bool,
    metrics: &WorkerMetrics,
) -> bool {
    match kind {
        SpeechJobKind::RecordBackfillAsr => {
            turns.is_empty()
                && !speaker_last_seen
                && metrics.segments as usize == transcripts.len()
                && metrics.speakers == 0
        }
        SpeechJobKind::RecordDiarization => {
            if !transcripts.is_empty()
                || !speaker_last_seen
                || metrics.segments as usize != turns.len()
            {
                return false;
            }
            let speakers = turns
                .iter()
                .map(|turn| turn.global_speaker)
                .collect::<std::collections::HashSet<_>>();
            metrics.speakers as usize == speakers.len()
                && speakers
                    .iter()
                    .max()
                    .map_or(true, |maximum| *maximum < metrics.speakers)
        }
        SpeechJobKind::AgentAttachmentAsr => false,
    }
}

fn path_for_protocol(path: &Path) -> Result<String, &'static str> {
    if !path.is_absolute() {
        return Err("SPEECH_SOURCE_UNSAFE");
    }
    path.to_str()
        .map(str::to_string)
        .ok_or("SPEECH_PATH_ENCODING_UNSUPPORTED")
}

fn send_worker_command(
    stdin: &Arc<Mutex<std::process::ChildStdin>>,
    command: &WorkerCommand,
) -> Result<(), ()> {
    stdin
        .lock()
        .map_err(|_| ())
        .and_then(|mut stdin| write_control_frame(&mut *stdin, command).map_err(|_| ()))
}

fn kill_worker(child: &Arc<Mutex<process_cmd::ChildTree>>) {
    if let Ok(mut child) = child.lock() {
        let _ = child.kill_and_wait();
    }
}

fn arm_yield_watchdog(
    child: &Arc<Mutex<process_cmd::ChildTree>>,
    settled: &Arc<std::sync::atomic::AtomicBool>,
) {
    let child = Arc::clone(child);
    let settled = Arc::clone(settled);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(YIELD_GRACE_SECONDS)).await;
        if settled.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        let _ = tauri::async_runtime::spawn_blocking(move || kill_worker(&child)).await;
    });
}

fn drain_worker_stderr(mut stderr: ChildStderr, job_id: String, generation: u64) {
    let _ = std::thread::Builder::new()
        .name("speech-worker-stderr".into())
        .spawn(move || {
            let mut buffer = [0_u8; 4 * 1024];
            let mut total = 0_u64;
            loop {
                match stderr.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => total = total.saturating_add(read as u64),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            buffer.zeroize();
            if total > 0 {
                crate::ulog_warn!(
                    "[speech] Worker stderr jobId={} generation={} bytes={} truncated={}",
                    job_id,
                    generation,
                    total.min(MAX_WORKER_STDERR_BYTES),
                    total > MAX_WORKER_STDERR_BYTES
                );
            }
        });
}

fn failed_outcome(code: &str, retryable: bool) -> SpeechWorkerOutcome {
    SpeechWorkerOutcome::Failed {
        code: code.into(),
        retryable,
    }
}

fn worker_code_retryable(code: &str) -> bool {
    matches!(
        code,
        "SPEECH_WORKER_IO_ERROR"
            | "SPEECH_WORKER_DISCONNECTED"
            | "SPEECH_WORKER_PROTOCOL_ERROR"
            | "SPEECH_WORKER_CRASHED"
            | "SPEECH_WORKER_START_FAILED"
            | "SPEECH_MODEL_LOAD_FAILED"
            | "SPEECH_INFERENCE_FAILED"
    )
}

fn finish_job_locked(
    root: &Path,
    state: &mut ManagerState,
    job_id: &str,
    generation: u64,
    terminal: SpeechJobState,
    error: Option<SpeechJobError>,
    metrics: Option<SpeechJobMetrics>,
) {
    if !exact_running_generation(state, job_id, generation) {
        return;
    }
    if let Some(job) = state.jobs.get_mut(job_id) {
        let now = Utc::now();
        job.state = terminal;
        job.stage = SpeechJobStage::Publishing;
        job.updated_at = now;
        job.finished_at = Some(now);
        job.error = error;
        job.metrics = metrics;
        job.output.artifact_available = matches!(
            terminal,
            SpeechJobState::Succeeded | SpeechJobState::SucceededWithWarnings
        );
        let _ = persist_job(root, job);
    }
}

fn enqueue_diarization_locked(
    root: &Path,
    state: &mut ManagerState,
    record_id: &str,
    source_size: u64,
    provenance: &RecordSpeechProvenance,
) -> Result<(), &'static str> {
    if state.jobs.values().any(|job| {
        job.kind == SpeechJobKind::RecordDiarization
            && !matches!(
                job.state,
                SpeechJobState::Failed | SpeechJobState::Cancelled | SpeechJobState::Interrupted
            )
            && matches!(
                &job.origin,
                SpeechJobOrigin::Record { record_id: existing } if existing == record_id
            )
    }) {
        return Ok(());
    }
    if state.queue.len() >= MAX_PENDING_JOBS {
        return Err("SPEECH_QUEUE_FULL");
    }
    let now = Utc::now();
    let job = SpeechJob {
        schema_version: JOB_SCHEMA_VERSION,
        job_id: new_job_id(),
        kind: SpeechJobKind::RecordDiarization,
        state: SpeechJobState::Queued,
        stage: SpeechJobStage::Validating,
        origin: SpeechJobOrigin::Record {
            record_id: record_id.into(),
        },
        source: SpeechJobSource {
            path: format!("record:{record_id}"),
            size_bytes: source_size,
            sha256: None,
            media_kind: Some("record/ogg-opus".into()),
        },
        output: empty_output(),
        pipeline: pipeline_from_provenance(provenance),
        created_at: now,
        updated_at: now,
        started_at: None,
        finished_at: None,
        worker_generation: None,
        worker_attempts: 0,
        error: None,
        metrics: None,
    };
    persist_job(root, &job).map_err(|_| "SPEECH_JOB_STORE_WRITE_FAILED")?;
    state.queue.push_back(job.job_id.clone());
    state.jobs.insert(job.job_id.clone(), job);
    Ok(())
}

fn update_record_queued_status(store: &ManagedRecordStore, kind: SpeechJobKind, record_id: &str) {
    let result = match kind {
        SpeechJobKind::RecordBackfillAsr => {
            tauri::async_runtime::block_on(store.update_audio_processing_status(
                record_id,
                Some(TranscriptionStatus::Queued),
                None,
            ))
        }
        SpeechJobKind::RecordDiarization => tauri::async_runtime::block_on(
            store.update_audio_processing_status(record_id, None, Some(DiarizationStatus::Queued)),
        ),
        SpeechJobKind::AgentAttachmentAsr => return,
    };
    if let Err(error) = result {
        crate::ulog_warn!(
            "[speech] failed to project queued status recordId={} error={}",
            record_id,
            error
        );
    }
}

fn update_record_terminal_status(
    store: &ManagedRecordStore,
    kind: SpeechJobKind,
    record_id: &str,
    _succeeded: bool,
) {
    let result = match kind {
        SpeechJobKind::RecordBackfillAsr => {
            tauri::async_runtime::block_on(store.update_audio_processing_status(
                record_id,
                Some(TranscriptionStatus::Failed),
                None,
            ))
        }
        SpeechJobKind::RecordDiarization => tauri::async_runtime::block_on(
            store.update_audio_processing_status(record_id, None, Some(DiarizationStatus::Failed)),
        ),
        SpeechJobKind::AgentAttachmentAsr => return,
    };
    if let Err(error) = result {
        crate::ulog_warn!(
            "[speech] failed to project terminal status recordId={} error={}",
            record_id,
            error
        );
    }
}

fn new_job_id() -> String {
    format!("speech_{}", Uuid::new_v4().simple())
}

fn empty_output() -> SpeechJobOutput {
    SpeechJobOutput {
        root_directory: None,
        job_directory: None,
        transcript_markdown_path: None,
        transcript_json_path: None,
        artifact_available: false,
    }
}

fn pipeline_from_provenance(provenance: &RecordSpeechProvenance) -> SpeechPipelineSnapshot {
    SpeechPipelineSnapshot {
        provider: provenance.provider.clone(),
        model_pack_revision: provenance.model_pack_revision.clone(),
        onnx_runtime_version: provenance.onnx_runtime_version.clone(),
    }
}

fn settle_for_process_boundary(job: &mut SpeechJob, now: DateTime<Utc>) {
    job.updated_at = now;
    job.worker_generation = None;
    job.started_at = None;
    if job.kind.is_agent() {
        job.state = SpeechJobState::Interrupted;
        job.finished_at = Some(now);
        job.error = Some(SpeechJobError {
            code: "SPEECH_INTERRUPTED".into(),
            retryable: true,
        });
    } else {
        job.state = SpeechJobState::Queued;
        job.stage = SpeechJobStage::Validating;
        job.finished_at = None;
        job.error = None;
    }
}

fn recovered_record_queue(jobs: &HashMap<String, SpeechJob>) -> VecDeque<String> {
    let mut queued = jobs
        .values()
        .filter(|job| !job.kind.is_agent() && job.state == SpeechJobState::Queued)
        .collect::<Vec<_>>();
    queued.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    queued.iter().map(|job| job.job_id.clone()).collect()
}

fn recover_nonterminal_jobs(root: &Path, jobs: &mut HashMap<String, SpeechJob>) {
    let now = Utc::now();
    for job in jobs.values_mut().filter(|job| !job.state.is_terminal()) {
        settle_for_process_boundary(job, now);
        let _ = persist_job(root, job);
    }
}

fn prune_expired_jobs(root: &Path, jobs: &mut HashMap<String, SpeechJob>) {
    let cutoff = Utc::now() - Duration::days(SPEECH_HISTORY_RETENTION_DAYS);
    let expired = jobs
        .iter()
        .filter_map(|(id, job)| {
            let terminal_at = job.finished_at.unwrap_or(job.updated_at);
            (job.state.is_terminal() && terminal_at < cutoff).then_some(id.clone())
        })
        .collect::<Vec<_>>();
    for id in expired {
        jobs.remove(&id);
        let _ = fs::remove_dir_all(root.join("jobs").join(&id));
        let _ = fs::remove_dir_all(root.join("private").join(id));
    }
}

fn load_jobs(root: &Path) -> Result<HashMap<String, SpeechJob>, String> {
    let mut jobs = HashMap::new();
    let entries =
        fs::read_dir(root.join("jobs")).map_err(|error| format!("read speech jobs: {error}"))?;
    for entry in entries.take(10_000).flatten() {
        let directory = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&directory) else {
            continue;
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        let path = directory.join("job.json");
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len() == 0
            || metadata.len() > MAX_JOB_METADATA_BYTES
        {
            continue;
        }
        let Ok(bytes) = fs::read(&path) else {
            continue;
        };
        let Ok(job) = serde_json::from_slice::<SpeechJob>(&bytes) else {
            continue;
        };
        if job.schema_version == JOB_SCHEMA_VERSION
            && entry.file_name().to_string_lossy() == job.job_id
            && validate_job_id(&job.job_id).is_ok()
            && valid_job_shape(&job)
        {
            jobs.insert(job.job_id.clone(), job);
        }
    }
    Ok(jobs)
}

fn valid_job_shape(job: &SpeechJob) -> bool {
    match (&job.kind, &job.origin) {
        (
            SpeechJobKind::AgentAttachmentAsr,
            SpeechJobOrigin::Agent {
                initiator_session_id,
                workspace_identity,
            },
        ) => {
            validate_session_id(initiator_session_id).is_ok()
                && Path::new(workspace_identity).is_absolute()
        }
        (
            SpeechJobKind::RecordBackfillAsr | SpeechJobKind::RecordDiarization,
            SpeechJobOrigin::Record { record_id },
        ) => validate_job_id(record_id).is_ok(),
        _ => false,
    }
}

fn persist_job(root: &Path, job: &SpeechJob) -> Result<(), String> {
    let content = serde_json::to_string_pretty(job)
        .map_err(|error| format!("serialize speech job: {error}"))?;
    crate::task::write_atomic_text(
        &root.join("jobs").join(&job.job_id).join("job.json"),
        &content,
    )
}

fn validate_job_id(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("SPEECH_JOB_ID_INVALID");
    }
    Ok(())
}

fn validate_session_id(value: &str) -> Result<(), &'static str> {
    if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err("SPEECH_SESSION_REQUIRED");
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| format!("create speech store: {error}"))?;
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("inspect speech store: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("speech store path must be a plain directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("protect speech store: {error}"))?;
    }
    Ok(())
}

fn plain_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

fn verify_model_pack(manifest_path: &Path) -> Option<String> {
    crate::speech_model_pack::verify_installed_pack(manifest_path)
        .ok()
        .map(|pack| pack.pack_revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_inference::LocalInferenceRuntimeRegistry;
    use crate::record::{
        AudioRecordCreateInput, AudioTrackArtifactInput, CaptureStatus, RecordStore,
    };
    use myagents_media_worker_protocol::{write_control_frame, WorkerMetrics, WorkerResponse};

    fn fixture_job(
        job_id: &str,
        kind: SpeechJobKind,
        origin: SpeechJobOrigin,
        state: SpeechJobState,
        created_at: DateTime<Utc>,
    ) -> SpeechJob {
        SpeechJob {
            schema_version: JOB_SCHEMA_VERSION,
            job_id: job_id.into(),
            kind,
            state,
            stage: SpeechJobStage::Transcribing,
            origin,
            source: SpeechJobSource {
                path: "/private/source".into(),
                size_bytes: 42,
                sha256: None,
                media_kind: None,
            },
            output: SpeechJobOutput {
                root_directory: None,
                job_directory: None,
                transcript_markdown_path: None,
                transcript_json_path: None,
                artifact_available: false,
            },
            pipeline: SpeechPipelineSnapshot {
                provider: "local".into(),
                model_pack_revision: "revision-1".into(),
                onnx_runtime_version: "1.28.0".into(),
            },
            created_at,
            updated_at: created_at,
            started_at: Some(created_at),
            finished_at: None,
            worker_generation: Some(9),
            worker_attempts: 1,
            error: None,
            metrics: None,
        }
    }

    fn manager(root: &tempfile::TempDir) -> ManagedSpeechRecognition {
        let data = root.path().join("data");
        let resources = root.path().join("resources");
        fs::create_dir_all(&resources).unwrap();
        let runtime = LocalInferenceRuntimeRegistry::initialize(&resources);
        let records = Arc::new(RecordStore::new(data.join("records"), None));
        SpeechRecognitionManager::initialize_inner(
            data,
            resources,
            runtime.as_ref(),
            LocalComputeCoordinator::new(),
            records,
            false,
        )
        .unwrap()
    }

    #[cfg(unix)]
    fn write_fake_worker(path: &Path, responses: &[WorkerResponse]) {
        use std::os::unix::fs::PermissionsExt;

        let mut wire = Vec::new();
        for response in responses {
            write_control_frame(&mut wire, response).unwrap();
        }
        let octal = wire
            .iter()
            .map(|byte| format!("\\{:03o}", byte))
            .collect::<String>();
        let script = format!("#!/bin/sh\n/bin/sleep 0.05\n/usr/bin/printf '{octal}'\nexit 0\n");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, script).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn restart_interrupts_agent_jobs_but_requeues_record_work_in_fifo_order() {
        let root = tempfile::tempdir().unwrap();
        let initial = manager(&root);
        let now = Utc::now();
        let agent = fixture_job(
            "speech_agent",
            SpeechJobKind::AgentAttachmentAsr,
            SpeechJobOrigin::Agent {
                initiator_session_id: "session-a".into(),
                workspace_identity: root.path().display().to_string(),
            },
            SpeechJobState::Running,
            now,
        );
        let record_late = fixture_job(
            "speech_record_late",
            SpeechJobKind::RecordDiarization,
            SpeechJobOrigin::Record {
                record_id: "record-late".into(),
            },
            SpeechJobState::Running,
            now + Duration::seconds(1),
        );
        let record_early = fixture_job(
            "speech_record_early",
            SpeechJobKind::RecordBackfillAsr,
            SpeechJobOrigin::Record {
                record_id: "record-early".into(),
            },
            SpeechJobState::Running,
            now,
        );
        for job in [&agent, &record_late, &record_early] {
            persist_job(&initial.root, job).unwrap();
        }
        drop(initial);

        let recovered = manager(&root);
        let agent = recovered
            .get_agent_job("session-a", "speech_agent")
            .unwrap();
        assert_eq!(agent.state, SpeechJobState::Interrupted);
        assert_eq!(
            agent.error.as_ref().map(|error| error.code.as_str()),
            Some("SPEECH_INTERRUPTED")
        );
        assert_eq!(
            recovered.queue_snapshot().unwrap(),
            vec!["speech_record_early", "speech_record_late"]
        );
        let jobs = recovered.state.lock().unwrap();
        for id in ["speech_record_early", "speech_record_late"] {
            let job = jobs.jobs.get(id).unwrap();
            assert_eq!(job.state, SpeechJobState::Queued);
            assert_eq!(job.worker_generation, None);
            assert_eq!(job.stage, SpeechJobStage::Validating);
        }
    }

    #[test]
    fn agent_visibility_is_exact_session_scoped() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let now = Utc::now();
        for (id, session) in [("speech_a", "session-a"), ("speech_b", "session-b")] {
            let job = fixture_job(
                id,
                SpeechJobKind::AgentAttachmentAsr,
                SpeechJobOrigin::Agent {
                    initiator_session_id: session.into(),
                    workspace_identity: root.path().display().to_string(),
                },
                SpeechJobState::Succeeded,
                now,
            );
            manager.state.lock().unwrap().jobs.insert(id.into(), job);
        }
        assert_eq!(manager.list_agent_jobs("session-a", 20).unwrap().len(), 1);
        assert_eq!(
            manager.get_agent_job("session-a", "speech_b"),
            Err("SPEECH_JOB_NOT_FOUND")
        );
        assert_eq!(
            manager.get_agent_job("session-b", "speech_a"),
            Err("SPEECH_JOB_NOT_FOUND")
        );
        let debug = format!(
            "{:?}",
            manager.get_agent_job("session-a", "speech_a").unwrap()
        );
        assert!(!debug.contains("/private/source"));
        assert!(!debug.contains(root.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn shutdown_interrupts_agents_and_keeps_record_jobs_restartable() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let now = Utc::now();
        let jobs = [
            fixture_job(
                "speech_agent",
                SpeechJobKind::AgentAttachmentAsr,
                SpeechJobOrigin::Agent {
                    initiator_session_id: "session-a".into(),
                    workspace_identity: root.path().display().to_string(),
                },
                SpeechJobState::Running,
                now,
            ),
            fixture_job(
                "speech_record",
                SpeechJobKind::RecordBackfillAsr,
                SpeechJobOrigin::Record {
                    record_id: "record-a".into(),
                },
                SpeechJobState::Running,
                now,
            ),
        ];
        {
            let mut state = manager.state.lock().unwrap();
            for job in jobs {
                state.jobs.insert(job.job_id.clone(), job);
            }
        }
        manager.shutdown().unwrap();
        let state = manager.state.lock().unwrap();
        assert_eq!(
            state.jobs.get("speech_agent").unwrap().state,
            SpeechJobState::Interrupted
        );
        assert_eq!(
            state.jobs.get("speech_record").unwrap().state,
            SpeechJobState::Queued
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exact_generation_worker_result_commits_record_and_queues_diarization() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let record = manager
            .record_store
            .create_audio(AudioRecordCreateInput {
                title: "Meeting".into(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Queued,
            })
            .await
            .unwrap();
        let record_path = manager
            .record_store
            .audio_workspace_path(&record.id)
            .await
            .unwrap();
        fs::write(record_path.join("audio/microphone.opus"), b"owned-audio").unwrap();
        let finalized = manager
            .record_store
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

        let mut job = fixture_job(
            "speech_record_execute",
            SpeechJobKind::RecordBackfillAsr,
            SpeechJobOrigin::Record {
                record_id: record.id.clone(),
            },
            SpeechJobState::Queued,
            Utc::now(),
        );
        job.started_at = None;
        job.worker_generation = None;
        job.worker_attempts = 0;
        job.source.size_bytes = finalized.audio.unwrap().size_bytes;
        {
            let mut state = manager.state.lock().unwrap();
            state.queue.push_back(job.job_id.clone());
            state.jobs.insert(job.job_id.clone(), job);
        }
        let (job, generation) = manager.take_next_job().unwrap().unwrap();
        let identity = WorkloadIdentity {
            workload_id: job.job_id.clone(),
            worker_generation: generation,
        };
        let worker = root.path().join("fake-media-worker");
        write_fake_worker(
            &worker,
            &[
                WorkerResponse::Ready {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                },
                WorkerResponse::TranscriptSegment {
                    protocol_version: PROTOCOL_VERSION,
                    identity: identity.clone(),
                    segment_id: "segment-1".into(),
                    track: TrackKind::Microphone,
                    start_sample: 0,
                    end_sample: 8_000,
                    text: "private transcript".into(),
                    language: Some("en".into()),
                    revision: 1,
                },
                WorkerResponse::Completed {
                    protocol_version: PROTOCOL_VERSION,
                    identity,
                    metrics: WorkerMetrics {
                        source_samples: 16_000,
                        segments: 1,
                        speakers: 0,
                        elapsed_ms: 5,
                        peak_working_bytes: Some(1024),
                    },
                },
            ],
        );
        let native_manifest = root.path().join("native-manifest.json");
        let runtime = root.path().join("libonnxruntime.dylib");
        let model_manifest = root.path().join("model-manifest.json");
        for path in [&native_manifest, &runtime, &model_manifest] {
            fs::write(path, b"fixture").unwrap();
        }
        let resources = SpeechExecutionResources {
            worker_path: worker,
            native_manifest_path: native_manifest,
            onnx_runtime_path: runtime,
            model_pack_manifest_path: model_manifest,
            provenance: RecordSpeechProvenance {
                provider: "local".into(),
                model_pack_revision: "fixture-pack".into(),
                onnx_runtime_version: "1.28.0".into(),
            },
        };
        let lease = manager
            .compute_coordinator
            .acquire(ComputeWorkloadIdentity {
                kind: ComputeWorkloadKind::RecordBackfill,
                id: job.job_id.clone(),
                generation,
            })
            .await;
        let runner = Arc::clone(&manager);
        tauri::async_runtime::spawn_blocking(move || {
            runner.execute_record_job(&job, generation, resources, lease)
        })
        .await
        .unwrap();
        manager.clear_active("speech_record_execute", generation);

        let snapshot = manager
            .record_store
            .read_recording_final_transcript(&record.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.segments.len(), 1);
        assert_eq!(snapshot.segments[0].text, "private transcript");
        let state = manager.state.lock().unwrap();
        assert_eq!(
            state.jobs.get("speech_record_execute").unwrap().state,
            SpeechJobState::Succeeded
        );
        assert!(state.jobs.values().any(|job| {
            job.kind == SpeechJobKind::RecordDiarization
                && job.state == SpeechJobState::Queued
                && matches!(
                    &job.origin,
                    SpeechJobOrigin::Record { record_id } if record_id == &record.id
                )
        }));
    }

    #[tokio::test]
    async fn stale_generation_cannot_publish_record_projection() {
        let root = tempfile::tempdir().unwrap();
        let manager = manager(&root);
        let record = manager
            .record_store
            .create_audio(AudioRecordCreateInput {
                title: "Meeting".into(),
                tracks: vec![AudioTrackKind::Microphone],
                transcription_status: TranscriptionStatus::Queued,
            })
            .await
            .unwrap();
        let record_path = manager
            .record_store
            .audio_workspace_path(&record.id)
            .await
            .unwrap();
        fs::write(record_path.join("audio/microphone.opus"), b"owned-audio").unwrap();
        manager
            .record_store
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
        let mut job = fixture_job(
            "speech_stale",
            SpeechJobKind::RecordBackfillAsr,
            SpeechJobOrigin::Record {
                record_id: record.id.clone(),
            },
            SpeechJobState::Running,
            Utc::now(),
        );
        job.worker_generation = Some(2);
        {
            let mut state = manager.state.lock().unwrap();
            state.active_job = Some((job.job_id.clone(), 2));
            state.jobs.insert(job.job_id.clone(), job.clone());
        }
        manager.publish_record_success(
            &job,
            1,
            &RecordSpeechProvenance {
                provider: "local".into(),
                model_pack_revision: "fixture-pack".into(),
                onnx_runtime_version: "1.28.0".into(),
            },
            SensitiveTranscriptSegments(vec![RecordTranscriptSegment {
                segment_id: "segment-1".into(),
                track: AudioTrackKind::Microphone,
                start_sample: 0,
                end_sample: 8_000,
                text: "must not publish".into(),
                language: Some("en".into()),
                revision: 1,
            }]),
            Vec::new(),
            WorkerMetrics {
                source_samples: 16_000,
                segments: 1,
                speakers: 0,
                elapsed_ms: 5,
                peak_working_bytes: None,
            },
        );
        assert!(manager
            .record_store
            .read_recording_final_transcript(&record.id)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            manager.state.lock().unwrap().jobs["speech_stale"].state,
            SpeechJobState::Running
        );
    }
}
