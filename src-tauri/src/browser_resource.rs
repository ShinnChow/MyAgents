use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

use chrono::Utc;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use uuid::Uuid;
use zip::ZipArchive;

use crate::managed_codex::ManagedCodexArtifactSigning;
use crate::ulog_warn;
use crate::utils::file_lock::{with_file_lock_blocking, FileLockError, FileLockOptions};

pub const REQUIRED_RUNTIME_SET: &str = env!("MYAGENTS_BROWSER_RUNTIME_SET");
pub const REQUIRED_CHROMIUM_REVISION: &str = env!("MYAGENTS_BROWSER_REVISION");
const REQUIRED_CHROMIUM_BROWSER_VERSION: &str = env!("MYAGENTS_BROWSER_VERSION");
const REQUIRED_PLAYWRIGHT_MCP_VERSION: &str = env!("MYAGENTS_BROWSER_PLAYWRIGHT_MCP_VERSION");
const REQUIRED_PLAYWRIGHT_CORE_VERSION: &str = env!("MYAGENTS_BROWSER_PLAYWRIGHT_CORE_VERSION");

const RUNTIME_SETS_BASE_URL: &str = "https://download.myagents.io/runtimes/browser/sets";
const DOWNLOAD_HOST: &str = "download.myagents.io";
const DOWNLOAD_PATH_PREFIX: &str = "/runtimes/browser/";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 16 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 6000;
const AUTOMATIC_RETRY_LIMIT: u8 = 2;
const DOWNLOAD_REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

