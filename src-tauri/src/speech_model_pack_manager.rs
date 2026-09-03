//! Explicit install, verification, activation, and removal of speech weights.
//!
//! Downloadable packs contain data files only. The App-owned media Worker,
//! sherpa adapter, and ONNX Runtime stay in the signed application bundle.

use crate::local_inference::{
    ComputeWorkloadIdentity, ComputeWorkloadKind, LocalComputeCoordinator, LocalComputeLease,
};
use crate::speech_model_pack::{
    inspect_installed_pack, install_plan, manifest_matches_source_lock, verify_installed_pack,
    verify_installed_pack_with_yield, InstalledPackError, ModelPackAsset, ModelPackAssetFormat,
    ModelPackInstallPlan, ModelPackLegalSource,
};
use futures_util::StreamExt;
use myagents_media_worker_protocol::{
    read_worker_response, write_control_frame, StartRequest, WorkerCommand, WorkerResponse,
    WorkloadIdentity, WorkloadInput, WorkloadKind, PROTOCOL_VERSION,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const MODEL_SETS_BASE_URL: &str = "https://download.myagents.io/models/speech/sets";
const MODEL_DOWNLOAD_HOST: &str = "download.myagents.io";
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 16 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 4_096;
const SPEECH_RESOURCE_VALIDATION_YIELDED: &str = "SPEECH_RESOURCE_VALIDATION_YIELDED";
const MAX_ARCHIVE_DECOMPRESSED_BYTES: u64 = 1024 * 1024 * 1024;
const MODEL_PROBE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const PROBE_POLL_INTERVAL: Duration = Duration::from_millis(50);
const MAX_PROBE_STDERR_BYTES: u64 = 64 * 1024;
const APP_SHUTDOWN_GRACE: Duration = Duration::from_secs(10);
const ACTIVE_POINTER_SCHEMA_VERSION: u32 = 1;
const MODEL_PACK_MANIFEST_SCHEMA_VERSION: u32 = 1;
const ACTIVATION_DURABILITY_WARNING: &str = "SPEECH_RESOURCE_ACTIVATION_DURABILITY_UNCONFIRMED";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SpeechModelPackStatusKind {
    NotInstalled,
    Checking,
    Downloading,
    Verifying,
    Installing,
    Removing,
    Ready,
    UpdateAvailable,
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SpeechModelPackStatus {
    pub status: SpeechModelPackStatusKind,
    pub usable: bool,
    pub active_revision: Option<String>,
    pub available_revision: String,
    pub downloaded_bytes: u64,
    pub total_download_bytes: u64,
    pub installed_model_bytes: u64,
    pub last_error_code: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ActivatedModelPack {
    pub revision: String,
    pub manifest_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivePointer {
    schema_version: u32,
    pack_revision: String,
    directory_name: String,
    manifest_sha256: String,
    manifest_signature: String,
    activated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignedPackIdentity {
    schema_version: u32,
    pack_id: String,
    pack_revision: String,
}

struct VerifiedReleaseManifest {
    bytes: Vec<u8>,
    signature: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Operation {
    Idle,
    Checking,
    Downloading,
    Verifying,
    Installing,
    Removing,
}

struct ModelPackState {
    operation: Operation,
    active: Option<ActivatedModelPack>,
    active_pointer: Option<ActivePointer>,
    downloaded_bytes: u64,
    last_error_code: Option<String>,
    running_probe: Option<Arc<Mutex<crate::process_cmd::ChildTree>>>,
}

pub struct SpeechModelPackManager {
    models_root: PathBuf,
    worker_path: PathBuf,
    native_manifest_path: PathBuf,
    onnx_runtime_path: Option<PathBuf>,
    compute_coordinator: Arc<LocalComputeCoordinator>,
    plan: ModelPackInstallPlan,
    cancelled: AtomicBool,
    state: Mutex<ModelPackState>,
}

impl SpeechModelPackManager {
    pub fn initialize(
        models_root: PathBuf,
        worker_path: PathBuf,
        native_manifest_path: PathBuf,
        onnx_runtime_path: Option<PathBuf>,
        compute_coordinator: Arc<LocalComputeCoordinator>,
    ) -> Result<Arc<Self>, String> {
        let plan = install_plan().map_err(|_| "SPEECH_RESOURCE_SOURCE_LOCK_INVALID".to_string())?;
        ensure_private_directory(&models_root)?;
        ensure_private_directory(&models_root.join("packs"))?;
        ensure_private_directory(&models_root.join("private"))?;
        cleanup_abandoned_operation_dirs(&models_root.join("private"))?;

        let (active, active_pointer, last_error_code, verify_after_startup) =
            match read_active_pointer(&models_root) {
                Ok(Some(pointer)) if pointer.pack_revision != plan.pack_revision => {
                    match verify_previous_revision_pointer(&models_root, &pointer, &plan.pack_id) {
                        Ok(()) => (None, Some(pointer), None, false),
                        Err(code) => (None, Some(pointer), Some(code.to_string()), false),
                    }
                }
                Ok(Some(pointer)) => {
                    match inspect_pointer_and_pack(&models_root, &pointer, &plan.pack_revision) {
                        Ok((active, pointer)) => (Some(active), Some(pointer), None, true),
                        Err(code) => (None, Some(pointer), Some(code.to_string()), false),
                    }
                }
                Ok(None) => (None, None, None, false),
                Err(code) => (None, None, Some(code.to_string()), false),
            };
        let downloaded_bytes = if active.is_some() {
            total_download_bytes(&plan)
        } else {
            0
        };
        let manager = Arc::new(Self {
            models_root,
            worker_path,
            native_manifest_path,
            onnx_runtime_path,
            compute_coordinator,
            plan,
            cancelled: AtomicBool::new(false),
            state: Mutex::new(ModelPackState {
                operation: if verify_after_startup {
                    Operation::Checking
                } else {
                    Operation::Idle
                },
                active,
                active_pointer,
                downloaded_bytes,
                last_error_code,
                running_probe: None,
            }),
        });
        Ok(manager)
    }

    pub fn status(&self) -> SpeechModelPackStatus {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let status = match state.operation {
            Operation::Checking => SpeechModelPackStatusKind::Checking,
            Operation::Downloading => SpeechModelPackStatusKind::Downloading,
            Operation::Verifying => SpeechModelPackStatusKind::Verifying,
            Operation::Installing => SpeechModelPackStatusKind::Installing,
            Operation::Removing => SpeechModelPackStatusKind::Removing,
            Operation::Idle
                if state
                    .last_error_code
                    .as_deref()
                    .is_some_and(|code| code != ACTIVATION_DURABILITY_WARNING) =>
            {
                SpeechModelPackStatusKind::Error
            }
            Operation::Idle if state.active.is_some() => SpeechModelPackStatusKind::Ready,
            Operation::Idle
                if state
                    .active_pointer
                    .as_ref()
                    .is_some_and(|pointer| pointer.pack_revision != self.plan.pack_revision) =>
            {
                SpeechModelPackStatusKind::UpdateAvailable
            }
            Operation::Idle => SpeechModelPackStatusKind::NotInstalled,
        };
        let active_revision = state
            .active
            .as_ref()
            .map(|pack| pack.revision.clone())
            .or_else(|| {
                if status == SpeechModelPackStatusKind::UpdateAvailable {
                    state
                        .active_pointer
                        .as_ref()
                        .map(|pointer| pointer.pack_revision.clone())
                } else {
                    None
                }
            });
        SpeechModelPackStatus {
            status,
            usable: state.active.is_some(),
            active_revision,
            available_revision: self.plan.pack_revision.clone(),
            downloaded_bytes: state.downloaded_bytes,
            total_download_bytes: total_download_bytes(&self.plan),
            installed_model_bytes: self.plan.installed_model_bytes,
            last_error_code: state.last_error_code.clone(),
        }
    }

    pub fn active_pack(&self) -> Option<ActivatedModelPack> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.active.clone())
    }

    pub fn resolve_revision(&self, revision: &str) -> Result<ActivatedModelPack, &'static str> {
        let (active, pointer) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
            state
                .active
                .clone()
                .zip(state.active_pointer.clone())
                .ok_or("SPEECH_MODEL_PACK_UNAVAILABLE")?
        };
        if active.revision != revision || pointer.pack_revision != revision {
            return Err("SPEECH_MODEL_PACK_REVISION_UNAVAILABLE");
        }
        // Startup has already restored a signed, metadata-checked activation.
        // The media Worker independently performs the full SHA-256 inventory
        // check immediately before loading any model, so repeating it here
        // would only move the same cost onto the user's action path.
        Ok(active)
    }

    pub async fn install(self: &Arc<Self>) -> Result<SpeechModelPackStatus, String> {
        if self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?
            .operation
            != Operation::Idle
        {
            return Err("SPEECH_RESOURCE_BUSY".into());
        }
        let cached_revision = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.active.as_ref().map(|pack| pack.revision.clone()));
        if let Some(revision) = cached_revision {
            let pointer = self
                .state
                .lock()
                .ok()
                .and_then(|state| state.active_pointer.clone());
            if pointer.as_ref().is_some_and(|pointer| {
                pointer.pack_revision == revision
                    && verify_pointer_and_pack(&self.models_root, pointer, &self.plan.pack_revision)
                        .is_ok()
            }) {
                return Ok(self.status());
            }
            if let Ok(mut state) = self.state.lock() {
                state.active = None;
                state.last_error_code = Some("SPEECH_RESOURCE_CORRUPT".into());
            }
        }
        let already_ready = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
            if state.operation != Operation::Idle {
                return Err("SPEECH_RESOURCE_BUSY".into());
            }
            if state
                .active
                .as_ref()
                .is_some_and(|pack| pack.revision == self.plan.pack_revision)
            {
                true
            } else {
                state.operation = Operation::Checking;
                state.downloaded_bytes = 0;
                state.last_error_code = None;
                self.cancelled.store(false, Ordering::Release);
                false
            }
        };
        if already_ready {
            return Ok(self.status());
        }

        let result = self.install_inner().await;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
        state.operation = Operation::Idle;
        match result {
            Ok((active, pointer, warning)) => {
                state.active = Some(active);
                state.active_pointer = Some(pointer);
                state.downloaded_bytes = total_download_bytes(&self.plan);
                state.last_error_code = warning.map(str::to_string);
                drop(state);
                Ok(self.status())
            }
            Err(code) => {
                state.last_error_code = Some(code.to_string());
                Err(code.to_string())
            }
        }
    }

    pub(crate) fn start_background_verification(self: &Arc<Self>) {
        let manager = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                // Keep model IO off the first-paint and Global Sidecar startup path.
                tokio::time::sleep(Duration::from_secs(10)).await;
                let pointer = manager
                    .state
                    .lock()
                    .ok()
                    .and_then(|state| state.active_pointer.clone());
                let Some(pointer_for_validation) = pointer.clone() else {
                    return;
                };
                let lease = manager
                    .compute_coordinator
                    .acquire(ComputeWorkloadIdentity {
                        kind: ComputeWorkloadKind::BackgroundResourceValidation,
                        id: "speech-model-resource-validation".to_string(),
                        generation: 1,
                    })
                    .await;
                let signal = lease.yield_signal();
                let validation_manager = Arc::clone(&manager);
                let result = tauri::async_runtime::spawn_blocking(move || {
                    verify_pointer_and_pack_with_yield(
                        &validation_manager.models_root,
                        &pointer_for_validation,
                        &validation_manager.plan.pack_revision,
                        &|| signal.should_yield(),
                    )
                })
                .await;
                drop(lease);
                let result = match result {
                    Ok(Err(SPEECH_RESOURCE_VALIDATION_YIELDED)) => continue,
                    Ok(result) => result,
                    Err(_) => Err("SPEECH_RESOURCE_CORRUPT"),
                };

                let Ok(mut state) = manager.state.lock() else {
                    return;
                };
                if state.operation != Operation::Checking || state.active_pointer != pointer {
                    return;
                }
                state.operation = Operation::Idle;
                match result {
                    Ok((active, _)) => {
                        state.active = Some(active);
                        state.downloaded_bytes = total_download_bytes(&manager.plan);
                        state.last_error_code = None;
                        crate::ulog_info!(
                            "[speech-resource] background model verification completed revision={}",
                            manager.plan.pack_revision
                        );
                    }
                    Err(code) => {
                        state.active = None;
                        state.downloaded_bytes = 0;
                        state.last_error_code = Some(code.to_string());
                        crate::ulog_warn!(
                            "[speech-resource] background model verification failed code={}",
                            code
                        );
                    }
                }
                break;
            }
        });
    }

    pub fn remove(&self, in_use: bool) -> Result<SpeechModelPackStatus, String> {
        let pointer = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
            if state.operation != Operation::Idle || in_use {
                return Err("SPEECH_RESOURCE_BUSY".into());
            }
            let pointer = state.active_pointer.clone();
            if pointer.is_none()
                && fs::symlink_metadata(self.models_root.join("active.json")).is_err()
                && !has_managed_pack_entries(&self.models_root.join("packs"))
            {
                drop(state);
                return Ok(self.status());
            }
            state.operation = Operation::Removing;
            state.last_error_code = None;
            pointer
        };

        let result = remove_model_packs(&self.models_root, pointer.as_ref());
        let mut state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE".to_string())?;
        state.operation = Operation::Idle;
        match result {
            Ok(()) => {
                state.active = None;
                state.active_pointer = None;
                state.downloaded_bytes = 0;
                state.last_error_code = None;
                drop(state);
                Ok(self.status())
            }
            Err(code) => {
                if !self.models_root.join("active.json").exists() {
                    state.active = None;
                    state.active_pointer = None;
                    state.downloaded_bytes = 0;
                }
                state.last_error_code = Some(code.to_string());
                Err(code.to_string())
            }
        }
    }

    pub fn cancel_operation(&self) {
        self.cancelled.store(true, Ordering::Release);
        let running = self
            .state
            .lock()
            .ok()
            .and_then(|state| state.running_probe.clone());
        if let Some(running) = running {
            let _ = crate::process_cmd::settle_tree(&running, APP_SHUTDOWN_GRACE);
        }
    }

    async fn install_inner(
        self: &Arc<Self>,
    ) -> Result<(ActivatedModelPack, ActivePointer, Option<&'static str>), &'static str> {
        self.ensure_not_cancelled()?;
        if !plain_file(&self.worker_path)
            || !plain_file(&self.native_manifest_path)
            || !self.onnx_runtime_path.as_deref().is_some_and(plain_file)
        {
            return Err("SPEECH_NATIVE_RUNTIME_UNAVAILABLE");
        }
        // This client intentionally targets the signed first-party resource
        // manifest and its pinned first-party HTTPS assets, never localhost.
        let client_builder = speech_model_http_client_builder();
        let client = crate::proxy_config::build_client_with_proxy(client_builder)
            .map_err(|_| "SPEECH_RESOURCE_NETWORK")?;
        let release_manifest = fetch_verified_release_manifest(&client, &self.plan).await?;
        self.ensure_not_cancelled()?;
        self.set_install_stage(Operation::Downloading)?;

        let operation_id = Uuid::new_v4().simple().to_string();
        let private_root = self.models_root.join("private");
        let download_root = private_root.join(format!(".download-{operation_id}"));
        let staging_root = private_root.join(format!(".staging-{operation_id}"));
        ensure_new_private_directory(&download_root)?;
        if let Err(code) = ensure_new_private_directory(&staging_root) {
            let _ = remove_owned_operation_dir(&download_root);
            return Err(code);
        }
        let result = self
            .download_extract_verify_activate(
                &client,
                &download_root,
                &staging_root,
                &operation_id,
                &release_manifest,
            )
            .await;
        let _ = remove_owned_operation_dir(&download_root);
        if result.is_err() {
            let _ = remove_owned_operation_dir(&staging_root);
        }
        result
    }

    async fn download_extract_verify_activate(
        self: &Arc<Self>,
        client: &reqwest::Client,
        download_root: &Path,
        staging_root: &Path,
        operation_id: &str,
        release_manifest: &VerifiedReleaseManifest,
    ) -> Result<(ActivatedModelPack, ActivePointer, Option<&'static str>), &'static str> {
        let mut downloaded_assets = HashMap::new();
        for asset in &self.plan.assets {
            self.ensure_not_cancelled()?;
            let destination = download_root.join(format!("{}.asset", asset.id));
            self.download_exact(client, &asset.url, &destination, asset.size, &asset.sha256)
                .await?;
            downloaded_assets.insert(asset.id.clone(), destination);
        }
        let mut downloaded_legal = HashMap::new();
        for legal in &self.plan.legal_artifacts {
            let ModelPackLegalSource::Remote { url, sha256, size } = &legal.source else {
                continue;
            };
            self.ensure_not_cancelled()?;
            let destination = download_root.join(format!("{}.legal", legal.id));
            self.download_exact(client, url, &destination, *size, sha256)
                .await?;
            downloaded_legal.insert(legal.id.clone(), destination);
        }
        self.set_install_stage(Operation::Verifying)?;

        let plan = self.plan.clone();
        let staging = staging_root.to_path_buf();
        let extracted = tokio::task::spawn_blocking(move || {
            materialize_pack(&plan, &downloaded_assets, &downloaded_legal, &staging)
        })
        .await
        .map_err(|_| "SPEECH_RESOURCE_ARCHIVE_INVALID")?;
        extracted?;
        self.ensure_not_cancelled()?;

        let manifest_path = staging_root.join("manifest.json");
        // Persist the exact bytes covered by the detached signature. The App
        // and Worker compare the typed lock identity, so platform-specific
        // source checkout line endings never become part of compatibility.
        write_new_synced_file(&manifest_path, &release_manifest.bytes)?;
        crate::durable_fs::sync_directory(staging_root)
            .map_err(|_| "SPEECH_RESOURCE_STORE_WRITE_FAILED")?;
        verify_installed_pack(&manifest_path).map_err(|_| "SPEECH_RESOURCE_PACK_INVALID")?;
        self.set_install_stage(Operation::Installing)?;
        self.probe_model_pack(&manifest_path).await?;
        self.ensure_not_cancelled()?;

        let directory_name = format!("pack-{operation_id}");
        let final_root = self.models_root.join("packs").join(&directory_name);
        crate::durable_fs::rename_directory_noreplace(staging_root, &final_root)
            .map_err(|_| "SPEECH_RESOURCE_ACTIVATION_FAILED")?;
        crate::durable_fs::sync_directory(&self.models_root.join("packs"))
            .map_err(|_| "SPEECH_RESOURCE_ACTIVATION_FAILED")?;

        let pointer = ActivePointer {
            schema_version: ACTIVE_POINTER_SCHEMA_VERSION,
            pack_revision: self.plan.pack_revision.clone(),
            directory_name,
            manifest_sha256: format!("{:x}", Sha256::digest(&release_manifest.bytes)),
            manifest_signature: release_manifest.signature.clone(),
            activated_at: chrono::Utc::now().to_rfc3339(),
        };
        let pointer_commit = match write_active_pointer(&self.models_root, &pointer) {
            Ok(commit) => commit,
            Err(code) => {
                let _ = remove_plain_directory_tree(&final_root);
                return Err(code);
            }
        };
        let active = ActivatedModelPack {
            revision: pointer.pack_revision.clone(),
            manifest_path: final_root.join("manifest.json"),
        };
        let warning = match pointer_commit {
            ActivePointerCommit::Durable => None,
            ActivePointerCommit::VisibleNotDurable => Some(ACTIVATION_DURABILITY_WARNING),
        };
        Ok((active, pointer, warning))
    }

    async fn download_exact(
        &self,
        client: &reqwest::Client,
        url: &str,
        destination: &Path,
        expected_size: u64,
        expected_sha256: &str,
    ) -> Result<(), &'static str> {
        let response = client
            .get(url)
            .send()
            .await
            .map_err(|_| "SPEECH_RESOURCE_NETWORK")?
            .error_for_status()
            .map_err(|_| "SPEECH_RESOURCE_NETWORK")?;
        validate_model_resource_response(response.url())?;
        if response
            .content_length()
            .is_some_and(|size| size != expected_size)
        {
            return Err("SPEECH_RESOURCE_DOWNLOAD_INVALID");
        }
        let mut file = create_new_private_file(destination)?;
        let mut digest = Sha256::new();
        let mut received = 0_u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            self.ensure_not_cancelled()?;
            let chunk = chunk.map_err(|_| "SPEECH_RESOURCE_NETWORK")?;
            received = received
                .checked_add(chunk.len() as u64)
                .ok_or("SPEECH_RESOURCE_DOWNLOAD_INVALID")?;
            if received > expected_size {
                return Err("SPEECH_RESOURCE_DOWNLOAD_INVALID");
            }
            file.write_all(&chunk)
                .map_err(|_| "SPEECH_RESOURCE_STORE_WRITE_FAILED")?;
            digest.update(&chunk);
            self.add_downloaded_bytes(chunk.len() as u64)?;
        }
        file.flush()
            .and_then(|()| file.sync_all())
            .map_err(|_| "SPEECH_RESOURCE_STORE_WRITE_FAILED")?;
        if received != expected_size || format!("{:x}", digest.finalize()) != expected_sha256 {
            return Err("SPEECH_RESOURCE_DOWNLOAD_INVALID");
        }
        Ok(())
    }

    async fn probe_model_pack(self: &Arc<Self>, manifest_path: &Path) -> Result<(), &'static str> {
        let mut generation = 1_u64;
        loop {
            self.ensure_not_cancelled()?;
            let identity = ComputeWorkloadIdentity {
                kind: ComputeWorkloadKind::SpeechModelValidation,
                id: format!("model-probe-{}", Uuid::new_v4().simple()),
                generation,
            };
            let lease = self.compute_coordinator.acquire(identity.clone()).await;
            self.ensure_not_cancelled()?;
            let manager = Arc::clone(self);
            let manifest = manifest_path.to_path_buf();
            let result = tokio::task::spawn_blocking(move || {
                manager.run_probe_attempt(&identity.id, generation, &manifest, lease)
            })
            .await
            .map_err(|_| "SPEECH_MODEL_LOAD_FAILED")??;
            if result == ProbeAttempt::Ready {
                return Ok(());
            }
            generation = generation.saturating_add(1).max(1);
        }
    }

    fn run_probe_attempt(
        &self,
        workload_id: &str,
        generation: u64,
        manifest_path: &Path,
        lease: LocalComputeLease,
    ) -> Result<ProbeAttempt, &'static str> {
        let native_manifest_path = absolute_protocol_path(&self.native_manifest_path)?;
        let onnx_runtime_path = absolute_protocol_path(
            self.onnx_runtime_path
                .as_deref()
                .ok_or("SPEECH_NATIVE_RUNTIME_UNAVAILABLE")?,
        )?;
        let model_pack_manifest_path = absolute_protocol_path(manifest_path)?;
        let lifecycle_permit = crate::sidecar::begin_lifecycle_spawn_permit()
            .map_err(|_| "SPEECH_RESOURCE_INSTALL_INTERRUPTED")?;
        let mut command = crate::process_cmd::new(&self.worker_path);
        command
            .current_dir(
                manifest_path
                    .parent()
                    .ok_or("SPEECH_RESOURCE_PACK_INVALID")?,
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_clear();
        let mut child = crate::process_cmd::spawn_tree(&mut command)
            .map_err(|_| "SPEECH_WORKER_START_FAILED")?;
        let mut stdin = child.stdin.take().ok_or("SPEECH_WORKER_PROTOCOL_ERROR")?;
        let stdout = child.stdout.take().ok_or("SPEECH_WORKER_PROTOCOL_ERROR")?;
        let stderr = child.stderr.take().ok_or("SPEECH_WORKER_PROTOCOL_ERROR")?;
        let child = Arc::new(Mutex::new(child));
        self.set_running_probe(Some(Arc::clone(&child)));
        drop(lifecycle_permit);

        let identity = WorkloadIdentity {
            workload_id: workload_id.to_string(),
            worker_generation: generation,
        };
        let start = WorkerCommand::Start(StartRequest {
            protocol_version: PROTOCOL_VERSION,
            identity: identity.clone(),
            workload_kind: WorkloadKind::ModelPackProbe,
            input: WorkloadInput::ModelPackProbe,
            native_manifest_path,
            onnx_runtime_path,
            model_pack_manifest_path,
        });
        if write_control_frame(&mut stdin, &start).is_err() || stdin.flush().is_err() {
            kill_probe(&child);
            self.set_running_probe(None);
            return Err("SPEECH_WORKER_PROTOCOL_ERROR");
        }
        drop(stdin);
        drain_probe_stderr(stderr);
        let (response_tx, response_rx) = mpsc::sync_channel(1);
        let reader = thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let _ = response_tx.send(read_worker_response(&mut reader));
        });

        let started = Instant::now();
        let mut ready = false;
        let outcome = loop {
            if self.cancelled.load(Ordering::Acquire) {
                kill_probe(&child);
                break Err("SPEECH_RESOURCE_INSTALL_INTERRUPTED");
            }
            if lease.should_yield() {
                kill_probe(&child);
                break Ok(ProbeAttempt::Yielded);
            }
            if started.elapsed() >= MODEL_PROBE_TIMEOUT {
                kill_probe(&child);
                break Err("SPEECH_MODEL_LOAD_TIMEOUT");
            }
            if !ready {
                match response_rx.try_recv() {
                    Ok(Ok(Some(WorkerResponse::Ready {
                        identity: response_identity,
                        ..
                    }))) if response_identity == identity => ready = true,
                    Ok(Ok(Some(WorkerResponse::Failed {
                        identity: response_identity,
                        code,
                        ..
                    }))) if response_identity == identity => {
                        let code = model_probe_worker_error(&code);
                        crate::ulog_warn!(
                            "[speech-resource] model probe worker failed code={}",
                            code
                        );
                        kill_probe(&child);
                        break Err(code);
                    }
                    Ok(Ok(Some(_)))
                    | Ok(Ok(None))
                    | Ok(Err(_))
                    | Err(mpsc::TryRecvError::Disconnected) => {
                        kill_probe(&child);
                        break Err("SPEECH_MODEL_LOAD_FAILED");
                    }
                    Err(mpsc::TryRecvError::Empty) => {}
                }
            }
            let status = child
                .lock()
                .map_err(|_| "SPEECH_MODEL_LOAD_FAILED")?
                .try_wait()
                .map_err(|_| "SPEECH_MODEL_LOAD_FAILED")?;
            if let Some(status) = status {
                break if ready && status.success() {
                    Ok(ProbeAttempt::Ready)
                } else {
                    Err("SPEECH_MODEL_LOAD_FAILED")
                };
            }
            thread::sleep(PROBE_POLL_INTERVAL);
        };
        let _ = reader.join();
        self.set_running_probe(None);
        outcome
    }

    fn set_running_probe(&self, probe: Option<Arc<Mutex<crate::process_cmd::ChildTree>>>) {
        if let Ok(mut state) = self.state.lock() {
            state.running_probe = probe;
        }
    }

    fn add_downloaded_bytes(&self, bytes: u64) -> Result<(), &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        state.downloaded_bytes = state
            .downloaded_bytes
            .checked_add(bytes)
            .ok_or("SPEECH_RESOURCE_DOWNLOAD_INVALID")?;
        if state.downloaded_bytes > self.plan.download_hard_limit_bytes {
            return Err("SPEECH_RESOURCE_DOWNLOAD_INVALID");
        }
        Ok(())
    }

    fn set_install_stage(&self, stage: Operation) -> Result<(), &'static str> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "SPEECH_MANAGER_UNAVAILABLE")?;
        state.operation = stage;
        Ok(())
    }

    fn ensure_not_cancelled(&self) -> Result<(), &'static str> {
        if self.cancelled.load(Ordering::Acquire) {
            Err("SPEECH_RESOURCE_INSTALL_INTERRUPTED")
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeAttempt {
    Ready,
    Yielded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActivePointerCommit {
    Durable,
    VisibleNotDurable,
}

async fn fetch_verified_release_manifest(
    client: &reqwest::Client,
    plan: &ModelPackInstallPlan,
) -> Result<VerifiedReleaseManifest, &'static str> {
    let manifest_url = release_manifest_url(&plan.pack_revision);
    let signature_url = format!("{manifest_url}.sig");
    let manifest = fetch_limited_bytes(
        client,
        &manifest_url,
        MAX_MANIFEST_BYTES,
        MODEL_DOWNLOAD_HOST,
    )
    .await?;
    let signature_bytes = fetch_limited_bytes(
        client,
        &signature_url,
        MAX_SIGNATURE_BYTES,
        MODEL_DOWNLOAD_HOST,
    )
    .await?;
    let signature =
        String::from_utf8(signature_bytes).map_err(|_| "SPEECH_RESOURCE_SIGNATURE_INVALID")?;
    let signature = signature.trim();
    if signature.is_empty() {
        return Err("SPEECH_RESOURCE_SIGNATURE_INVALID");
    }
    crate::resource_signature::verify_minisign_bytes(&manifest, signature, "speech model manifest")
        .map_err(|_| "SPEECH_RESOURCE_SIGNATURE_INVALID")?;
    if !manifest_matches_source_lock(&manifest) {
        return Err("SPEECH_RESOURCE_MANIFEST_INVALID");
    }
    Ok(VerifiedReleaseManifest {
        bytes: manifest,
        signature: signature.to_string(),
    })
}

fn release_manifest_url(pack_revision: &str) -> String {
    format!("{MODEL_SETS_BASE_URL}/{pack_revision}/manifest.json")
}

#[allow(clippy::disallowed_methods)]
fn speech_model_http_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent(format!("MyAgents/{}", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(30 * 60))
}

async fn fetch_limited_bytes(
    client: &reqwest::Client,
    url: &str,
    limit: u64,
    expected_host: &str,
) -> Result<Vec<u8>, &'static str> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "SPEECH_RESOURCE_NETWORK")?
        .error_for_status()
        .map_err(|_| "SPEECH_RESOURCE_NETWORK")?;
    if response.url().scheme() != "https" || response.url().host_str() != Some(expected_host) {
        return Err("SPEECH_RESOURCE_NETWORK");
    }
    if response.content_length().is_some_and(|size| size > limit) {
        return Err("SPEECH_RESOURCE_MANIFEST_INVALID");
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "SPEECH_RESOURCE_NETWORK")?;
        if (bytes.len() as u64).saturating_add(chunk.len() as u64) > limit {
            return Err("SPEECH_RESOURCE_MANIFEST_INVALID");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn validate_model_resource_response(url: &reqwest::Url) -> Result<(), &'static str> {
    if url.scheme() != "https" || url.host_str() != Some(MODEL_DOWNLOAD_HOST) {
        return Err("SPEECH_RESOURCE_NETWORK");
    }
    Ok(())
}

fn total_download_bytes(plan: &ModelPackInstallPlan) -> u64 {
    plan.legal_artifacts
        .iter()
        .filter_map(|legal| match legal.source {
            ModelPackLegalSource::Remote { size, .. } => Some(size),
            ModelPackLegalSource::Archive { .. } => None,
        })
        .fold(plan.source_download_bytes, u64::saturating_add)
}

fn materialize_pack(
    plan: &ModelPackInstallPlan,
    downloaded_assets: &HashMap<String, PathBuf>,
    downloaded_legal: &HashMap<String, PathBuf>,
    staging_root: &Path,
) -> Result<(), &'static str> {
    for asset in &plan.assets {
        let downloaded = downloaded_assets
            .get(&asset.id)
            .ok_or("SPEECH_RESOURCE_DOWNLOAD_INVALID")?;
        match asset.format {
            ModelPackAssetFormat::File => materialize_file_asset(asset, downloaded, staging_root)?,
            ModelPackAssetFormat::TarBz2 => {
                materialize_archive_asset(plan, asset, downloaded, staging_root)?
            }
        }
    }
    for legal in &plan.legal_artifacts {
        if !matches!(legal.source, ModelPackLegalSource::Remote { .. }) {
            continue;
        }
        let source = downloaded_legal
            .get(&legal.id)
            .ok_or("SPEECH_RESOURCE_DOWNLOAD_INVALID")?;
        let destination = resolve_staging_file(staging_root, &legal.install_path)?;
        copy_verified_file(
            source,
            &destination,
            expected_legal_size(legal)?,
            expected_legal_sha(legal)?,
        )?;
    }
    Ok(())
}

