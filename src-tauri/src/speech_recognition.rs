//! App-owned speech workload metadata, recovery, and scheduling authority.
//!
//! The media Worker owns one exact generation's decode/inference state. This
//! module owns durable job identity and decides whether a Worker result may
//! become an Agent artifact or a Record projection.

use crate::local_inference::{
    InferenceRuntimeKind, LocalComputeCoordinator, LocalInferenceRuntimeIdentity,
    LocalInferenceRuntimeRegistry,
};
use crate::record::ManagedRecordStore;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

const JOB_SCHEMA_VERSION: u32 = 1;
const MAX_JOB_METADATA_BYTES: u64 = 1024 * 1024;
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechJobSource {
    pub path: String,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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
    next_generation: u64,
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
}

impl SpeechRecognitionManager {
    pub fn initialize(
        data_root: PathBuf,
        resource_root: PathBuf,
        runtime_registry: &LocalInferenceRuntimeRegistry,
        compute_coordinator: Arc<LocalComputeCoordinator>,
        record_store: ManagedRecordStore,
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

        Ok(Arc::new(Self {
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
                next_generation: 1,
            }),
        }))
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
        let snapshots = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "speech manager lock poisoned".to_string())?;
            state.accepting = false;
            state.active_job = None;
            state.queue.clear();
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
            snapshots
        };
        for job in snapshots {
            persist_job(&self.root, &job)?;
        }
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
    use crate::record::RecordStore;

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
        SpeechRecognitionManager::initialize(
            data,
            resources,
            runtime.as_ref(),
            LocalComputeCoordinator::new(),
            records,
        )
        .unwrap()
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
}