static STATUS: OnceLock<Mutex<BrowserResourceStatus>> = OnceLock::new();
static STATUS_REVISION: AtomicU64 = AtomicU64::new(1);
static AUTOMATIC_RETRY_COUNT: AtomicU8 = AtomicU8::new(0);
static MANIFEST_PROBE_ACTIVE: AtomicBool = AtomicBool::new(false);
static OPERATION_COORDINATOR: OnceLock<BrowserResourceOperationCoordinator> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserResourceStatus {
    pub platform: Option<String>,
    pub required_revision: String,
    pub installed_revision: Option<String>,
    pub install_authorized: bool,
    pub state: String,
    pub operation_id: Option<String>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub progress_percent: Option<u8>,
    pub error_code: Option<String>,
    pub retryable: bool,
    pub automatic_retry_count: u8,
    pub status_revision: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserResourceResolution {
    pub executable_path: String,
    pub revision: String,
}

#[derive(Default)]
struct BrowserResourceOperationState {
    active: bool,
    generation: u64,
    waiters: usize,
    terminal: Option<Result<BrowserResourceStatus, String>>,
}

#[derive(Default)]
struct BrowserResourceOperationCoordinator {
    state: Mutex<BrowserResourceOperationState>,
    changed: Condvar,
}

impl BrowserResourceOperationCoordinator {
    fn run<F>(&self, operation: F) -> Result<BrowserResourceStatus, String>
    where
        F: FnOnce() -> Result<BrowserResourceStatus, String>,
    {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "BROWSER_RESOURCE_INSTALL_FAILED".to_string())?;
        loop {
            if state.active {
                let generation = state.generation;
                state.waiters += 1;
                while state.active && state.generation == generation {
                    state = self
                        .changed
                        .wait(state)
                        .map_err(|_| "BROWSER_RESOURCE_INSTALL_FAILED".to_string())?;
                }
                let terminal = state
                    .terminal
                    .clone()
                    .unwrap_or_else(|| Err("BROWSER_RESOURCE_INSTALL_FAILED".to_string()));
                state.waiters = state.waiters.saturating_sub(1);
                if state.waiters == 0 {
                    self.changed.notify_all();
                }
                return terminal;
            }
            if state.waiters > 0 {
                state = self
                    .changed
                    .wait(state)
                    .map_err(|_| "BROWSER_RESOURCE_INSTALL_FAILED".to_string())?;
                continue;
            }
            state.active = true;
            state.generation = state.generation.wrapping_add(1);
            state.terminal = None;
            break;
        }
        drop(state);

        let result = operation();
        if let Ok(mut state) = self.state.lock() {
            state.active = false;
            state.terminal = Some(result.clone());
            self.changed.notify_all();
        }
        result
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledBrowserRuntime {
    schema_version: u32,
    runtime_set: String,
    chromium_revision: String,
    platform: String,
    executable_relative_path: String,
    sha256: String,
    manifest_signature: String,
    artifact_signature_verified: bool,
    installed_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserRuntimeManifest {
    schema_version: u32,
    runtime_set: String,
    revision: String,
    playwright_mcp_version: String,
    playwright_core_version: String,
    chromium_revision: String,
    chromium_browser_version: String,
    platform: String,
    generated_at: String,
    licenses: Vec<String>,
    artifact: BrowserRuntimeArtifact,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserRuntimeArtifact {
    url: String,
    sha256: String,
    signature: String,
    #[serde(default)]
    signing: Option<ManagedCodexArtifactSigning>,
    executable_relative_path: String,
    file_allowlist: Vec<String>,
    archive_size_bytes: u64,
    unpacked_size_bytes: u64,
    entry_count: u64,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn platform_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("windows", "x86_64") => Some("win32-x64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        _ => None,
    }
}

fn runtime_root() -> Result<PathBuf, String> {
    crate::app_dirs::myagents_data_dir()
        .map(|path| path.join("runtimes").join("browser"))
        .ok_or_else(|| "[browser-resource] Cannot determine MyAgents data directory".to_string())
}

fn installed_json_path() -> Result<PathBuf, String> {
    Ok(runtime_root()?.join("installed.json"))
}

fn install_dir(platform: &str) -> Result<PathBuf, String> {
    Ok(runtime_root()?.join(REQUIRED_RUNTIME_SET).join(platform))
}

fn manifest_url(platform: &str) -> String {
    format!(
        "{}/{}/{}/manifest-v1.json",
        RUNTIME_SETS_BASE_URL, REQUIRED_RUNTIME_SET, platform
    )
}

fn manifest_signature_url(platform: &str) -> String {
    format!("{}.sig", manifest_url(platform))
}

fn validate_download_url(raw: &str) -> Result<(), String> {
    let url = url::Url::parse(raw)
        .map_err(|error| format!("[browser-resource] Invalid download URL: {error}"))?;
    if url.scheme() != "https"
        || url.host_str() != Some(DOWNLOAD_HOST)
        || url.port().is_some()
        || !url.path().starts_with(DOWNLOAD_PATH_PREFIX)
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "[browser-resource] Download URL is outside the first-party runtime origin".to_string(),
        );
    }
    Ok(())
}

fn validate_relative_path(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.contains('\\') || raw.contains('\0') {
        return Err("[browser-resource] Runtime archive contains an invalid path".to_string());
    }
    let path = Path::new(raw);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("[browser-resource] Runtime archive path escapes its root".to_string());
    }
    Ok(path.to_path_buf())
}

fn read_installed() -> Option<InstalledBrowserRuntime> {
    let bytes = fs::read(installed_json_path().ok()?).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn installed_runtime(
    metadata: &InstalledBrowserRuntime,
    platform: &str,
) -> Option<BrowserResourceResolution> {
    if metadata.schema_version != 1
        || metadata.runtime_set != REQUIRED_RUNTIME_SET
        || metadata.chromium_revision != REQUIRED_CHROMIUM_REVISION
        || metadata.platform != platform
        || metadata.sha256.len() != 64
        || metadata.manifest_signature.trim().is_empty()
        || !metadata.artifact_signature_verified
    {
        return None;
    }
    let root = install_dir(platform).ok()?;
    let executable = root.join(validate_relative_path(&metadata.executable_relative_path).ok()?);
    if !executable.is_file() {
        return None;
    }
    let canonical_root = fs::canonicalize(root).ok()?;
    let canonical_executable = fs::canonicalize(executable).ok()?;
    if !canonical_executable.starts_with(&canonical_root) {
        return None;
    }
    Some(BrowserResourceResolution {
        executable_path: canonical_executable.to_string_lossy().into_owned(),
        revision: REQUIRED_RUNTIME_SET.to_string(),
    })
}

fn has_install_authorization(metadata: &InstalledBrowserRuntime, platform: &str) -> bool {
    metadata.schema_version == 1
        && metadata.platform == platform
        && metadata.sha256.len() == 64
        && metadata.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        && !metadata.manifest_signature.trim().is_empty()
        && metadata.artifact_signature_verified
        && validate_relative_path(&metadata.executable_relative_path).is_ok()
}

fn initial_status() -> BrowserResourceStatus {
    let platform = platform_key().map(str::to_string);
    let installed = read_installed();
    let install_authorized = platform
        .as_deref()
        .zip(installed.as_ref())
        .is_some_and(|(platform, metadata)| has_install_authorization(metadata, platform));
    let installed_revision = installed
        .as_ref()
        .map(|metadata| metadata.runtime_set.clone());
    let state = match platform.as_deref() {
        None => "unsupported",
        Some(platform)
            if installed
                .as_ref()
                .and_then(|metadata| installed_runtime(metadata, platform))
                .is_some() =>
        {
            "ready"
        }
        Some(_) if install_authorized => "checking",
        Some(_) => "never_installed",
    };
    BrowserResourceStatus {
        platform,
        required_revision: REQUIRED_RUNTIME_SET.to_string(),
        installed_revision,
        install_authorized,
        state: state.to_string(),
        operation_id: None,
        downloaded_bytes: None,
        total_bytes: None,
        progress_percent: None,
        error_code: None,
        retryable: state != "unsupported" && state != "ready",
        automatic_retry_count: AUTOMATIC_RETRY_COUNT.load(Ordering::Relaxed),
        status_revision: STATUS_REVISION.load(Ordering::Relaxed),
        updated_at: now_iso(),
    }
}

fn status_cell() -> &'static Mutex<BrowserResourceStatus> {
    STATUS.get_or_init(|| Mutex::new(initial_status()))
}

fn current_status() -> BrowserResourceStatus {
    status_cell()
        .lock()
        .map(|status| status.clone())
        .unwrap_or_else(|_| initial_status())
}

fn publish_status(mut status: BrowserResourceStatus) -> BrowserResourceStatus {
    status.status_revision = STATUS_REVISION.fetch_add(1, Ordering::Relaxed) + 1;
    status.updated_at = now_iso();
    status.automatic_retry_count = AUTOMATIC_RETRY_COUNT.load(Ordering::Relaxed);
    if let Ok(mut current) = status_cell().lock() {
        *current = status.clone();
    }
    if let Some(app) = crate::logger::get_app_handle() {
        let _ = app.emit("browser-resource-status", &status);
    }
    status
}

fn transition(
    state: &str,
    operation_id: Option<&str>,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    progress_percent: Option<u8>,
    error_code: Option<&str>,
) -> BrowserResourceStatus {
    let mut next = current_status();
    next.state = state.to_string();
    next.operation_id = operation_id.map(str::to_string);
    next.downloaded_bytes = downloaded_bytes;
    next.total_bytes = total_bytes;
    next.progress_percent = progress_percent;
    next.error_code = error_code.map(str::to_string);
    next.retryable = matches!(
        state,
        "never_installed" | "install_failed" | "update_failed"
    );
    publish_status(next)
}

fn http_client(timeout: Duration, use_proxy: bool) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .timeout(timeout);
    if use_proxy {
        crate::proxy_config::build_client_with_proxy(builder)
            .map_err(|error| format!("[browser-resource] Failed to build HTTP client: {error}"))
    } else {
        builder
            .no_proxy()
            .build()
            .map_err(|error| format!("[browser-resource] Failed to build direct client: {error}"))
    }
}

fn should_retry_direct(error: &str) -> bool {
    let normalized = error.to_ascii_lowercase();
    normalized.contains("failed to build http client")
        || normalized.contains("failed to fetch")
        || normalized.contains("failed to read")
        || normalized.contains("artifact download failed")
        || normalized.contains("artifact stream failed")
        || normalized.contains("timed out")
}

