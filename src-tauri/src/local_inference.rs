//! App-owned local inference runtime inventory and capability-neutral compute admission.
//!
//! This module owns only two cross-domain facts:
//! - which verified native inference runtime file this installed App may load;
//! - which exact workload currently holds the single heavy local inference lease.
//!
//! Document and speech managers keep their own queues, generations, artifacts,
//! and terminal states. This is deliberately not a generic tensor service.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock, Weak,
};
use tokio::sync::Notify;

const MAX_RUNTIME_MANIFEST_BYTES: u64 = 1024 * 1024;
const DOCUMENT_RUNTIME_MANIFEST: &str = "document-processing/v1/manifest.json";

pub type ManagedLocalInferenceRuntimeRegistry = Arc<LocalInferenceRuntimeRegistry>;
pub type ManagedLocalComputeCoordinator = Arc<LocalComputeCoordinator>;

static RUNTIME_REGISTRY: OnceLock<ManagedLocalInferenceRuntimeRegistry> = OnceLock::new();
static COMPUTE_COORDINATOR: OnceLock<ManagedLocalComputeCoordinator> = OnceLock::new();

pub fn set_global_runtime_registry(
    registry: ManagedLocalInferenceRuntimeRegistry,
) -> Result<(), String> {
    RUNTIME_REGISTRY
        .set(registry)
        .map_err(|_| "LocalInferenceRuntimeRegistry already initialized".to_string())
}

pub fn global_runtime_registry() -> Option<&'static ManagedLocalInferenceRuntimeRegistry> {
    RUNTIME_REGISTRY.get()
}

pub fn set_global_compute_coordinator(
    coordinator: ManagedLocalComputeCoordinator,
) -> Result<(), String> {
    COMPUTE_COORDINATOR
        .set(coordinator)
        .map_err(|_| "LocalComputeCoordinator already initialized".to_string())
}

pub fn global_compute_coordinator() -> Option<&'static ManagedLocalComputeCoordinator> {
    COMPUTE_COORDINATOR.get()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InferenceRuntimeKind {
    OnnxCpu,
}

impl InferenceRuntimeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OnnxCpu => "onnx-cpu",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalInferenceRuntimeIdentity {
    kind: InferenceRuntimeKind,
    version: String,
    upstream_revision: String,
    path: PathBuf,
    sha256: String,
    size: u64,
    platform: String,
    architecture: String,
}

impl LocalInferenceRuntimeIdentity {
    pub fn kind(&self) -> InferenceRuntimeKind {
        self.kind
    }

    pub fn version(&self) -> &str {
        &self.version
    }