fn materialize_file_asset(
    asset: &ModelPackAsset,
    downloaded: &Path,
    staging_root: &Path,
) -> Result<(), &'static str> {
    if asset.selected_files.len() != 1 {
        return Err("SPEECH_RESOURCE_PACK_INVALID");
    }
    let selected = &asset.selected_files[0];
    let destination = resolve_staging_file(staging_root, &selected.install_path)?;
    copy_verified_file(downloaded, &destination, selected.size, &selected.sha256)
}

fn materialize_archive_asset(
    plan: &ModelPackInstallPlan,
    asset: &ModelPackAsset,
    downloaded: &Path,
    staging_root: &Path,
) -> Result<(), &'static str> {
    let mut requested = asset
        .selected_files
        .iter()
        .map(|selected| {
            (
                selected.source_path.clone(),
                (
                    selected.install_path.clone(),
                    selected.size,
                    selected.sha256.clone(),
                ),
            )
        })
        .collect::<HashMap<_, _>>();
    for legal in &plan.legal_artifacts {
        let ModelPackLegalSource::Archive {
            asset_id,
            source_path,
            sha256,
            size,
        } = &legal.source
        else {
            continue;
        };
        if asset_id == &asset.id
            && requested
                .insert(
                    source_path.clone(),
                    (legal.install_path.clone(), *size, sha256.clone()),
                )
                .is_some()
        {
            return Err("SPEECH_RESOURCE_ARCHIVE_INVALID");
        }
    }

    let file = File::open(downloaded).map_err(|_| "SPEECH_RESOURCE_ARCHIVE_INVALID")?;
    let decoder = bzip2_rs::DecoderReader::new(file);
    let limited = decoder.take(MAX_ARCHIVE_DECOMPRESSED_BYTES.saturating_add(1));
    materialize_tar_reader(limited, requested, staging_root)
}