async fn fetch_limited(
    client: &reqwest::Client,
    url: &str,
    limit: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    validate_download_url(url)?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("[browser-resource] Failed to fetch {label}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "[browser-resource] Failed to fetch {label}: HTTP {}",
            response.status()
        ));
    }
    validate_download_url(response.url().as_str())?;
    if response.content_length().unwrap_or(0) > limit {
        return Err(format!("[browser-resource] {label} exceeds its size limit"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("[browser-resource] Failed to read {label}: {error}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("[browser-resource] {label} exceeds its size limit"));
    }
    Ok(bytes.to_vec())
}

async fn fetch_manifest(
    client: &reqwest::Client,
    platform: &str,
) -> Result<(BrowserRuntimeManifest, String), String> {
    let manifest_bytes = fetch_limited(
        client,
        &manifest_url(platform),
        MAX_MANIFEST_BYTES,
        "manifest",
    )
    .await?;
    let signature_bytes = fetch_limited(
        client,
        &manifest_signature_url(platform),
        MAX_SIGNATURE_BYTES,
        "manifest signature",
    )
    .await?;
    let signature = String::from_utf8(signature_bytes)
        .map_err(|_| "[browser-resource] Manifest signature is not UTF-8".to_string())?;
    let signature = signature.trim();
    crate::managed_codex::verify_minisign_bytes(&manifest_bytes, signature, "Browser manifest")?;
    let manifest: BrowserRuntimeManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("[browser-resource] Invalid manifest JSON: {error}"))?;
    validate_manifest(&manifest, platform)?;
    Ok((manifest, signature.to_string()))
}

async fn fetch_manifest_with_fallback(
    platform: &str,
) -> Result<(BrowserRuntimeManifest, String), String> {
    let proxied = async {
        let client = http_client(DOWNLOAD_REQUEST_TIMEOUT, true)?;
        fetch_manifest(&client, platform).await
    }
    .await;
    match proxied {
        Ok(result) => Ok(result),
        Err(error) if should_retry_direct(&error) => {
            ulog_warn!("[browser-resource] transport=proxy fallback=direct resource=manifest");
            let client = http_client(DOWNLOAD_REQUEST_TIMEOUT, false)?;
            fetch_manifest(&client, platform).await
        }
        Err(error) => Err(error),
    }
}

fn validate_manifest(manifest: &BrowserRuntimeManifest, platform: &str) -> Result<(), String> {
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION
        || manifest.runtime_set != REQUIRED_RUNTIME_SET
        || manifest.revision != REQUIRED_RUNTIME_SET
        || manifest.playwright_mcp_version != REQUIRED_PLAYWRIGHT_MCP_VERSION
        || manifest.playwright_core_version != REQUIRED_PLAYWRIGHT_CORE_VERSION
        || manifest.chromium_revision != REQUIRED_CHROMIUM_REVISION
        || manifest.chromium_browser_version != REQUIRED_CHROMIUM_BROWSER_VERSION
        || manifest.platform != platform
        || manifest.generated_at.trim().is_empty()
        || manifest.licenses.is_empty()
        || manifest
            .licenses
            .iter()
            .any(|license| license.trim().is_empty())
    {
        return Err(
            "[browser-resource] Manifest does not match this app's locked Browser runtime"
                .to_string(),
        );
    }
    validate_artifact(&manifest.artifact, platform)?;
    for license in &manifest.licenses {
        validate_relative_path(license)?;
        if !manifest.artifact.file_allowlist.contains(license) {
            return Err("[browser-resource] Browser license notice is not allowlisted".to_string());
        }
    }
    Ok(())
}

fn validate_artifact(artifact: &BrowserRuntimeArtifact, platform: &str) -> Result<(), String> {
    validate_download_url(&artifact.url)?;
    if artifact.sha256.len() != 64 || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("[browser-resource] Artifact SHA-256 is invalid".to_string());
    }
    if artifact.signature.trim().is_empty()
        || artifact.archive_size_bytes == 0
        || artifact.archive_size_bytes > MAX_ARCHIVE_BYTES
        || artifact.unpacked_size_bytes == 0
        || artifact.unpacked_size_bytes > MAX_UNPACKED_BYTES
        || artifact.entry_count == 0
        || artifact.entry_count as usize > MAX_ARCHIVE_ENTRIES
    {
        return Err("[browser-resource] Artifact metadata is outside allowed bounds".to_string());
    }
    if artifact.file_allowlist.is_empty() || artifact.file_allowlist.len() > MAX_ARCHIVE_ENTRIES {
        return Err("[browser-resource] Artifact file allowlist is invalid".to_string());
    }
    if artifact.file_allowlist.iter().collect::<HashSet<_>>().len() != artifact.file_allowlist.len()
    {
        return Err("[browser-resource] Artifact allowlist contains duplicates".to_string());
    }
    for path in artifact
        .file_allowlist
        .iter()
        .chain([&artifact.executable_relative_path])
    {
        validate_relative_path(path)?;
    }
    if !artifact
        .file_allowlist
        .contains(&artifact.executable_relative_path)
    {
        return Err("[browser-resource] Required Browser component is not allowlisted".to_string());
    }
    if matches!(platform, "darwin-arm64" | "darwin-x64" | "win32-x64") && artifact.signing.is_none()
    {
        return Err("[browser-resource] Platform signing policy is required".to_string());
    }
    Ok(())
}

async fn download_artifact(
    client: &reqwest::Client,
    artifact: &BrowserRuntimeArtifact,
    archive_path: &Path,
    operation_id: &str,
    progress_state: &str,
) -> Result<(), String> {
    let response = client
        .get(&artifact.url)
        .send()
        .await
        .map_err(|error| format!("[browser-resource] Artifact download failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "[browser-resource] Artifact download failed: HTTP {}",
            response.status()
        ));
    }
    validate_download_url(response.url().as_str())?;
    if let Some(length) = response.content_length() {
        if length != artifact.archive_size_bytes || length > MAX_ARCHIVE_BYTES {
            return Err("[browser-resource] Artifact Content-Length mismatch".to_string());
        }
    }
    let mut file = File::create(archive_path).map_err(|error| {
        format!("[browser-resource] Failed to create archive staging file: {error}")
    })?;
    let mut stream = response.bytes_stream();
    let mut downloaded = 0u64;
    let mut last_percent = 0u8;
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("[browser-resource] Artifact stream failed: {error}"))?;
        downloaded = downloaded
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| "[browser-resource] Artifact size overflow".to_string())?;
        if downloaded > artifact.archive_size_bytes || downloaded > MAX_ARCHIVE_BYTES {
            return Err("[browser-resource] Artifact exceeded declared size".to_string());
        }
        file.write_all(&chunk)
            .map_err(|error| format!("[browser-resource] Failed to write artifact: {error}"))?;
        let percent = ((downloaded.saturating_mul(100)) / artifact.archive_size_bytes) as u8;
        if percent != last_percent {
            last_percent = percent;
            transition(
                progress_state,
                Some(operation_id),
                Some(downloaded),
                Some(artifact.archive_size_bytes),
                Some(percent),
                None,
            );
        }
    }
    file.sync_all()
        .map_err(|error| format!("[browser-resource] Failed to flush artifact: {error}"))?;
    if downloaded != artifact.archive_size_bytes {
        return Err("[browser-resource] Artifact size mismatch".to_string());
    }
    Ok(())
}