    pub fn upstream_revision(&self) -> &str {
        &self.upstream_revision
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    pub fn size(&self) -> u64 {
        self.size
    }

    pub fn target(&self) -> (&str, &str) {
        (&self.platform, &self.architecture)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalInferenceRuntimeError {
    code: &'static str,
}

impl LocalInferenceRuntimeError {
    fn new(code: &'static str) -> Self {
        Self { code }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }
}

pub struct LocalInferenceRuntimeRegistry {
    source_manifest: PathBuf,
    runtimes: HashMap<InferenceRuntimeKind, LocalInferenceRuntimeIdentity>,
    discovery_error: Option<LocalInferenceRuntimeError>,
}

impl LocalInferenceRuntimeRegistry {
    /// Discover the one App-owned ONNX runtime already prepared by the
    /// document-processing supply chain. Failure is retained as capability
    /// state so the App and unrelated features still start normally.
    pub fn initialize(resource_root: &Path) -> ManagedLocalInferenceRuntimeRegistry {
        let source_manifest = resource_root.join(DOCUMENT_RUNTIME_MANIFEST);
        let discovered = discover_onnx_runtime(&source_manifest);
        let (runtimes, discovery_error) = match discovered {
            Ok(identity) => (
                HashMap::from([(InferenceRuntimeKind::OnnxCpu, identity)]),
                None,
            ),
            Err(error) => (HashMap::new(), Some(error)),
        };
        Arc::new(Self {
            source_manifest,
            runtimes,
            discovery_error,
        })
    }

    pub fn identity(
        &self,
        kind: InferenceRuntimeKind,
    ) -> Result<LocalInferenceRuntimeIdentity, LocalInferenceRuntimeError> {
        self.runtimes.get(&kind).cloned().ok_or_else(|| {
            self.discovery_error
                .clone()
                .unwrap_or_else(|| LocalInferenceRuntimeError::new("LOCAL_RUNTIME_UNAVAILABLE"))
        })
    }

    pub fn source_manifest(&self) -> &Path {
        &self.source_manifest
    }

    /// Assert that a capability manifest points at the exact runtime identity
    /// already admitted by this registry. The caller may validate its own
    /// models and Worker, but must not hash or select another ONNX runtime.
    pub fn verify_manifest_reference(
        &self,
        kind: InferenceRuntimeKind,
        manifest_root: &Path,
        relative_path: &str,
        sha256: &str,
        size: u64,
        upstream_revision: &str,
    ) -> Result<LocalInferenceRuntimeIdentity, LocalInferenceRuntimeError> {
        let identity = self.identity(kind)?;
        let referenced_path = resolve_relative_resource(manifest_root, relative_path)?;
        if identity.path != referenced_path
            || identity.sha256 != sha256.to_ascii_lowercase()
            || identity.size != size
            || identity.upstream_revision != upstream_revision
        {
            return Err(LocalInferenceRuntimeError::new(
                "LOCAL_RUNTIME_IDENTITY_MISMATCH",
            ));
        }
        Ok(identity)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeBundleManifest {
    schema_version: u32,
    platform: String,
    architecture: String,
    files: RuntimeBundleFiles,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeBundleFiles {
    onnx_runtime: RuntimeResourceFile,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeResourceFile {
    path: String,
    sha256: String,
    size: u64,
    license: String,
    upstream_revision: String,
    artifact_source: String,
    signing: RuntimeResourceSigning,
}

#[derive(Deserialize)]
struct RuntimeResourceSigning {
    kind: String,
    identity: String,
}

fn discover_onnx_runtime(
    manifest_path: &Path,
) -> Result<LocalInferenceRuntimeIdentity, LocalInferenceRuntimeError> {
    let manifest_metadata = fs::symlink_metadata(manifest_path)
        .map_err(|_| LocalInferenceRuntimeError::new("LOCAL_RUNTIME_MANIFEST_MISSING"))?;
    if !manifest_metadata.is_file()
        || manifest_metadata.file_type().is_symlink()
        || manifest_metadata.len() == 0
        || manifest_metadata.len() > MAX_RUNTIME_MANIFEST_BYTES
    {
        return Err(LocalInferenceRuntimeError::new(
            "LOCAL_RUNTIME_MANIFEST_INVALID",
        ));
    }
    let bytes = fs::read(manifest_path)
        .map_err(|_| LocalInferenceRuntimeError::new("LOCAL_RUNTIME_MANIFEST_INVALID"))?;
    let manifest: RuntimeBundleManifest = serde_json::from_slice(&bytes)
        .map_err(|_| LocalInferenceRuntimeError::new("LOCAL_RUNTIME_MANIFEST_INVALID"))?;
    let (expected_platform, expected_architecture) = current_target()?;
    if manifest.schema_version != 1
        || manifest.platform != expected_platform
        || manifest.architecture != expected_architecture
    {
        return Err(LocalInferenceRuntimeError::new(
            "LOCAL_RUNTIME_TARGET_MISMATCH",
        ));
    }

    let runtime = manifest.files.onnx_runtime;
    if runtime.sha256.len() != 64
        || !runtime.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || runtime.size == 0
        || runtime.license.trim().is_empty()
        || runtime.upstream_revision.trim().is_empty()
        || runtime.artifact_source.trim().is_empty()
        || runtime.signing.kind.trim().is_empty()
        || runtime.signing.identity.trim().is_empty()
    {
        return Err(LocalInferenceRuntimeError::new(
            "LOCAL_RUNTIME_MANIFEST_INVALID",
        ));
    }
    let root = manifest_path
        .parent()
        .ok_or_else(|| LocalInferenceRuntimeError::new("LOCAL_RUNTIME_MANIFEST_INVALID"))?;
    let path = resolve_relative_resource(root, &runtime.path)?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| LocalInferenceRuntimeError::new("LOCAL_RUNTIME_MISSING"))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() != runtime.size
        || sha256_file(&path)
            .map_err(|_| LocalInferenceRuntimeError::new("LOCAL_RUNTIME_INVALID"))?
            != runtime.sha256.to_ascii_lowercase()
    {
        return Err(LocalInferenceRuntimeError::new("LOCAL_RUNTIME_INVALID"));
    }
    let version = runtime
        .upstream_revision
        .split('@')
        .next()
        .and_then(|value| value.strip_prefix('v'))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| LocalInferenceRuntimeError::new("LOCAL_RUNTIME_MANIFEST_INVALID"))?
        .to_string();

    Ok(LocalInferenceRuntimeIdentity {
        kind: InferenceRuntimeKind::OnnxCpu,
        version,
        upstream_revision: runtime.upstream_revision,
        path,
        sha256: runtime.sha256.to_ascii_lowercase(),
        size: runtime.size,
        platform: manifest.platform,
        architecture: manifest.architecture,
    })
}

fn current_target() -> Result<(&'static str, &'static str), LocalInferenceRuntimeError> {
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return Err(LocalInferenceRuntimeError::new(
            "LOCAL_RUNTIME_UNSUPPORTED_PLATFORM",
        ));
    };
    let architecture = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        return Err(LocalInferenceRuntimeError::new(
            "LOCAL_RUNTIME_UNSUPPORTED_PLATFORM",
        ));
    };
    Ok((platform, architecture))
}

fn resolve_relative_resource(
    root: &Path,
    relative: &str,
) -> Result<PathBuf, LocalInferenceRuntimeError> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(LocalInferenceRuntimeError::new(
            "LOCAL_RUNTIME_MANIFEST_INVALID",
        ));
    }
    Ok(root.join(relative))
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputeWorkloadKind {
    DocumentOcr,
    AgentAttachmentAsr,
    RecordDiarization,
    RecordBackfill,
    RecordLive,
}

impl ComputeWorkloadKind {
    fn priority(self) -> u8 {
        match self {
            Self::DocumentOcr | Self::AgentAttachmentAsr => 1,
            Self::RecordDiarization => 2,
            Self::RecordBackfill => 3,
            Self::RecordLive => 4,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::DocumentOcr => "document-ocr",
            Self::AgentAttachmentAsr => "agent-attachment-asr",
            Self::RecordDiarization => "record-diarization",
            Self::RecordBackfill => "record-backfill",
            Self::RecordLive => "record-live",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputeWorkloadIdentity {
    pub kind: ComputeWorkloadKind,
    pub id: String,
    pub generation: u64,
}

struct WaitingWorkload {
    identity: ComputeWorkloadIdentity,
}

struct ActiveWorkload {
    lease_id: u64,
    identity: ComputeWorkloadIdentity,
    yield_requested: Arc<AtomicBool>,
}

#[derive(Default)]
struct CoordinatorState {
    next_ticket: u64,
    active: Option<ActiveWorkload>,
    waiters: BTreeMap<u64, WaitingWorkload>,
}

pub struct LocalComputeCoordinator {
    state: Mutex<CoordinatorState>,
    changed: Notify,
}

impl LocalComputeCoordinator {
    pub fn new() -> ManagedLocalComputeCoordinator {
        Arc::new(Self {
            state: Mutex::new(CoordinatorState {
                next_ticket: 1,
                ..CoordinatorState::default()
            }),
            changed: Notify::new(),
        })
    }

    pub async fn acquire(self: &Arc<Self>, identity: ComputeWorkloadIdentity) -> LocalComputeLease {
        let ticket = {
            let mut state = self
                .state
                .lock()
                .expect("compute coordinator lock poisoned");
            let ticket = state.next_ticket;
            state.next_ticket = state.next_ticket.saturating_add(1).max(1);
            state.waiters.insert(ticket, WaitingWorkload { identity });
            refresh_yield_request(&mut state);
            ticket
        };
        self.changed.notify_waiters();
        let mut pending = PendingComputeWaiter {
            coordinator: Arc::downgrade(self),
            ticket,
            claimed: false,
        };
        loop {
            let notified = self.changed.notified();
            if let Some(lease) = self.try_claim(ticket) {
                pending.claimed = true;
                return lease;
            }
            notified.await;
        }
    }

    fn try_claim(self: &Arc<Self>, ticket: u64) -> Option<LocalComputeLease> {
        let mut state = self.state.lock().ok()?;
        if state.active.is_some() || !state.waiters.contains_key(&ticket) {
            return None;
        }
        let selected = state
            .waiters
            .iter()
            .max_by(|(left_ticket, left), (right_ticket, right)| {
                left.identity
                    .kind
                    .priority()
                    .cmp(&right.identity.kind.priority())
                    .then_with(|| right_ticket.cmp(left_ticket))
            })
            .map(|(ticket, _)| *ticket)?;
        if selected != ticket {
            return None;
        }
        let waiter = state.waiters.remove(&ticket)?;
        let yield_requested = Arc::new(AtomicBool::new(false));
        state.active = Some(ActiveWorkload {
            lease_id: ticket,
            identity: waiter.identity.clone(),
            yield_requested: Arc::clone(&yield_requested),
        });
        Some(LocalComputeLease {
            coordinator: Arc::downgrade(self),
            lease_id: ticket,
            identity: waiter.identity,
            yield_requested,
        })
    }

    pub fn active_identity(&self) -> Option<ComputeWorkloadIdentity> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.active.as_ref().map(|active| active.identity.clone()))
    }
}

fn refresh_yield_request(state: &mut CoordinatorState) {
    let Some(active) = state.active.as_ref() else {
        return;
    };
    let active_priority = active.identity.kind.priority();
    let should_yield = state
        .waiters
        .values()
        .any(|waiter| waiter.identity.kind.priority() > active_priority);
    active
        .yield_requested
        .store(should_yield, Ordering::Release);
}

struct PendingComputeWaiter {
    coordinator: Weak<LocalComputeCoordinator>,
    ticket: u64,
    claimed: bool,
}

impl Drop for PendingComputeWaiter {
    fn drop(&mut self) {
        if self.claimed {
            return;
        }
        let Some(coordinator) = self.coordinator.upgrade() else {
            return;
        };
        if let Ok(mut state) = coordinator.state.lock() {
            state.waiters.remove(&self.ticket);
            refresh_yield_request(&mut state);
        }
        coordinator.changed.notify_waiters();
    }
}

pub struct LocalComputeLease {
    coordinator: Weak<LocalComputeCoordinator>,
    lease_id: u64,
    identity: ComputeWorkloadIdentity,
    yield_requested: Arc<AtomicBool>,
}

impl LocalComputeLease {
    pub fn identity(&self) -> &ComputeWorkloadIdentity {
        &self.identity
    }

    pub fn should_yield(&self) -> bool {
        self.yield_requested.load(Ordering::Acquire)
    }
}

impl Drop for LocalComputeLease {
    fn drop(&mut self) {
        let Some(coordinator) = self.coordinator.upgrade() else {
            return;
        };
        let released = if let Ok(mut state) = coordinator.state.lock() {
            if state
                .active
                .as_ref()
                .is_some_and(|active| active.lease_id == self.lease_id)
            {
                state.active = None;
                true
            } else {
                false
            }
        } else {
            false
        };
        if released {
            coordinator.changed.notify_waiters();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn target_names() -> (&'static str, &'static str) {
        current_target().unwrap()
    }

    fn write_runtime_bundle(root: &Path, bytes: &[u8]) -> PathBuf {
        let bundle = root.join("document-processing").join("v1");
        let native = bundle.join("native");
        fs::create_dir_all(&native).unwrap();
        let runtime = native.join(if cfg!(target_os = "windows") {
            "onnxruntime.dll"
        } else if cfg!(target_os = "macos") {
            "onnxruntime.dylib"
        } else {
            "libonnxruntime.so"
        });
        fs::write(&runtime, bytes).unwrap();
        let sha256 = format!("{:x}", Sha256::digest(bytes));
        let (platform, architecture) = target_names();
        let manifest = serde_json::json!({
            "schemaVersion": 1,
            "pipelineVersion": "test",
            "platform": platform,
            "architecture": architecture,
            "files": {
                "onnxRuntime": {
                    "path": runtime.strip_prefix(&bundle).unwrap(),
                    "sha256": sha256,
                    "size": bytes.len(),
                    "license": "MIT",
                    "upstreamRevision": "v1.28.0@test-revision",
                    "artifactSource": "test fixture",
                    "signing": { "kind": "sha256-manifest", "identity": "test" }
                }
            }
        });
        fs::write(
            bundle.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        runtime
    }

    #[test]
    fn registry_freezes_verified_onnx_identity() {
        let root = tempfile::tempdir().unwrap();
        let runtime = write_runtime_bundle(root.path(), b"verified-runtime");
        let registry = LocalInferenceRuntimeRegistry::initialize(root.path());
        let identity = registry.identity(InferenceRuntimeKind::OnnxCpu).unwrap();
        assert_eq!(identity.kind(), InferenceRuntimeKind::OnnxCpu);
        assert_eq!(identity.version(), "1.28.0");
        assert_eq!(identity.path(), runtime);
        assert_eq!(identity.target(), target_names());
        assert_eq!(identity.size(), 16);

        let manifest_root = registry.source_manifest().parent().unwrap();
        let relative = identity.path().strip_prefix(manifest_root).unwrap();
        let matched = registry
            .verify_manifest_reference(
                InferenceRuntimeKind::OnnxCpu,
                manifest_root,
                relative.to_str().unwrap(),
                identity.sha256(),
                identity.size(),
                identity.upstream_revision(),
            )
            .unwrap();
        assert_eq!(matched, identity);
        assert_eq!(
            registry
                .verify_manifest_reference(
                    InferenceRuntimeKind::OnnxCpu,
                    manifest_root,
                    relative.to_str().unwrap(),
                    &"0".repeat(64),
                    identity.size(),
                    identity.upstream_revision(),
                )
                .unwrap_err()
                .code(),
            "LOCAL_RUNTIME_IDENTITY_MISMATCH"
        );
    }

    #[test]
    fn registry_rejects_runtime_mutation_and_manifest_aliases() {
        let root = tempfile::tempdir().unwrap();
        let runtime = write_runtime_bundle(root.path(), b"verified-runtime");
        fs::write(&runtime, b"mutated-runtime!").unwrap();
        let registry = LocalInferenceRuntimeRegistry::initialize(root.path());
        assert_eq!(
            registry
                .identity(InferenceRuntimeKind::OnnxCpu)
                .unwrap_err()
                .code(),
            "LOCAL_RUNTIME_INVALID"
        );

        let alias_root = tempfile::tempdir().unwrap();
        write_runtime_bundle(alias_root.path(), b"verified-runtime");
        let manifest = alias_root
            .path()
            .join("document-processing/v1/manifest.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        value["files"]["onnxRuntime"]["path"] = "../native/onnxruntime".into();
        fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        let registry = LocalInferenceRuntimeRegistry::initialize(alias_root.path());
        assert_eq!(
            registry
                .identity(InferenceRuntimeKind::OnnxCpu)
                .unwrap_err()
                .code(),
            "LOCAL_RUNTIME_MANIFEST_INVALID"
        );
    }

    fn workload(kind: ComputeWorkloadKind, id: &str) -> ComputeWorkloadIdentity {
        ComputeWorkloadIdentity {
            kind,
            id: id.into(),
            generation: 1,
        }
    }

    #[tokio::test]
    async fn higher_priority_waiter_requests_yield_and_runs_first() {
        let coordinator = LocalComputeCoordinator::new();
        let document = coordinator
            .acquire(workload(ComputeWorkloadKind::DocumentOcr, "document"))
            .await;
        let mut attachment = Box::pin(coordinator.acquire(workload(
            ComputeWorkloadKind::AgentAttachmentAsr,
            "attachment",
        )));
        let mut live =
            Box::pin(coordinator.acquire(workload(ComputeWorkloadKind::RecordLive, "record")));
        assert!(
            tokio::time::timeout(Duration::from_millis(5), attachment.as_mut())
                .await
                .is_err()
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(5), live.as_mut())
                .await
                .is_err()
        );
        assert!(document.should_yield());
        drop(document);

        let live = tokio::time::timeout(Duration::from_secs(1), live.as_mut())
            .await
            .expect("live workload receives the released lease");
        assert_eq!(live.identity().kind, ComputeWorkloadKind::RecordLive);
        drop(live);
        let attachment = tokio::time::timeout(Duration::from_secs(1), attachment.as_mut())
            .await
            .expect("attachment follows after the live workload");
        assert_eq!(
            attachment.identity().kind,
            ComputeWorkloadKind::AgentAttachmentAsr
        );
    }

    #[tokio::test]
    async fn cancelled_waiter_is_removed_and_clears_spurious_yield() {
        let coordinator = LocalComputeCoordinator::new();
        let document = coordinator
            .acquire(workload(ComputeWorkloadKind::DocumentOcr, "document"))
            .await;
        let mut live =
            Box::pin(coordinator.acquire(workload(ComputeWorkloadKind::RecordLive, "record")));
        assert!(
            tokio::time::timeout(Duration::from_millis(5), live.as_mut())
                .await
                .is_err()
        );
        assert!(document.should_yield());
        drop(live);
        assert!(!document.should_yield());
        drop(document);

        let next = tokio::time::timeout(
            Duration::from_secs(1),
            coordinator.acquire(workload(ComputeWorkloadKind::DocumentOcr, "next")),
        )
        .await
        .expect("a dropped waiter cannot block the queue");
        assert_eq!(next.identity().id, "next");
    }
}