fn materialize_tar_reader(
    reader: impl Read,
    requested: HashMap<String, (String, u64, String)>,
    staging_root: &Path,
) -> Result<(), &'static str> {
    let mut archive = tar::Archive::new(reader);
    let mut seen = HashSet::new();
    let mut installed = HashSet::new();
    let entries = archive
        .entries()
        .map_err(|_| "SPEECH_RESOURCE_ARCHIVE_INVALID")?;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_ARCHIVE_ENTRIES {
            return Err("SPEECH_RESOURCE_ARCHIVE_INVALID");
        }
        let mut entry = entry.map_err(|_| "SPEECH_RESOURCE_ARCHIVE_INVALID")?;
        let entry_type = entry.header().entry_type();
        let path = entry
            .path()
            .map_err(|_| "SPEECH_RESOURCE_ARCHIVE_INVALID")?;
        let path = path
            .to_str()
            .ok_or("SPEECH_RESOURCE_ARCHIVE_INVALID")?
            .to_string();
        let path = normalized_archive_entry_path(&path, entry_type.is_dir())
            .ok_or("SPEECH_RESOURCE_ARCHIVE_INVALID")?
            .to_string();
        if !seen.insert(path.clone()) {
            return Err("SPEECH_RESOURCE_ARCHIVE_INVALID");
        }
        if entry_type.is_dir() {
            continue;
        }
        if !entry_type.is_file() {
            return Err("SPEECH_RESOURCE_ARCHIVE_INVALID");
        }
        let Some((install_path, expected_size, expected_sha256)) = requested.get(&path) else {
            continue;
        };
        let destination = resolve_staging_file(staging_root, install_path)?;
        write_reader_verified(&mut entry, &destination, *expected_size, expected_sha256)?;
        installed.insert(path);
    }
    if installed.len() != requested.len() {
        return Err("SPEECH_RESOURCE_ARCHIVE_INVALID");
    }
    Ok(())
}