async fn download_artifact_with_fallback(
    artifact: &BrowserRuntimeArtifact,
    archive_path: &Path,
    operation_id: &str,
    progress_state: &str,
) -> Result<(), String> {
    let proxied = async {
        let client = http_client(DOWNLOAD_REQUEST_TIMEOUT, true)?;
        download_artifact(
            &client,
            artifact,
            archive_path,
            operation_id,
            progress_state,
        )
        .await
    }
    .await;
    match proxied {
        Ok(()) => Ok(()),
        Err(error) if should_retry_direct(&error) => {
            ulog_warn!("[browser-resource] transport=proxy fallback=direct resource=artifact");
            let client = http_client(DOWNLOAD_REQUEST_TIMEOUT, false)?;
            download_artifact(
                &client,
                artifact,
                archive_path,
                operation_id,
                progress_state,
            )
            .await
        }
        Err(error) => Err(error),
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("[browser-resource] Failed to open artifact: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("[browser-resource] Failed to hash artifact: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn declared_zip_entry_count(path: &Path) -> Result<usize, String> {
    const EOCD_MIN_SIZE: u64 = 22;
    const EOCD_MAX_SEARCH: u64 = EOCD_MIN_SIZE + u16::MAX as u64;
    let mut file = File::open(path)
        .map_err(|error| format!("[browser-resource] Failed to open artifact zip: {error}"))?;
    let file_size = file
        .metadata()
        .map_err(|error| format!("[browser-resource] Failed to inspect artifact zip: {error}"))?
        .len();
    if file_size < EOCD_MIN_SIZE {
        return Err("[browser-resource] Invalid artifact zip footer".to_string());
    }
    let tail_size = file_size.min(EOCD_MAX_SEARCH);
    file.seek(SeekFrom::Start(file_size - tail_size))
        .map_err(|error| format!("[browser-resource] Failed to seek artifact zip: {error}"))?;
    let mut tail = vec![0u8; tail_size as usize];
    file.read_exact(&mut tail)
        .map_err(|error| format!("[browser-resource] Failed to read artifact zip: {error}"))?;

    for index in (0..=tail.len() - EOCD_MIN_SIZE as usize).rev() {
        if tail[index..index + 4] != [0x50, 0x4b, 0x05, 0x06] {
            continue;
        }
        let u16_at =
            |offset: usize| u16::from_le_bytes([tail[index + offset], tail[index + offset + 1]]);
        let comment_size = usize::from(u16_at(20));
        if index + EOCD_MIN_SIZE as usize + comment_size != tail.len() {
            continue;
        }
        let disk_number = u16_at(4);
        let central_disk = u16_at(6);
        let entries_on_disk = u16_at(8);
        let total_entries = u16_at(10);
        if disk_number != 0 || central_disk != 0 || entries_on_disk != total_entries {
            return Err("[browser-resource] Multi-disk Browser archives are forbidden".to_string());
        }
        if total_entries == u16::MAX {
            return Err("[browser-resource] ZIP64 Browser archives are forbidden".to_string());
        }
        return Ok(usize::from(total_entries));
    }
    Err("[browser-resource] Invalid artifact zip footer".to_string())
}

fn extract_archive(
    archive_path: &Path,
    staging: &Path,
    artifact: &BrowserRuntimeArtifact,
) -> Result<(), String> {
    let archive_file = File::open(archive_path)
        .map_err(|error| format!("[browser-resource] Failed to open artifact zip: {error}"))?;
    let mut archive = ZipArchive::new(archive_file)
        .map_err(|error| format!("[browser-resource] Invalid artifact zip: {error}"))?;
    let declared_entries = declared_zip_entry_count(archive_path)?;
    if declared_entries != archive.len() {
        return Err("[browser-resource] Artifact contains duplicate file entries".to_string());
    }
    if declared_entries != artifact.entry_count as usize || archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("[browser-resource] Artifact entry count mismatch".to_string());
    }
    let allowlist = artifact
        .file_allowlist
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    if allowlist.len() != artifact.file_allowlist.len() {
        return Err("[browser-resource] Artifact allowlist contains duplicates".to_string());
    }
    fs::create_dir_all(staging).map_err(|error| {
        format!("[browser-resource] Failed to create staging directory: {error}")
    })?;
    let mut unpacked = 0u64;
    let mut seen_files = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("[browser-resource] Failed to read zip entry: {error}"))?;
        let raw_name = entry.name().trim_end_matches('/');
        let relative = validate_relative_path(raw_name)?;
        let key = relative.to_string_lossy().replace('\\', "/");
        if entry.is_dir() {
            let prefix = format!("{key}/");
            if !allowlist.iter().any(|allowed| allowed.starts_with(&prefix)) {
                return Err("[browser-resource] Artifact directory is not allowlisted".to_string());
            }
        } else if !allowlist.contains(&key) {
            return Err(format!(
                "[browser-resource] Artifact file is not allowlisted: {key}"
            ));
        } else if !seen_files.insert(key.clone()) {
            return Err("[browser-resource] Artifact contains duplicate file entries".to_string());
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| (mode & 0o170000) == 0o120000)
        {
            return Err(
                "[browser-resource] Symlinks are forbidden in Browser resources".to_string(),
            );
        }
        unpacked = unpacked
            .checked_add(entry.size())
            .ok_or_else(|| "[browser-resource] Unpacked size overflow".to_string())?;
        if unpacked > artifact.unpacked_size_bytes || unpacked > MAX_UNPACKED_BYTES {
            return Err("[browser-resource] Artifact exceeded unpacked size".to_string());
        }
        let output = staging.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| {
                format!("[browser-resource] Failed to create extracted directory: {error}")
            })?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("[browser-resource] Failed to create extracted parent: {error}")
            })?;
        }
        let mut output_file = File::create(&output).map_err(|error| {
            format!("[browser-resource] Failed to create extracted file: {error}")
        })?;
        let copied = std::io::copy(&mut entry, &mut output_file)
            .map_err(|error| format!("[browser-resource] Failed to extract file: {error}"))?;
        if copied != entry.size() {
            return Err("[browser-resource] Extracted file size mismatch".to_string());
        }
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&output, fs::Permissions::from_mode(mode & 0o777)).map_err(
                |error| format!("[browser-resource] Failed to set permissions: {error}"),
            )?;
        }
    }
    if unpacked != artifact.unpacked_size_bytes {
        return Err("[browser-resource] Artifact unpacked size mismatch".to_string());
    }
    if seen_files != allowlist {
        return Err("[browser-resource] Artifact is missing allowlisted files".to_string());
    }
    Ok(())
}

fn atomic_write_installed(metadata: &InstalledBrowserRuntime) -> Result<(), String> {
    let path = installed_json_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "[browser-resource] Invalid metadata path".to_string())?;
    fs::create_dir_all(parent).map_err(|error| {
        format!("[browser-resource] Failed to create metadata directory: {error}")
    })?;
    let temp = parent.join(format!("installed.{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(metadata)
        .map_err(|error| format!("[browser-resource] Failed to encode metadata: {error}"))?;
    let mut file = File::create(&temp)
        .map_err(|error| format!("[browser-resource] Failed to create metadata: {error}"))?;
    if let Err(error) = file.write_all(&bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&temp);
        return Err(format!(
            "[browser-resource] Failed to write metadata: {error}"
        ));
    }
    drop(file);
    if let Err(error) = fs::rename(&temp, &path) {
        let _ = fs::remove_file(&temp);
        return Err(format!(
            "[browser-resource] Failed to publish metadata: {error}"
        ));
    }
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            format!("[browser-resource] Failed to sync metadata directory: {error}")
        })?;
    Ok(())
}

fn ensure_free_space(path: &Path, required: u64) -> Result<(), String> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let disk = disks
        .list()
        .iter()
        .filter(|disk| path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count())
        .ok_or_else(|| "[browser-resource] Free disk space is unavailable".to_string())?;
    if disk.available_space() < required {
        return Err("[browser-resource] Insufficient disk space".to_string());
    }
    Ok(())
}

fn failure_projection(error: &str, updating: bool) -> (&'static str, bool) {
    if updating {
        return ("BROWSER_RESOURCE_UPDATE_FAILED", true);
    }
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("insufficient disk space") {
        ("BROWSER_RESOURCE_DISK_FULL", true)
    } else if normalized.contains("failed to fetch")
        || normalized.contains("failed to build direct client")
        || normalized.contains("download failed")
        || normalized.contains("artifact stream failed")
        || normalized.contains("timed out")
    {
        ("BROWSER_RESOURCE_DOWNLOAD_FAILED", true)
    } else if normalized.contains("manifest")
        || normalized.contains("artifact")
        || normalized.contains("archive")
        || normalized.contains("signature")
        || normalized.contains("sha-256")
        || normalized.contains("allowlist")
        || normalized.contains("symlink")
        || normalized.contains("download url")
        || normalized.contains("codesign")
        || normalized.contains("authenticode")
        || normalized.contains("team id")
        || normalized.contains("publisher")
        || normalized.contains("certificate")
        || normalized.contains("required browser component")
    {
        ("BROWSER_RESOURCE_VERIFY_FAILED", false)
    } else {
        ("BROWSER_RESOURCE_INSTALL_FAILED", true)
    }
}

fn publish_install(
    staging: &Path,
    platform: &str,
    manifest: &BrowserRuntimeManifest,
    manifest_signature: &str,
) -> Result<(), String> {
    let target = install_dir(platform)?;
    let backup = runtime_root()?.join(format!(".old-{}", Uuid::new_v4()));
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!("[browser-resource] Failed to create install parent: {error}")
        })?;
    }
    let had_target = target.exists();
    if had_target {
        fs::rename(&target, &backup).map_err(|error| {
            format!("[browser-resource] Failed to stage previous runtime: {error}")
        })?;
    }
    if let Err(error) = fs::rename(staging, &target) {
        if had_target {
            let _ = fs::rename(&backup, &target);
        }
        return Err(format!(
            "[browser-resource] Failed to publish runtime: {error}"
        ));
    }
    let metadata = InstalledBrowserRuntime {
        schema_version: 1,
        runtime_set: REQUIRED_RUNTIME_SET.to_string(),
        chromium_revision: REQUIRED_CHROMIUM_REVISION.to_string(),
        platform: platform.to_string(),
        executable_relative_path: manifest.artifact.executable_relative_path.clone(),
        sha256: manifest.artifact.sha256.to_ascii_lowercase(),
        manifest_signature: manifest_signature.to_string(),
        artifact_signature_verified: true,
        installed_at: now_iso(),
    };
    if let Err(error) = atomic_write_installed(&metadata) {
        let _ = fs::remove_dir_all(&target);
        if had_target {
            let _ = fs::rename(&backup, &target);
        }
        return Err(error);
    }
    if had_target {
        let _ = fs::remove_dir_all(&backup);
    }
    cleanup_obsolete_entries(&target)?;
    Ok(())
}

fn cleanup_obsolete_entries(current: &Path) -> Result<(), String> {
    let root = runtime_root()?;
    let current = current.to_path_buf();
    let Ok(entries) = fs::read_dir(&root) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == current || path == installed_json_path()? || path.ends_with("install.lock") {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(".staging-")
            || name.starts_with(".old-")
            || name.starts_with(".download-")
        {
            let _ = if path.is_dir() {
                fs::remove_dir_all(path)
            } else {
                fs::remove_file(path)
            };
            continue;
        }
        if path.is_dir() && path != current.parent().unwrap_or(&current) {
            let _ = fs::remove_dir_all(path);
        }
    }
    Ok(())
}