fn expected_legal_size(
    legal: &crate::speech_model_pack::ModelPackLegalArtifact,
) -> Result<u64, &'static str> {
    match legal.source {
        ModelPackLegalSource::Remote { size, .. } => Ok(size),
        ModelPackLegalSource::Archive { .. } => Err("SPEECH_RESOURCE_PACK_INVALID"),
    }
}

fn expected_legal_sha(
    legal: &crate::speech_model_pack::ModelPackLegalArtifact,
) -> Result<&str, &'static str> {
    match &legal.source {
        ModelPackLegalSource::Remote { sha256, .. } => Ok(sha256),
        ModelPackLegalSource::Archive { .. } => Err("SPEECH_RESOURCE_PACK_INVALID"),
    }
}

fn copy_verified_file(
    source: &Path,
    destination: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), &'static str> {
    let mut source = File::open(source).map_err(|_| "SPEECH_RESOURCE_DOWNLOAD_INVALID")?;
    write_reader_verified(&mut source, destination, expected_size, expected_sha256)
}

fn write_reader_verified(
    reader: &mut impl Read,
    destination: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), &'static str> {
    let parent = destination
        .parent()
        .ok_or("SPEECH_RESOURCE_STORE_WRITE_FAILED")?;
    ensure_private_directory(parent)?;
    let mut destination_file = create_new_private_file(destination)?;
    let mut digest = Sha256::new();
    let mut written = 0_u64;
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| "SPEECH_RESOURCE_ARCHIVE_INVALID")?;
        if read == 0 {
            break;
        }
        written = written
            .checked_add(read as u64)
            .ok_or("SPEECH_RESOURCE_PACK_INVALID")?;
        if written > expected_size {
            return Err("SPEECH_RESOURCE_PACK_INVALID");
        }
        destination_file
            .write_all(&buffer[..read])
            .map_err(|_| "SPEECH_RESOURCE_STORE_WRITE_FAILED")?;
        digest.update(&buffer[..read]);
    }
    destination_file
        .flush()
        .and_then(|()| destination_file.sync_all())
        .map_err(|_| "SPEECH_RESOURCE_STORE_WRITE_FAILED")?;
    if written != expected_size || format!("{:x}", digest.finalize()) != expected_sha256 {
        return Err("SPEECH_RESOURCE_PACK_INVALID");
    }
    Ok(())
}

fn read_active_pointer(models_root: &Path) -> Result<Option<ActivePointer>, &'static str> {
    let path = models_root.join("active.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("SPEECH_RESOURCE_CORRUPT"),
    };
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_MANIFEST_BYTES
    {
        return Err("SPEECH_RESOURCE_CORRUPT");
    }
    let bytes = fs::read(&path).map_err(|_| "SPEECH_RESOURCE_CORRUPT")?;
    let pointer: ActivePointer =
        serde_json::from_slice(&bytes).map_err(|_| "SPEECH_RESOURCE_CORRUPT")?;
    Ok(Some(pointer))
}

/// Recognizes a previously installed first-party revision without making it
/// executable in the current App. The current source lock remains the only
/// authority that can produce an `ActivatedModelPack`.
fn verify_previous_revision_pointer(
    models_root: &Path,
    pointer: &ActivePointer,
    expected_pack_id: &str,
) -> Result<(), &'static str> {
    if pointer.schema_version != ACTIVE_POINTER_SCHEMA_VERSION
        || !valid_pack_directory_name(&pointer.directory_name)
        || pointer.manifest_signature.is_empty()
        || pointer.manifest_signature.len() as u64 > MAX_SIGNATURE_BYTES
        || chrono::DateTime::parse_from_rfc3339(&pointer.activated_at).is_err()
    {
        return Err("SPEECH_RESOURCE_CORRUPT");
    }

    let pack_root = models_root.join("packs").join(&pointer.directory_name);
    ensure_plain_directory(&pack_root).map_err(|_| "SPEECH_RESOURCE_CORRUPT")?;
    let manifest_path = pack_root.join("manifest.json");
    let metadata = fs::symlink_metadata(&manifest_path).map_err(|_| "SPEECH_RESOURCE_CORRUPT")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() == 0
        || metadata.len() > MAX_MANIFEST_BYTES
    {
        return Err("SPEECH_RESOURCE_CORRUPT");
    }
    let manifest = fs::read(&manifest_path).map_err(|_| "SPEECH_RESOURCE_CORRUPT")?;
    if pointer.manifest_sha256 != format!("{:x}", Sha256::digest(&manifest)) {
        return Err("SPEECH_RESOURCE_CORRUPT");
    }
    crate::resource_signature::verify_minisign_bytes(
        &manifest,
        &pointer.manifest_signature,
        "speech model manifest",
    )
    .map_err(|_| "SPEECH_RESOURCE_CORRUPT")?;
    let identity: SignedPackIdentity =
        serde_json::from_slice(&manifest).map_err(|_| "SPEECH_RESOURCE_CORRUPT")?;
    if identity.schema_version != MODEL_PACK_MANIFEST_SCHEMA_VERSION
        || identity.pack_id != expected_pack_id
        || identity.pack_revision != pointer.pack_revision
    {
        return Err("SPEECH_RESOURCE_CORRUPT");
    }
    Ok(())
}

fn verify_pointer_and_pack(
    models_root: &Path,
    pointer: &ActivePointer,
    expected_revision: &str,
) -> Result<(ActivatedModelPack, ActivePointer), &'static str> {
    let manifest_path = validate_active_pointer(models_root, pointer, expected_revision)?;
    let verified = verify_installed_pack(&manifest_path).map_err(|_| "SPEECH_RESOURCE_CORRUPT")?;
    if verified.pack_revision != pointer.pack_revision {
        return Err("SPEECH_RESOURCE_CORRUPT");
    }
    Ok((
        ActivatedModelPack {
            revision: verified.pack_revision,
            manifest_path,
        },
        pointer.clone(),
    ))
}

fn verify_pointer_and_pack_with_yield(
    models_root: &Path,
    pointer: &ActivePointer,
    expected_revision: &str,
    should_yield: &dyn Fn() -> bool,
) -> Result<(ActivatedModelPack, ActivePointer), &'static str> {
    let manifest_path = validate_active_pointer(models_root, pointer, expected_revision)?;
    let verified = verify_installed_pack_with_yield(&manifest_path, should_yield).map_err(
        |error| match error {
            InstalledPackError::Yielded => SPEECH_RESOURCE_VALIDATION_YIELDED,
            _ => "SPEECH_RESOURCE_CORRUPT",
        },
    )?;
    if verified.pack_revision != pointer.pack_revision {
        return Err("SPEECH_RESOURCE_CORRUPT");
    }
    Ok((
        ActivatedModelPack {
            revision: verified.pack_revision,
            manifest_path,
        },
        pointer.clone(),
    ))
}