fn perform_install_owner(automatic: bool) -> Result<BrowserResourceStatus, String> {
    if resolve_browser_resource().is_ok() {
        return Ok(transition("ready", None, None, None, Some(100), None));
    }
    let platform = platform_key().ok_or_else(|| "BROWSER_RESOURCE_UNSUPPORTED".to_string())?;
    let root = runtime_root()?;
    fs::create_dir_all(&root)
        .map_err(|error| format!("[browser-resource] Failed to create runtime root: {error}"))?;
    let lock_path = root.join("install.lock");
    let runtime_handle = tokio::runtime::Handle::current();
    let operation_id = Uuid::new_v4().to_string();
    let existing = current_status();
    let operation_state = if existing.install_authorized {
        "updating"
    } else {
        "downloading"
    };
    transition(
        operation_state,
        Some(&operation_id),
        Some(0),
        None,
        Some(0),
        None,
    );
    let options = FileLockOptions {
        timeout: Duration::from_secs(30),
        stale: Duration::from_secs(5),
        poll: Duration::from_millis(100),
    };
    let result = with_file_lock_blocking(&lock_path, options, || {
        let (manifest, signature) = runtime_handle
            .block_on(fetch_manifest_with_fallback(platform))
            .map_err(|error| FileLockError::Io(std::io::Error::other(error)))?;
        transition(
            operation_state,
            Some(&operation_id),
            Some(0),
            Some(manifest.artifact.archive_size_bytes),
            Some(0),
            None,
        );
        ensure_free_space(
            &root,
            manifest
                .artifact
                .archive_size_bytes
                .saturating_add(manifest.artifact.unpacked_size_bytes),
        )
        .map_err(|error| FileLockError::Io(std::io::Error::other(error)))?;
        let archive_path = root.join(format!(".download-{operation_id}.zip"));
        let staging = root.join(format!(".staging-{operation_id}"));
        let install_result = (|| -> Result<(), String> {
            runtime_handle.block_on(download_artifact_with_fallback(
                &manifest.artifact,
                &archive_path,
                &operation_id,
                operation_state,
            ))?;
            transition(
                "verifying",
                Some(&operation_id),
                Some(manifest.artifact.archive_size_bytes),
                Some(manifest.artifact.archive_size_bytes),
                Some(100),
                None,
            );
            let digest = sha256_file(&archive_path)?;
            if !digest.eq_ignore_ascii_case(&manifest.artifact.sha256) {
                return Err("[browser-resource] Artifact SHA-256 mismatch".to_string());
            }
            crate::managed_codex::verify_minisign_file(
                &archive_path,
                &manifest.artifact.signature,
            )?;
            transition(
                "installing",
                Some(&operation_id),
                None,
                None,
                Some(100),
                None,
            );
            extract_archive(&archive_path, &staging, &manifest.artifact)?;
            let executable = staging.join(validate_relative_path(
                &manifest.artifact.executable_relative_path,
            )?);
            if let Some(signing) = manifest.artifact.signing.as_ref() {
                crate::managed_codex::verify_platform_signature(platform, &executable, signing)?;
            }
            if !staging
                .join(validate_relative_path(
                    &manifest.artifact.executable_relative_path,
                )?)
                .is_file()
            {
                return Err("[browser-resource] Required Browser component is missing".to_string());
            }
            publish_install(&staging, platform, &manifest, &signature)
        })();
        let _ = fs::remove_file(&archive_path);
        if install_result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        install_result.map_err(|error| FileLockError::Io(std::io::Error::other(error)))
    })
    .map_err(String::from);

    match result {
        Ok(()) => {
            let mut ready = transition("ready", None, None, None, Some(100), None);
            ready.install_authorized = true;
            ready.installed_revision = Some(REQUIRED_RUNTIME_SET.to_string());
            ready.retryable = false;
            Ok(publish_status(ready))
        }
        Err(error) => {
            let authorized = platform_key()
                .zip(read_installed().as_ref())
                .is_some_and(|(platform, metadata)| has_install_authorization(metadata, platform));
            let state = if authorized {
                "update_failed"
            } else {
                "install_failed"
            };
            let (error_code, retryable) = failure_projection(&error, authorized);
            let mut failed = transition(state, None, None, None, None, Some(error_code));
            failed.install_authorized = authorized;
            failed.retryable = retryable;
            publish_status(failed);
            if automatic {
                ulog_warn!("[browser-resource] automatic maintenance failed: {}", error);
            }
            Err(error)
        }
    }
}

fn perform_install_blocking(automatic: bool) -> Result<BrowserResourceStatus, String> {
    OPERATION_COORDINATOR
        .get_or_init(BrowserResourceOperationCoordinator::default)
        .run(|| perform_install_owner(automatic))
}

pub fn resolve_browser_resource() -> Result<BrowserResourceResolution, BrowserResourceStatus> {
    let status = current_status();
    let Some(platform) = platform_key() else {
        return Err(status);
    };
    let Some(metadata) = read_installed() else {
        return Err(status);
    };
    installed_runtime(&metadata, platform).ok_or(status)
}

fn start_manifest_size_probe() {
    let status = current_status();
    let Some(platform) = status.platform.clone() else {
        return;
    };
    if status.state != "never_installed"
        || status.total_bytes.is_some()
        || MANIFEST_PROBE_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
            .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Ok((manifest, _)) = fetch_manifest_with_fallback(&platform).await {
            let mut current = current_status();
            if current.state == "never_installed"
                && current.operation_id.is_none()
                && current.total_bytes.is_none()
            {
                current.total_bytes = Some(manifest.artifact.archive_size_bytes);
                publish_status(current);
            }
        }
        MANIFEST_PROBE_ACTIVE.store(false, Ordering::Release);
    });
}

#[tauri::command]
pub async fn cmd_browser_resource_status() -> Result<BrowserResourceStatus, String> {
    // A signed manifest probe lets the Settings card show the exact target
    // size. It never downloads Chromium or grants automatic maintenance.
    start_manifest_size_probe();
    Ok(current_status())
}

#[tauri::command]
pub async fn cmd_browser_resource_install() -> Result<BrowserResourceStatus, String> {
    let result = tauri::async_runtime::spawn_blocking(|| perform_install_blocking(false))
        .await
        .map_err(|_| "BROWSER_RESOURCE_INSTALL_FAILED".to_string())?;
    result.map_err(|_| {
        current_status()
            .error_code
            .unwrap_or_else(|| "BROWSER_RESOURCE_INSTALL_FAILED".to_string())
    })
}

#[tauri::command]
pub async fn cmd_browser_resource_maintain() -> Result<BrowserResourceStatus, String> {
    if !current_status().install_authorized {
        return Err("BROWSER_RESOURCE_INSTALL_NOT_AUTHORIZED".to_string());
    }
    let result = tauri::async_runtime::spawn_blocking(|| perform_install_blocking(false))
        .await
        .map_err(|_| "BROWSER_RESOURCE_UPDATE_FAILED".to_string())?;
    result.map_err(|_| {
        current_status()
            .error_code
            .unwrap_or_else(|| "BROWSER_RESOURCE_UPDATE_FAILED".to_string())
    })
}