fn inspect_pointer_and_pack(
    models_root: &Path,
    pointer: &ActivePointer,
    expected_revision: &str,
) -> Result<(ActivatedModelPack, ActivePointer), &'static str> {
    let manifest_path = validate_active_pointer(models_root, pointer, expected_revision)?;
    let inspected =
        inspect_installed_pack(&manifest_path).map_err(|_| "SPEECH_RESOURCE_CORRUPT")?;
    if inspected.pack_revision != pointer.pack_revision {
        return Err("SPEECH_RESOURCE_CORRUPT");
    }
    Ok((
        ActivatedModelPack {
            revision: inspected.pack_revision,
            manifest_path,
        },
        pointer.clone(),
    ))
}

fn validate_active_pointer(
    models_root: &Path,
    pointer: &ActivePointer,
    expected_revision: &str,
) -> Result<PathBuf, &'static str> {
    if pointer.schema_version != ACTIVE_POINTER_SCHEMA_VERSION
        || pointer.pack_revision != expected_revision
        || !valid_pack_directory_name(&pointer.directory_name)
        || pointer.manifest_sha256.len() != 64
        || !pointer
            .manifest_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || pointer.manifest_signature.is_empty()
        || pointer.manifest_signature.len() as u64 > MAX_SIGNATURE_BYTES
        || chrono::DateTime::parse_from_rfc3339(&pointer.activated_at).is_err()
    {
        return Err("SPEECH_RESOURCE_CORRUPT");
    }

    let pack_root = models_root.join("packs").join(&pointer.directory_name);
    ensure_plain_directory(&pack_root)?;
    let manifest_path = pack_root.join("manifest.json");
    let metadata = fs::symlink_metadata(&manifest_path).map_err(|_| "SPEECH_RESOURCE_CORRUPT")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() == 0
        || metadata.len() > MAX_MANIFEST_BYTES
    {
        return Err("SPEECH_RESOURCE_CORRUPT");
    }
    let manifest = fs::read(&manifest_path).map_err(|_| "SPEECH_RESOURCE_CORRUPT")?;
    if pointer.manifest_sha256 != format!("{:x}", Sha256::digest(&manifest))
        || !manifest_matches_source_lock(&manifest)
    {
        return Err("SPEECH_RESOURCE_CORRUPT");
    }
    crate::resource_signature::verify_minisign_bytes(
        &manifest,
        &pointer.manifest_signature,
        "speech model manifest",
    )
    .map_err(|_| "SPEECH_RESOURCE_CORRUPT")?;
    Ok(manifest_path)
}

fn write_active_pointer(
    models_root: &Path,
    pointer: &ActivePointer,
) -> Result<ActivePointerCommit, &'static str> {
    let bytes =
        serde_json::to_vec_pretty(pointer).map_err(|_| "SPEECH_RESOURCE_ACTIVATION_FAILED")?;
    let temporary = models_root.join(format!(".active-{}.tmp", Uuid::new_v4().simple()));
    write_new_synced_file(&temporary, &bytes)?;
    let active = models_root.join("active.json");
    if fs::symlink_metadata(&active)
        .is_ok_and(|metadata| metadata.file_type().is_symlink() || !metadata.is_file())
    {
        let _ = fs::remove_file(&temporary);
        return Err("SPEECH_RESOURCE_ACTIVATION_FAILED");
    }
    if fs::rename(&temporary, &active).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err("SPEECH_RESOURCE_ACTIVATION_FAILED");
    }
    Ok(if crate::durable_fs::sync_directory(models_root).is_ok() {
        ActivePointerCommit::Durable
    } else {
        // The rename is already visible and may become durable despite the
        // failed directory sync. Retain the referenced pack and expose the
        // uncertainty; deleting it here would create a dangling active pointer.
        ActivePointerCommit::VisibleNotDurable
    })
}

fn remove_model_packs(
    models_root: &Path,
    expected_pointer: Option<&ActivePointer>,
) -> Result<(), &'static str> {
    let active = models_root.join("active.json");
    if let Some(expected) = expected_pointer {
        let current = read_active_pointer(models_root)?.ok_or("SPEECH_RESOURCE_CHANGED")?;
        if &current != expected {
            return Err("SPEECH_RESOURCE_CHANGED");
        }
    }
    match fs::symlink_metadata(&active) {
        Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
            fs::remove_file(&active).map_err(|_| "SPEECH_RESOURCE_REMOVE_FAILED")?;
        }
        Ok(_) => return Err("SPEECH_RESOURCE_REMOVE_FAILED"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("SPEECH_RESOURCE_REMOVE_FAILED"),
    }
    crate::durable_fs::sync_directory(models_root).map_err(|_| "SPEECH_RESOURCE_REMOVE_FAILED")?;
    let packs_root = models_root.join("packs");
    for entry in fs::read_dir(&packs_root).map_err(|_| "SPEECH_RESOURCE_REMOVE_FAILED")? {
        let entry = entry.map_err(|_| "SPEECH_RESOURCE_REMOVE_FAILED")?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !valid_pack_directory_name(name) {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| "SPEECH_RESOURCE_REMOVE_FAILED")?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            fs::remove_dir_all(&path).map_err(|_| "SPEECH_RESOURCE_REMOVE_FAILED")?;
        } else if metadata.file_type().is_symlink() || metadata.is_file() {
            fs::remove_file(&path).map_err(|_| "SPEECH_RESOURCE_REMOVE_FAILED")?;
        }
    }
    crate::durable_fs::sync_directory(&packs_root).map_err(|_| "SPEECH_RESOURCE_REMOVE_FAILED")
}

fn has_managed_pack_entries(packs_root: &Path) -> bool {
    fs::read_dir(packs_root).is_ok_and(|entries| {
        entries.filter_map(Result::ok).any(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(valid_pack_directory_name)
        })
    })
}

fn cleanup_abandoned_operation_dirs(private_root: &Path) -> Result<(), String> {
    ensure_plain_directory(private_root).map_err(str::to_string)?;
    for entry in
        fs::read_dir(private_root).map_err(|error| format!("read model private root: {error}"))?
    {
        let entry = entry.map_err(|error| format!("read model private entry: {error}"))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(".download-") && !name.starts_with(".staging-") {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| format!("inspect model private entry: {error}"))?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            fs::remove_dir_all(entry.path())
                .map_err(|error| format!("remove abandoned model directory: {error}"))?;
        }
    }
    Ok(())
}

fn remove_owned_operation_dir(path: &Path) -> Result<(), &'static str> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("SPEECH_RESOURCE_STORE_WRITE_FAILED")?;
    if !name.starts_with(".download-") && !name.starts_with(".staging-") {
        return Err("SPEECH_RESOURCE_STORE_WRITE_FAILED");
    }
    remove_plain_directory_tree(path)
}

fn remove_plain_directory_tree(path: &Path) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "SPEECH_RESOURCE_REMOVE_FAILED")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("SPEECH_RESOURCE_REMOVE_FAILED");
    }
    fs::remove_dir_all(path).map_err(|_| "SPEECH_RESOURCE_REMOVE_FAILED")
}

fn ensure_new_private_directory(path: &Path) -> Result<(), &'static str> {
    fs::create_dir(path).map_err(|_| "SPEECH_RESOURCE_STORE_WRITE_FAILED")?;
    set_private_directory_permissions(path)?;
    ensure_plain_directory(path)
}

fn ensure_private_directory(path: &Path) -> Result<(), &'static str> {
    fs::create_dir_all(path).map_err(|_| "SPEECH_RESOURCE_STORE_WRITE_FAILED")?;
    ensure_plain_directory(path)?;
    set_private_directory_permissions(path)
}

fn ensure_plain_directory(path: &Path) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "SPEECH_RESOURCE_STORE_WRITE_FAILED")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("SPEECH_RESOURCE_STORE_WRITE_FAILED");
    }
    Ok(())
}

fn set_private_directory_permissions(path: &Path) -> Result<(), &'static str> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "SPEECH_RESOURCE_STORE_WRITE_FAILED")?;
    }
    Ok(())
}

fn create_new_private_file(path: &Path) -> Result<File, &'static str> {
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|_| "SPEECH_RESOURCE_STORE_WRITE_FAILED")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "SPEECH_RESOURCE_STORE_WRITE_FAILED")?;
    }
    Ok(file)
}

fn write_new_synced_file(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    let mut file = create_new_private_file(path)?;
    file.write_all(bytes)
        .and_then(|()| file.flush())
        .and_then(|()| file.sync_all())
        .map_err(|_| "SPEECH_RESOURCE_STORE_WRITE_FAILED")
}

fn resolve_staging_file(root: &Path, relative: &str) -> Result<PathBuf, &'static str> {
    if !safe_relative_path(relative) {
        return Err("SPEECH_RESOURCE_PACK_INVALID");
    }
    let mut destination = root.to_path_buf();
    for component in Path::new(relative).components() {
        let Component::Normal(name) = component else {
            return Err("SPEECH_RESOURCE_PACK_INVALID");
        };
        destination.push(name);
    }
    Ok(destination)
}

fn safe_relative_path(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !has_windows_drive_prefix(value)
        && !value.contains(['\\', '\0'])
        && value
            .split('/')
            .all(|part| !part.is_empty() && !matches!(part, "." | ".."))
}

fn has_windows_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn normalized_archive_entry_path(value: &str, is_directory: bool) -> Option<&str> {
    // A trailing separator is the canonical tar spelling for a directory. Strip
    // exactly one before applying the same strict relative-path policy as files.
    let normalized = if is_directory {
        value.strip_suffix('/').unwrap_or(value)
    } else {
        value
    };
    safe_relative_path(normalized).then_some(normalized)
}

fn valid_pack_directory_name(value: &str) -> bool {
    value.strip_prefix("pack-").is_some_and(|suffix| {
        suffix.len() == 32 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn absolute_protocol_path(path: &Path) -> Result<String, &'static str> {
    if !path.is_absolute() {
        return Err("SPEECH_PATH_ENCODING_UNSUPPORTED");
    }
    path.to_str()
        .map(str::to_string)
        .ok_or("SPEECH_PATH_ENCODING_UNSUPPORTED")
}

fn plain_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
}

fn kill_probe(child: &Arc<Mutex<crate::process_cmd::ChildTree>>) {
    if let Ok(mut child) = child.lock() {
        let _ = child.kill_and_wait();
    }
}

fn model_probe_worker_error(code: &str) -> &'static str {
    match code {
        "SPEECH_NATIVE_RUNTIME_UNAVAILABLE" => "SPEECH_NATIVE_RUNTIME_UNAVAILABLE",
        "SPEECH_MODEL_PACK_UNAVAILABLE" => "SPEECH_MODEL_PACK_UNAVAILABLE",
        "SPEECH_ASR_MODEL_LOAD_FAILED" => "SPEECH_ASR_MODEL_LOAD_FAILED",
        "SPEECH_VAD_MODEL_LOAD_FAILED" => "SPEECH_VAD_MODEL_LOAD_FAILED",
        "SPEECH_DIARIZATION_MODEL_LOAD_FAILED" => "SPEECH_DIARIZATION_MODEL_LOAD_FAILED",
        "SPEECH_MODEL_LOAD_FAILED" => "SPEECH_MODEL_LOAD_FAILED",
        "SPEECH_RESOURCE_LIMIT" => "SPEECH_RESOURCE_LIMIT",
        _ => "SPEECH_WORKER_PROTOCOL_ERROR",
    }
}