pub fn start_automatic_maintenance() {
    let status = current_status();
    if !status.install_authorized || status.state == "ready" || status.state == "unsupported" {
        return;
    }
    tauri::async_runtime::spawn(async {
        while AUTOMATIC_RETRY_COUNT.load(Ordering::Relaxed) < AUTOMATIC_RETRY_LIMIT {
            AUTOMATIC_RETRY_COUNT.fetch_add(1, Ordering::Relaxed);
            let result =
                tauri::async_runtime::spawn_blocking(|| perform_install_blocking(true)).await;
            if matches!(result, Ok(Ok(_))) {
                break;
            }
            if !current_status().retryable {
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::sync::{mpsc, Arc};
    use zip::write::SimpleFileOptions;

    fn exact_manifest(platform: &str) -> BrowserRuntimeManifest {
        serde_json::from_value(serde_json::json!({
            "schemaVersion": MANIFEST_SCHEMA_VERSION,
            "runtimeSet": REQUIRED_RUNTIME_SET,
            "revision": REQUIRED_RUNTIME_SET,
            "playwrightMcpVersion": REQUIRED_PLAYWRIGHT_MCP_VERSION,
            "playwrightCoreVersion": REQUIRED_PLAYWRIGHT_CORE_VERSION,
            "chromiumRevision": REQUIRED_CHROMIUM_REVISION,
            "chromiumBrowserVersion": REQUIRED_CHROMIUM_BROWSER_VERSION,
            "platform": platform,
            "generatedAt": "2026-08-22T00:00:00Z",
            "licenses": ["PLAYWRIGHT_LICENSE.txt"],
            "artifact": {
                "url": format!(
                    "{}/{}/{}/artifacts/browser.zip",
                    RUNTIME_SETS_BASE_URL, REQUIRED_RUNTIME_SET, platform
                ),
                "sha256": "a".repeat(64),
                "signature": "signed-artifact",
                "signing": {
                    "type": if platform.starts_with("darwin-") { "codesign" } else { "authenticode" },
                    "teamId": "TESTTEAM",
                    "signingIdentity": "Test Publisher",
                    "publisher": "Test Publisher",
                    "certificateSha256": "b".repeat(64)
                },
                "executableRelativePath": "chromium/chrome",
                "fileAllowlist": [
                    "chromium/chrome",
                    "PLAYWRIGHT_LICENSE.txt"
                ],
                "archiveSizeBytes": 1024,
                "unpackedSizeBytes": 512,
                "entryCount": 2
            }
        }))
        .expect("exact Browser manifest fixture")
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = File::create(path).expect("create zip fixture");
        let mut writer = zip::ZipWriter::new(file);
        for (name, contents) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .expect("start zip fixture entry");
            writer.write_all(contents).expect("write zip fixture entry");
        }
        writer.finish().expect("finish zip fixture");
    }

    fn write_stored_zip_allowing_duplicates(path: &Path, entries: &[(&str, &[u8])]) {
        fn push_u16(bytes: &mut Vec<u8>, value: u16) {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        fn push_u32(bytes: &mut Vec<u8>, value: u32) {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        fn crc32(contents: &[u8]) -> u32 {
            let mut crc = u32::MAX;
            for byte in contents {
                crc ^= u32::from(*byte);
                for _ in 0..8 {
                    crc = (crc >> 1) ^ (0xedb8_8320 & (0u32.wrapping_sub(crc & 1)));
                }
            }
            !crc
        }

        let mut bytes = Vec::new();
        let mut records = Vec::new();
        for (name, contents) in entries {
            let offset = bytes.len() as u32;
            let checksum = crc32(contents);
            push_u32(&mut bytes, 0x0403_4b50);
            push_u16(&mut bytes, 20);
            push_u16(&mut bytes, 0);
            push_u16(&mut bytes, 0);
            push_u16(&mut bytes, 0);
            push_u16(&mut bytes, 0);
            push_u32(&mut bytes, checksum);
            push_u32(&mut bytes, contents.len() as u32);
            push_u32(&mut bytes, contents.len() as u32);
            push_u16(&mut bytes, name.len() as u16);
            push_u16(&mut bytes, 0);
            bytes.extend_from_slice(name.as_bytes());
            bytes.extend_from_slice(contents);
            records.push((*name, *contents, checksum, offset));
        }

        let central_offset = bytes.len() as u32;
        for (name, contents, checksum, offset) in &records {
            push_u32(&mut bytes, 0x0201_4b50);
            push_u16(&mut bytes, (3 << 8) | 20);
            push_u16(&mut bytes, 20);
            push_u16(&mut bytes, 0);
            push_u16(&mut bytes, 0);
            push_u16(&mut bytes, 0);
            push_u16(&mut bytes, 0);
            push_u32(&mut bytes, *checksum);
            push_u32(&mut bytes, contents.len() as u32);
            push_u32(&mut bytes, contents.len() as u32);
            push_u16(&mut bytes, name.len() as u16);
            push_u16(&mut bytes, 0);
            push_u16(&mut bytes, 0);
            push_u16(&mut bytes, 0);
            push_u16(&mut bytes, 0);
            push_u32(&mut bytes, 0o100644 << 16);
            push_u32(&mut bytes, *offset);
            bytes.extend_from_slice(name.as_bytes());
        }
        let central_size = bytes.len() as u32 - central_offset;
        push_u32(&mut bytes, 0x0605_4b50);
        push_u16(&mut bytes, 0);
        push_u16(&mut bytes, 0);
        push_u16(&mut bytes, records.len() as u16);
        push_u16(&mut bytes, records.len() as u16);
        push_u32(&mut bytes, central_size);
        push_u32(&mut bytes, central_offset);
        push_u16(&mut bytes, 0);
        fs::write(path, bytes).expect("write duplicate zip fixture");
    }

    fn archive_artifact(entries: &[(&str, &[u8])], allowlist: &[&str]) -> BrowserRuntimeArtifact {
        BrowserRuntimeArtifact {
            url: "https://download.myagents.io/runtimes/browser/artifact.zip".to_string(),
            sha256: "a".repeat(64),
            signature: "signed-artifact".to_string(),
            signing: None,
            executable_relative_path: "chromium/chrome".to_string(),
            file_allowlist: allowlist.iter().map(|path| (*path).to_string()).collect(),
            archive_size_bytes: 1024,
            unpacked_size_bytes: entries
                .iter()
                .map(|(_, contents)| contents.len() as u64)
                .sum(),
            entry_count: entries.len() as u64,
        }
    }

    #[test]
    fn rejects_archive_traversal_and_non_first_party_urls() {
        assert!(validate_relative_path("../escape").is_err());
        assert!(validate_relative_path("/absolute").is_err());
        assert!(validate_download_url("https://example.com/runtimes/browser/file.zip").is_err());
        assert!(
            validate_download_url("https://download.myagents.io/runtimes/browser/file.zip").is_ok()
        );
    }

    #[test]
    fn runtime_lock_values_are_canonical() {
        assert!(!REQUIRED_RUNTIME_SET.is_empty());
        assert!(REQUIRED_CHROMIUM_REVISION
            .bytes()
            .all(|byte| byte.is_ascii_digit()));
        assert_eq!(DOWNLOAD_REQUEST_TIMEOUT, Duration::from_secs(90));
    }

    #[test]
    fn failures_project_only_stable_redacted_codes() {
        assert!(should_retry_direct(
            "[browser-resource] Artifact stream failed: connection reset"
        ));
        assert!(!should_retry_direct(
            "[browser-resource] Artifact SHA-256 mismatch"
        ));
        assert_eq!(
            failure_projection("[browser-resource] Artifact Content-Length mismatch", false),
            ("BROWSER_RESOURCE_VERIFY_FAILED", false),
        );
        assert_eq!(
            failure_projection(
                "[browser-resource] Artifact download failed: connection reset",
                false,
            ),
            ("BROWSER_RESOURCE_DOWNLOAD_FAILED", true),
        );
        assert_eq!(
            failure_projection("[browser-resource] Insufficient disk space", false),
            ("BROWSER_RESOURCE_DISK_FULL", true),
        );
        assert_eq!(
            failure_projection("any internal detail", true),
            ("BROWSER_RESOURCE_UPDATE_FAILED", true),
        );
    }

    #[test]
    fn concurrent_requests_share_one_terminal_operation() {
        let coordinator = Arc::new(BrowserResourceOperationCoordinator::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        let owner_coordinator = Arc::clone(&coordinator);
        let owner_calls = Arc::clone(&calls);
        let owner = std::thread::spawn(move || {
            owner_coordinator.run(|| {
                owner_calls.fetch_add(1, Ordering::Relaxed);
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Err("BROWSER_RESOURCE_DOWNLOAD_FAILED".to_string())
            })
        });
        started_rx.recv().unwrap();

        let waiter_coordinator = Arc::clone(&coordinator);
        let waiter_calls = Arc::clone(&calls);
        let waiter = std::thread::spawn(move || {
            waiter_coordinator.run(|| {
                waiter_calls.fetch_add(1, Ordering::Relaxed);
                Ok(initial_status())
            })
        });
        while coordinator.state.lock().unwrap().waiters == 0 {
            std::thread::yield_now();
        }
        release_tx.send(()).unwrap();

        assert_eq!(
            owner.join().unwrap().unwrap_err(),
            "BROWSER_RESOURCE_DOWNLOAD_FAILED"
        );
        assert_eq!(
            waiter.join().unwrap().unwrap_err(),
            "BROWSER_RESOURCE_DOWNLOAD_FAILED"
        );
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn manifest_must_match_every_locked_runtime_identity() {
        let platform = platform_key().expect("supported test platform");
        let manifest = exact_manifest(platform);
        assert!(validate_manifest(&manifest, platform).is_ok());

        let mut wrong_core = exact_manifest(platform);
        wrong_core.playwright_core_version = "0.0.0".to_string();
        assert!(validate_manifest(&wrong_core, platform).is_err());

        let mut missing_license = exact_manifest(platform);
        missing_license.artifact.file_allowlist.pop();
        assert!(validate_manifest(&missing_license, platform).is_err());

        let mut duplicate = exact_manifest(platform);
        duplicate
            .artifact
            .file_allowlist
            .push("chromium/chrome".to_string());
        assert!(validate_manifest(&duplicate, platform).is_err());
    }

    #[test]
    fn archive_extraction_requires_the_exact_regular_file_allowlist() {
        let temp = tempfile::tempdir().expect("tempdir");
        let entries = [("chromium/chrome", b"browser".as_slice())];
        let allowlist = ["chromium/chrome"];
        let archive_path = temp.path().join("valid.zip");
        write_zip(&archive_path, &entries);
        let artifact = archive_artifact(&entries, &allowlist);
        let staging = temp.path().join("valid");
        extract_archive(&archive_path, &staging, &artifact).expect("extract exact archive");
        assert_eq!(
            fs::read(staging.join("chromium/chrome")).unwrap(),
            b"browser"
        );

        let missing_path = temp.path().join("missing.zip");
        write_zip(&missing_path, &entries[..0]);
        let missing_artifact = archive_artifact(&entries[..0], &allowlist);
        assert!(extract_archive(
            &missing_path,
            &temp.path().join("missing"),
            &missing_artifact,
        )
        .unwrap_err()
        .contains("missing allowlisted files"));
    }

    #[test]
    fn archive_extraction_rejects_traversal_duplicates_and_size_overflow() {
        let temp = tempfile::tempdir().expect("tempdir");

        let traversal_entries = [("../outside", b"escape".as_slice())];
        let traversal_path = temp.path().join("traversal.zip");
        write_zip(&traversal_path, &traversal_entries);
        let traversal_artifact = archive_artifact(&traversal_entries, &["chromium/chrome"]);
        assert!(extract_archive(
            &traversal_path,
            &temp.path().join("traversal"),
            &traversal_artifact,
        )
        .is_err());

        let duplicate_entries = [
            ("chromium/chrome", b"first".as_slice()),
            ("chromium/chrome", b"second".as_slice()),
        ];
        let duplicate_path = temp.path().join("duplicate.zip");
        write_stored_zip_allowing_duplicates(&duplicate_path, &duplicate_entries);
        let duplicate_artifact = archive_artifact(&duplicate_entries, &["chromium/chrome"]);
        let duplicate_error = extract_archive(
            &duplicate_path,
            &temp.path().join("duplicate"),
            &duplicate_artifact,
        )
        .unwrap_err();
        assert!(
            duplicate_error.contains("duplicate file entries"),
            "unexpected duplicate-entry error: {duplicate_error}"
        );

        let overflow_entries = [("chromium/chrome", b"too-large".as_slice())];
        let overflow_path = temp.path().join("overflow.zip");
        write_zip(&overflow_path, &overflow_entries);
        let mut overflow_artifact = archive_artifact(&overflow_entries, &["chromium/chrome"]);
        overflow_artifact.unpacked_size_bytes = 1;
        assert!(extract_archive(
            &overflow_path,
            &temp.path().join("overflow"),
            &overflow_artifact,
        )
        .unwrap_err()
        .contains("exceeded unpacked size"));
    }
}