fn drain_probe_stderr(stderr: std::process::ChildStderr) {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr
            .take(MAX_PROBE_STDERR_BYTES.saturating_add(1))
            .read_to_end(&mut bytes);
        if !bytes.is_empty() {
            crate::ulog_warn!(
                "[speech-resource] model probe stderr bytes={}",
                bytes.len().min(MAX_PROBE_STDERR_BYTES as usize)
            );
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_plan_has_exact_public_download_budget() {
        let plan = install_plan().unwrap();
        assert_eq!(plan.source_download_bytes, 209_767_948);
        assert_eq!(total_download_bytes(&plan), 209_785_686);
        assert!(total_download_bytes(&plan) <= plan.download_hard_limit_bytes);
    }

    #[test]
    fn model_probe_preserves_known_worker_failures_and_rejects_unknown_codes() {
        assert_eq!(
            model_probe_worker_error("SPEECH_MODEL_PACK_UNAVAILABLE"),
            "SPEECH_MODEL_PACK_UNAVAILABLE"
        );
        assert_eq!(
            model_probe_worker_error("SPEECH_DIARIZATION_MODEL_LOAD_FAILED"),
            "SPEECH_DIARIZATION_MODEL_LOAD_FAILED"
        );
        assert_eq!(
            model_probe_worker_error("UNTRUSTED_WORKER_DETAIL"),
            "SPEECH_WORKER_PROTOCOL_ERROR"
        );
    }

    #[test]
    fn release_manifest_url_uses_pack_revision_without_schema_suffix() {
        assert_eq!(
            release_manifest_url("local-standard-speech-v2"),
            "https://download.myagents.io/models/speech/sets/local-standard-speech-v2/manifest.json"
        );
    }

    #[test]
    fn model_resource_response_only_accepts_first_party_https() {
        assert!(validate_model_resource_response(
            &reqwest::Url::parse("https://download.myagents.io/models/speech/assets/file").unwrap()
        )
        .is_ok());
        assert!(validate_model_resource_response(
            &reqwest::Url::parse("https://github.com/example/file").unwrap()
        )
        .is_err());
        assert!(validate_model_resource_response(
            &reqwest::Url::parse("http://download.myagents.io/models/speech/assets/file").unwrap()
        )
        .is_err());
    }

    #[tokio::test]
    async fn speech_model_http_client_never_follows_redirects() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tauri::async_runtime::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).await.unwrap();
            let response = format!(
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://{address}/leak\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            tokio::time::timeout(Duration::from_millis(250), listener.accept())
                .await
                .is_ok()
        });

        let client = speech_model_http_client_builder()
            .no_proxy()
            .build()
            .unwrap();
        let response = client
            .get(format!("http://{address}/manifest.json"))
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), reqwest::StatusCode::TEMPORARY_REDIRECT);
        assert!(
            !server.await.unwrap(),
            "redirect target received a second request"
        );
    }

    #[test]
    fn status_projects_install_stages_update_and_error() {
        let root = tempfile::tempdir().unwrap();
        let manager = SpeechModelPackManager::initialize(
            root.path().join("models"),
            root.path().join("worker"),
            root.path().join("native.json"),
            None,
            LocalComputeCoordinator::new(),
        )
        .unwrap();

        for (operation, expected) in [
            (Operation::Checking, SpeechModelPackStatusKind::Checking),
            (
                Operation::Downloading,
                SpeechModelPackStatusKind::Downloading,
            ),
            (Operation::Verifying, SpeechModelPackStatusKind::Verifying),
            (Operation::Installing, SpeechModelPackStatusKind::Installing),
            (Operation::Removing, SpeechModelPackStatusKind::Removing),
        ] {
            manager.state.lock().unwrap().operation = operation;
            assert_eq!(manager.status().status, expected);
        }

        {
            let mut state = manager.state.lock().unwrap();
            state.operation = Operation::Idle;
            state.active_pointer = Some(ActivePointer {
                schema_version: ACTIVE_POINTER_SCHEMA_VERSION,
                pack_revision: "previous-revision".into(),
                directory_name: "pack-0123456789abcdef0123456789abcdef".into(),
                manifest_sha256: "0".repeat(64),
                manifest_signature: "unused-after-initialization".into(),
                activated_at: chrono::Utc::now().to_rfc3339(),
            });
        }
        let update = manager.status();
        assert_eq!(update.status, SpeechModelPackStatusKind::UpdateAvailable);
        assert!(!update.usable);
        assert_eq!(update.active_revision.as_deref(), Some("previous-revision"));

        manager.state.lock().unwrap().last_error_code = Some("SPEECH_RESOURCE_NETWORK".into());
        assert_eq!(manager.status().status, SpeechModelPackStatusKind::Error);

        {
            let mut state = manager.state.lock().unwrap();
            state.active = Some(ActivatedModelPack {
                revision: manager.plan.pack_revision.clone(),
                manifest_path: root.path().join("models/active-manifest.json"),
            });
            state.last_error_code = Some("SPEECH_RESOURCE_REMOVE_FAILED".into());
        }
        let removal_error = manager.status();
        assert_eq!(removal_error.status, SpeechModelPackStatusKind::Error);
        assert!(removal_error.usable);
    }

    #[test]
    fn unsigned_previous_revision_is_error_not_update_available() {
        let root = tempfile::tempdir().unwrap();
        let models = root.path().join("models");
        let directory_name = "pack-0123456789abcdef0123456789abcdef";
        let pack_root = models.join("packs").join(directory_name);
        fs::create_dir_all(&pack_root).unwrap();
        let plan = install_plan().unwrap();
        let manifest = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": MODEL_PACK_MANIFEST_SCHEMA_VERSION,
            "packId": plan.pack_id,
            "packRevision": "previous-revision"
        }))
        .unwrap();
        fs::write(pack_root.join("manifest.json"), &manifest).unwrap();
        let pointer = ActivePointer {
            schema_version: ACTIVE_POINTER_SCHEMA_VERSION,
            pack_revision: "previous-revision".into(),
            directory_name: directory_name.into(),
            manifest_sha256: format!("{:x}", Sha256::digest(&manifest)),
            manifest_signature: "not-a-valid-signature".into(),
            activated_at: chrono::Utc::now().to_rfc3339(),
        };
        fs::write(
            models.join("active.json"),
            serde_json::to_vec(&pointer).unwrap(),
        )
        .unwrap();

        let manager = SpeechModelPackManager::initialize(
            models,
            root.path().join("worker"),
            root.path().join("native.json"),
            None,
            LocalComputeCoordinator::new(),
        )
        .unwrap();
        let status = manager.status();
        assert_eq!(status.status, SpeechModelPackStatusKind::Error);
        assert!(!status.usable);
        assert_eq!(
            status.last_error_code.as_deref(),
            Some("SPEECH_RESOURCE_CORRUPT")
        );
    }

    #[test]
    fn cleanup_only_removes_plain_owned_operation_directories() {
        let root = tempfile::tempdir().unwrap();
        let private = root.path().join("private");
        fs::create_dir(&private).unwrap();
        fs::create_dir(private.join(".download-owned")).unwrap();
        fs::write(private.join(".download-file"), b"keep").unwrap();
        fs::create_dir(private.join("user-data")).unwrap();
        cleanup_abandoned_operation_dirs(&private).unwrap();
        assert!(!private.join(".download-owned").exists());
        assert!(private.join(".download-file").exists());
        assert!(private.join("user-data").exists());
    }

    #[test]
    fn pointer_directory_name_is_exact_and_not_a_path() {
        assert!(valid_pack_directory_name(
            "pack-0123456789abcdef0123456789abcdef"
        ));
        for invalid in [
            "pack-../0123456789abcdef0123456789abcdef",
            "pack-0123",
            "other-0123456789abcdef0123456789abcdef",
        ] {
            assert!(!valid_pack_directory_name(invalid));
        }
    }

    #[test]
    fn corrupt_pack_removal_is_busy_guarded_and_exact() {
        let root = tempfile::tempdir().unwrap();
        let models = root.path().join("models");
        fs::create_dir_all(models.join("packs/pack-0123456789abcdef0123456789abcdef")).unwrap();
        fs::create_dir(models.join("packs/user-data")).unwrap();
        fs::write(models.join("active.json"), b"corrupt pointer").unwrap();
        let manager = SpeechModelPackManager::initialize(
            models.clone(),
            root.path().join("worker"),
            root.path().join("native.json"),
            None,
            LocalComputeCoordinator::new(),
        )
        .unwrap();
        assert_eq!(manager.remove(true), Err("SPEECH_RESOURCE_BUSY".into()));
        assert!(models.join("active.json").exists());

        let status = manager.remove(false).unwrap();
        assert_eq!(status.status, SpeechModelPackStatusKind::NotInstalled);
        assert!(!models.join("active.json").exists());
        assert!(!models
            .join("packs/pack-0123456789abcdef0123456789abcdef")
            .exists());
        assert!(models.join("packs/user-data").exists());
    }

    #[test]
    fn valid_tar_materializes_only_the_locked_file() {
        let root = tempfile::tempdir().unwrap();
        let plan = tiny_plan();
        let selected = &plan.assets[0].selected_files[0];
        let requested = HashMap::from([(
            selected.source_path.clone(),
            (
                selected.install_path.clone(),
                selected.size,
                selected.sha256.clone(),
            ),
        )]);
        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            append_tar_directory(&mut builder, "bundle/");
            append_tar_file(&mut builder, "ignored.txt", b"ignored");
            append_tar_file(&mut builder, "model.bin", b"model");
            builder.finish().unwrap();
        }
        materialize_tar_reader(
            std::io::Cursor::new(tar_bytes),
            requested,
            &root.path().join("staging"),
        )
        .unwrap();
        assert_eq!(
            fs::read(root.path().join("staging/models/model.bin")).unwrap(),
            b"model"
        );
        assert!(!root.path().join("staging/ignored.txt").exists());
    }

    #[test]
    fn archive_path_normalization_only_accepts_a_directory_separator() {
        assert_eq!(
            normalized_archive_entry_path("bundle/", true),
            Some("bundle")
        );
        assert_eq!(
            normalized_archive_entry_path("bundle/model.bin", false),
            Some("bundle/model.bin")
        );
        for (path, is_directory) in [
            ("bundle/", false),
            ("bundle//", true),
            ("./", true),
            ("../", true),
            ("/bundle/", true),
            ("C:/bundle/", true),
            ("C:/bundle/model.bin", false),
        ] {
            assert_eq!(normalized_archive_entry_path(path, is_directory), None);
        }
    }

    #[test]
    fn archive_materializer_rejects_traversal_special_and_duplicate_entries() {
        for fixture in [
            ArchiveFixture::Traversal,
            ArchiveFixture::Symlink,
            ArchiveFixture::Duplicate,
        ] {
            let root = tempfile::tempdir().unwrap();
            let plan = tiny_plan();
            let selected = &plan.assets[0].selected_files[0];
            let requested = HashMap::from([(
                selected.source_path.clone(),
                (
                    selected.install_path.clone(),
                    selected.size,
                    selected.sha256.clone(),
                ),
            )]);
            let result = materialize_tar_reader(
                std::io::Cursor::new(archive_fixture(fixture)),
                requested,
                &root.path().join("staging"),
            );
            assert_eq!(result, Err("SPEECH_RESOURCE_ARCHIVE_INVALID"));
        }
    }

    #[derive(Clone, Copy)]
    enum ArchiveFixture {
        Traversal,
        Symlink,
        Duplicate,
    }

    fn tiny_plan() -> ModelPackInstallPlan {
        ModelPackInstallPlan {
            pack_id: "fixture".into(),
            pack_revision: "fixture-v1".into(),
            source_download_bytes: 1,
            installed_model_bytes: 5,
            download_hard_limit_bytes: 1024,
            assets: vec![ModelPackAsset {
                id: "archive".into(),
                url: "https://download.myagents.io/models/speech/assets/fixture".into(),
                sha256: "0".repeat(64),
                size: 1,
                format: ModelPackAssetFormat::TarBz2,
                selected_files: vec![crate::speech_model_pack::ModelPackSelectedFile {
                    source_path: "model.bin".into(),
                    install_path: "models/model.bin".into(),
                    sha256: format!("{:x}", Sha256::digest(b"model")),
                    size: 5,
                }],
            }],
            legal_artifacts: Vec::new(),
        }
    }

    fn archive_fixture(fixture: ArchiveFixture) -> Vec<u8> {
        let mut tar_bytes = Vec::new();
        {
            let mut builder = tar::Builder::new(&mut tar_bytes);
            append_tar_file(&mut builder, "model.bin", b"model");
            match fixture {
                ArchiveFixture::Traversal => {
                    append_unsafe_tar_file(&mut builder, b"../escape", b"x")
                }
                ArchiveFixture::Symlink => {
                    let mut header = tar::Header::new_gnu();
                    header.set_entry_type(tar::EntryType::Symlink);
                    header.set_size(0);
                    header.set_mode(0o777);
                    header.set_cksum();
                    builder
                        .append_link(&mut header, "link", "model.bin")
                        .unwrap();
                }
                ArchiveFixture::Duplicate => append_tar_file(&mut builder, "model.bin", b"model"),
            }
            builder.finish().unwrap();
        }
        tar_bytes
    }

    fn append_tar_file(builder: &mut tar::Builder<&mut Vec<u8>>, path: &str, bytes: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o600);
        header.set_cksum();
        builder.append_data(&mut header, path, bytes).unwrap();
    }

    fn append_tar_directory(builder: &mut tar::Builder<&mut Vec<u8>>, path: &str) {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        header.set_mode(0o700);
        header.set_cksum();
        builder
            .append_data(&mut header, path, std::io::empty())
            .unwrap();
    }

    fn append_unsafe_tar_file(builder: &mut tar::Builder<&mut Vec<u8>>, path: &[u8], bytes: &[u8]) {
        let mut header = tar::Header::new_gnu();
        header.as_mut_bytes()[..path.len()].copy_from_slice(path);
        header.set_size(bytes.len() as u64);
        header.set_mode(0o600);
        header.set_cksum();
        builder.append(&header, bytes).unwrap();
    }
}
