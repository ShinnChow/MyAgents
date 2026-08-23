use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

use chrono::Utc;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use uuid::Uuid;
use zip::ZipArchive;

use crate::ulog_warn;
use crate::utils::file_lock::{with_file_lock_blocking, FileLockError, FileLockOptions};

pub const REQUIRED_RUNTIME_SET: &str = env!("MYAGENTS_BROWSER_RUNTIME_SET");
pub const REQUIRED_CHROMIUM_REVISION: &str = env!("MYAGENTS_BROWSER_REVISION");
const REQUIRED_CHROMIUM_BROWSER_VERSION: &str = env!("MYAGENTS_BROWSER_VERSION");
#[cfg(test)]
const REQUIRED_PLAYWRIGHT_MCP_VERSION: &str = env!("MYAGENTS_BROWSER_PLAYWRIGHT_MCP_VERSION");
#[cfg(test)]
const REQUIRED_PLAYWRIGHT_CORE_VERSION: &str = env!("MYAGENTS_BROWSER_PLAYWRIGHT_CORE_VERSION");
const REQUIRED_ARTIFACT_SOURCE_URL: &str = env!("MYAGENTS_BROWSER_ARTIFACT_SOURCE_URL");
const REQUIRED_ARTIFACT_URL: &str = env!("MYAGENTS_BROWSER_ARTIFACT_URL");
const REQUIRED_ARTIFACT_SHA256: &str = env!("MYAGENTS_BROWSER_ARTIFACT_SHA256");
const REQUIRED_ARTIFACT_SIZE: &str = env!("MYAGENTS_BROWSER_ARTIFACT_SIZE");
const REQUIRED_UNPACKED_SIZE: &str = env!("MYAGENTS_BROWSER_UNPACKED_SIZE");
const REQUIRED_ENTRY_COUNT: &str = env!("MYAGENTS_BROWSER_ENTRY_COUNT");
const REQUIRED_ARCHIVE_ROOT: &str = env!("MYAGENTS_BROWSER_ARCHIVE_ROOT");
const REQUIRED_EXECUTABLE_RELATIVE_PATH: &str = env!("MYAGENTS_BROWSER_EXECUTABLE_RELATIVE_PATH");

const OFFICIAL_RUNTIME_SOURCE: &str = "playwright-official";
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 6000;
const AUTOMATIC_RETRY_LIMIT: u8 = 2;
const DOWNLOAD_REQUEST_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(30);

static STATUS: OnceLock<Mutex<BrowserResourceStatus>> = OnceLock::new();
static STATUS_REVISION: AtomicU64 = AtomicU64::new(1);
static AUTOMATIC_RETRY_COUNT: AtomicU8 = AtomicU8::new(0);
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
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    manifest_signature: Option<String>,
    #[serde(default)]
    artifact_signature_verified: bool,
    installed_at: String,
}

#[derive(Debug, Clone)]
struct OfficialBrowserArtifact {
    source_url: &'static str,
    url: &'static str,
    sha256: &'static str,
    archive_size_bytes: u64,
    unpacked_size_bytes: u64,
    entry_count: usize,
    archive_root: &'static str,
    executable_relative_path: &'static str,
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

fn required_artifact() -> Option<OfficialBrowserArtifact> {
    platform_key()?;
    let artifact = OfficialBrowserArtifact {
        source_url: REQUIRED_ARTIFACT_SOURCE_URL,
        url: REQUIRED_ARTIFACT_URL,
        sha256: REQUIRED_ARTIFACT_SHA256,
        archive_size_bytes: REQUIRED_ARTIFACT_SIZE.parse().ok()?,
        unpacked_size_bytes: REQUIRED_UNPACKED_SIZE.parse().ok()?,
        entry_count: REQUIRED_ENTRY_COUNT.parse().ok()?,
        archive_root: REQUIRED_ARCHIVE_ROOT,
        executable_relative_path: REQUIRED_EXECUTABLE_RELATIVE_PATH,
    };
    validate_official_artifact(&artifact).ok()?;
    Some(artifact)
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

fn validate_official_artifact(artifact: &OfficialBrowserArtifact) -> Result<(), String> {
    if artifact.sha256.len() != 64
        || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        || artifact.archive_size_bytes == 0
        || artifact.archive_size_bytes > MAX_ARCHIVE_BYTES
        || artifact.unpacked_size_bytes == 0
        || artifact.unpacked_size_bytes > MAX_UNPACKED_BYTES
        || artifact.entry_count == 0
        || artifact.entry_count > MAX_ARCHIVE_ENTRIES
        || artifact.archive_root.is_empty()
        || artifact.archive_root.contains(['/', '\\'])
        || !artifact
            .executable_relative_path
            .starts_with(&format!("{}/", artifact.archive_root))
    {
        return Err("[browser-resource] Invalid official Browser artifact lock".to_string());
    }
    validate_relative_path(artifact.executable_relative_path)?;
    validate_official_source_url(artifact.source_url)?;
    validate_download_url(artifact.url, artifact)
}

fn validate_official_source_url(raw: &str) -> Result<(), String> {
    let url = url::Url::parse(raw)
        .map_err(|error| format!("[browser-resource] Invalid download URL: {error}"))?;
    if url.scheme() != "https"
        || url.host_str() != Some("cdn.playwright.dev")
        || url.port().is_some()
        || !(url.path().starts_with("/builds/cft/")
            || url.path().starts_with("/builds/chromium/")
            || url
                .path()
                .starts_with("/dbazure/download/playwright/builds/chromium/"))
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("[browser-resource] Invalid Playwright official source URL".to_string());
    }
    Ok(())
}

fn validate_download_url(raw: &str, artifact: &OfficialBrowserArtifact) -> Result<(), String> {
    if raw != artifact.url {
        return Err(
            "[browser-resource] Download URL does not match the locked artifact".to_string(),
        );
    }
    let url = url::Url::parse(raw)
        .map_err(|error| format!("[browser-resource] Invalid download URL: {error}"))?;
    let path_allowed = match url.host_str() {
        Some("storage.googleapis.com") => url.path().starts_with(&format!(
            "/chrome-for-testing-public/{REQUIRED_CHROMIUM_BROWSER_VERSION}/"
        )),
        Some("playwright.download.prss.microsoft.com") => url.path().starts_with(&format!(
            "/dbazure/download/playwright/builds/chromium/{REQUIRED_CHROMIUM_REVISION}/"
        )),
        Some("cdn.playwright.dev") => url
            .path()
            .starts_with(&format!("/builds/chromium/{REQUIRED_CHROMIUM_REVISION}/")),
        _ => false,
    };
    if url.scheme() != "https"
        || url.port().is_some()
        || !path_allowed
        || url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "[browser-resource] Download URL is outside locked official origins".to_string(),
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
    let artifact = required_artifact()?;
    let trusted_for_current_set = match metadata.schema_version {
        1 => {
            metadata
                .manifest_signature
                .as_deref()
                .is_some_and(|signature| !signature.trim().is_empty())
                && metadata.artifact_signature_verified
        }
        2 => {
            metadata.source.as_deref() == Some(OFFICIAL_RUNTIME_SOURCE)
                && metadata.sha256.eq_ignore_ascii_case(artifact.sha256)
                && metadata.executable_relative_path == artifact.executable_relative_path
        }
        _ => false,
    };
    if !trusted_for_current_set
        || metadata.runtime_set != REQUIRED_RUNTIME_SET
        || metadata.chromium_revision != REQUIRED_CHROMIUM_REVISION
        || metadata.platform != platform
        || metadata.sha256.len() != 64
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
    let trusted_source = match metadata.schema_version {
        1 => {
            metadata
                .manifest_signature
                .as_deref()
                .is_some_and(|signature| !signature.trim().is_empty())
                && metadata.artifact_signature_verified
        }
        2 => metadata.source.as_deref() == Some(OFFICIAL_RUNTIME_SOURCE),
        _ => false,
    };
    trusted_source
        && metadata.platform == platform
        && metadata.sha256.len() == 64
        && metadata.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
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
        total_bytes: required_artifact().map(|artifact| artifact.archive_size_bytes),
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
    // This client downloads the official Browser artifact from an external
    // host, so it must retain the configured proxy path instead of using the
    // localhost-only `local_http` builder.
    #[allow(clippy::disallowed_methods)]
    let builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(30))
        .read_timeout(DOWNLOAD_READ_TIMEOUT)
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
    !normalized.contains(": http ")
        && (normalized.contains("failed to build http client")
            || normalized.contains("artifact download failed")
            || normalized.contains("artifact stream failed")
            || normalized.contains("timed out"))
}

fn advanced_download_percent(downloaded: u64, total: u64, current: u8) -> Option<u8> {
    let percent = ((downloaded.saturating_mul(100)) / total) as u8;
    (percent > current).then_some(percent)
}

async fn download_artifact(
    client: &reqwest::Client,
    artifact: &OfficialBrowserArtifact,
    archive_path: &Path,
    operation_id: &str,
    progress_state: &str,
    progress_floor: u8,
) -> Result<(), String> {
    let response = client
        .get(artifact.url)
        .send()
        .await
        .map_err(|error| format!("[browser-resource] Artifact download failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "[browser-resource] Artifact download failed: HTTP {}",
            response.status()
        ));
    }
    validate_download_url(response.url().as_str(), artifact)?;
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
    let mut last_percent = progress_floor;
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
        if let Some(percent) =
            advanced_download_percent(downloaded, artifact.archive_size_bytes, last_percent)
        {
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
    artifact: &OfficialBrowserArtifact,
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
            0,
        )
        .await
    }
    .await;
    match proxied {
        Ok(()) => Ok(()),
        Err(error) if should_retry_direct(&error) => {
            ulog_warn!("[browser-resource] transport=proxy fallback=direct resource=artifact");
            let client = http_client(DOWNLOAD_REQUEST_TIMEOUT, false)?;
            let progress_floor = current_status().progress_percent.unwrap_or(0);
            download_artifact(
                &client,
                artifact,
                archive_path,
                operation_id,
                progress_state,
                progress_floor,
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
    artifact: &OfficialBrowserArtifact,
) -> Result<(), String> {
    let archive_file = File::open(archive_path)
        .map_err(|error| format!("[browser-resource] Failed to open artifact zip: {error}"))?;
    let mut archive = ZipArchive::new(archive_file)
        .map_err(|error| format!("[browser-resource] Invalid artifact zip: {error}"))?;
    let declared_entries = declared_zip_entry_count(archive_path)?;
    if declared_entries != archive.len() {
        return Err("[browser-resource] Artifact contains duplicate file entries".to_string());
    }
    if archive.is_empty()
        || archive.len() != artifact.entry_count
        || archive.len() > MAX_ARCHIVE_ENTRIES
    {
        return Err("[browser-resource] Artifact entry count mismatch".to_string());
    }
    let mut unpacked = 0u64;
    let mut seen_entries = HashSet::new();
    let mut symlinks = Vec::new();
    let expected_executable = Path::new(artifact.executable_relative_path);
    let archive_root = Path::new(artifact.archive_root);
    let mut executable_present = false;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("[browser-resource] Failed to read zip entry: {error}"))?;
        let raw_name = entry.name().trim_end_matches('/');
        let relative = validate_relative_path(raw_name)?;
        let key = relative.to_string_lossy().replace('\\', "/");
        if !relative.starts_with(archive_root) {
            return Err("[browser-resource] Artifact entry is outside its locked root".to_string());
        }
        if !seen_entries.insert(key) {
            return Err("[browser-resource] Artifact contains duplicate file entries".to_string());
        }
        let is_symlink = entry.is_symlink();
        if !entry.is_dir() && !is_symlink {
            if entry.unix_mode().is_some_and(|mode| {
                let file_type = mode & 0o170000;
                file_type != 0 && file_type != 0o100000
            }) {
                return Err(
                    "[browser-resource] Special files are forbidden in Browser resources"
                        .to_string(),
                );
            }
            executable_present |= relative == expected_executable;
        }
        if is_symlink {
            let mut target = String::new();
            entry.read_to_string(&mut target).map_err(|error| {
                format!("[browser-resource] Failed to read symlink target: {error}")
            })?;
            let target_path = validate_relative_path(&target)?;
            let resolved = relative
                .parent()
                .unwrap_or_else(|| Path::new(""))
                .join(&target_path);
            if !resolved.starts_with(archive_root) {
                return Err(
                    "[browser-resource] Symlink target escapes the locked archive root".to_string(),
                );
            }
            symlinks.push((relative.clone(), target_path));
        }
        unpacked = unpacked
            .checked_add(entry.size())
            .ok_or_else(|| "[browser-resource] Unpacked size overflow".to_string())?;
        if unpacked > MAX_UNPACKED_BYTES {
            return Err("[browser-resource] Artifact exceeded unpacked size".to_string());
        }
    }
    if !executable_present {
        return Err("[browser-resource] Required Browser component is missing".to_string());
    }
    if unpacked != artifact.unpacked_size_bytes {
        return Err("[browser-resource] Artifact unpacked size mismatch".to_string());
    }

    fs::create_dir_all(staging).map_err(|error| {
        format!("[browser-resource] Failed to create staging directory: {error}")
    })?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("[browser-resource] Failed to read zip entry: {error}"))?;
        let raw_name = entry.name().trim_end_matches('/');
        let relative = validate_relative_path(raw_name)?;
        if entry.is_symlink() {
            continue;
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
    #[cfg(unix)]
    for (relative, target) in &symlinks {
        use std::os::unix::fs::symlink;
        let output = staging.join(relative);
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("[browser-resource] Failed to create symlink parent: {error}")
            })?;
        }
        symlink(target, &output).map_err(|error| {
            format!("[browser-resource] Failed to create runtime symlink: {error}")
        })?;
    }
    #[cfg(windows)]
    if !symlinks.is_empty() {
        return Err(
            "[browser-resource] Symlinks are forbidden in Windows Browser resources".to_string(),
        );
    }
    let canonical_staging = fs::canonicalize(staging)
        .map_err(|error| format!("[browser-resource] Failed to verify staging root: {error}"))?;
    for (relative, _) in &symlinks {
        let resolved = fs::canonicalize(staging.join(relative))
            .map_err(|error| format!("[browser-resource] Invalid runtime symlink: {error}"))?;
        if !resolved.starts_with(&canonical_staging) {
            return Err("[browser-resource] Runtime symlink escapes staging root".to_string());
        }
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

fn cleanup_abandoned_operation_entries(root: &Path) -> Result<(), String> {
    let entries = fs::read_dir(root).map_err(|error| {
        format!("[browser-resource] Failed to inspect runtime staging: {error}")
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| {
            format!("[browser-resource] Failed to inspect runtime staging entry: {error}")
        })?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(".download-") && !name.starts_with(".staging-") {
            continue;
        }
        let path = entry.path();
        let file_type = entry.file_type().map_err(|error| {
            format!("[browser-resource] Failed to inspect abandoned staging: {error}")
        })?;
        let result = if file_type.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        result.map_err(|error| {
            format!("[browser-resource] Failed to clean abandoned staging: {error}")
        })?;
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
    artifact: &OfficialBrowserArtifact,
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
        schema_version: 2,
        runtime_set: REQUIRED_RUNTIME_SET.to_string(),
        chromium_revision: REQUIRED_CHROMIUM_REVISION.to_string(),
        platform: platform.to_string(),
        executable_relative_path: artifact.executable_relative_path.to_string(),
        sha256: artifact.sha256.to_ascii_lowercase(),
        source: Some(OFFICIAL_RUNTIME_SOURCE.to_string()),
        manifest_signature: None,
        artifact_signature_verified: false,
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
    let artifact = required_artifact()
        .ok_or_else(|| "[browser-resource] Official Browser artifact is unavailable".to_string())?;
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
        cleanup_abandoned_operation_entries(&root)
            .map_err(|error| FileLockError::Io(std::io::Error::other(error)))?;
        transition(
            operation_state,
            Some(&operation_id),
            Some(0),
            Some(artifact.archive_size_bytes),
            Some(0),
            None,
        );
        ensure_free_space(
            &root,
            artifact
                .archive_size_bytes
                .saturating_add(artifact.unpacked_size_bytes),
        )
        .map_err(|error| FileLockError::Io(std::io::Error::other(error)))?;
        let archive_path = root.join(format!(".download-{operation_id}.zip"));
        let staging = root.join(format!(".staging-{operation_id}"));
        let install_result = (|| -> Result<(), String> {
            runtime_handle.block_on(download_artifact_with_fallback(
                &artifact,
                &archive_path,
                &operation_id,
                operation_state,
            ))?;
            transition(
                "verifying",
                Some(&operation_id),
                Some(artifact.archive_size_bytes),
                Some(artifact.archive_size_bytes),
                Some(100),
                None,
            );
            let digest = sha256_file(&archive_path)?;
            if !digest.eq_ignore_ascii_case(artifact.sha256) {
                return Err("[browser-resource] Artifact SHA-256 mismatch".to_string());
            }
            transition(
                "installing",
                Some(&operation_id),
                None,
                None,
                Some(100),
                None,
            );
            extract_archive(&archive_path, &staging, &artifact)?;
            if !staging
                .join(validate_relative_path(artifact.executable_relative_path)?)
                .is_file()
            {
                return Err("[browser-resource] Required Browser component is missing".to_string());
            }
            publish_install(&staging, platform, &artifact)
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
            ulog_warn!(
                "[browser-resource] operation={} failed: {}",
                if automatic { "automatic" } else { "manual" },
                error
            );
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

#[tauri::command]
pub async fn cmd_browser_resource_status() -> Result<BrowserResourceStatus, String> {
    // Size comes from the app-signed runtime lock. Reading status never starts
    // a network request or grants automatic maintenance.
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

    fn write_zip_with_symlink(path: &Path, link_target: &str) {
        let file = File::create(path).expect("create symlink zip fixture");
        let mut writer = zip::ZipWriter::new(file);
        writer
            .start_file("chromium/chrome", SimpleFileOptions::default())
            .expect("start executable fixture");
        writer
            .write_all(b"browser")
            .expect("write executable fixture");
        writer
            .add_symlink(
                "chromium/current",
                link_target,
                SimpleFileOptions::default(),
            )
            .expect("write symlink fixture");
        writer.finish().expect("finish symlink fixture");
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

    fn archive_artifact(entry_count: usize, unpacked_size_bytes: u64) -> OfficialBrowserArtifact {
        OfficialBrowserArtifact {
            source_url: "https://cdn.playwright.dev/builds/cft/146.0.7680.0/linux64/chrome-linux64.zip",
            url: "https://storage.googleapis.com/chrome-for-testing-public/146.0.7680.0/linux64/chrome-linux64.zip",
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            archive_size_bytes: 1024,
            unpacked_size_bytes,
            entry_count,
            archive_root: "chromium",
            executable_relative_path: "chromium/chrome",
        }
    }

    #[test]
    fn rejects_archive_traversal_and_non_official_urls() {
        let artifact = required_artifact().expect("official artifact for supported test platform");
        assert!(validate_relative_path("../escape").is_err());
        assert!(validate_relative_path("/absolute").is_err());
        assert!(validate_download_url("https://example.com/browser.zip", &artifact).is_err());
        assert!(validate_download_url(artifact.url, &artifact).is_ok());
        assert!(validate_official_source_url(artifact.source_url).is_ok());
    }

    #[test]
    fn runtime_lock_values_are_canonical() {
        assert!(!REQUIRED_RUNTIME_SET.is_empty());
        assert!(REQUIRED_CHROMIUM_REVISION
            .bytes()
            .all(|byte| byte.is_ascii_digit()));
        assert!(!REQUIRED_PLAYWRIGHT_MCP_VERSION.is_empty());
        assert!(!REQUIRED_PLAYWRIGHT_CORE_VERSION.is_empty());
        assert!(required_artifact().is_some());
        assert_eq!(DOWNLOAD_REQUEST_TIMEOUT, Duration::from_secs(10 * 60));
        assert_eq!(DOWNLOAD_READ_TIMEOUT, Duration::from_secs(30));
    }

    #[test]
    fn install_authorization_accepts_legacy_signed_and_new_official_metadata() {
        let platform = platform_key().expect("supported test platform");
        let artifact = required_artifact().expect("official artifact for supported test platform");
        let mut metadata = InstalledBrowserRuntime {
            schema_version: 1,
            runtime_set: REQUIRED_RUNTIME_SET.to_string(),
            chromium_revision: REQUIRED_CHROMIUM_REVISION.to_string(),
            platform: platform.to_string(),
            executable_relative_path: artifact.executable_relative_path.to_string(),
            sha256: artifact.sha256.to_string(),
            source: None,
            manifest_signature: Some("legacy-minisign".to_string()),
            artifact_signature_verified: true,
            installed_at: now_iso(),
        };
        assert!(has_install_authorization(&metadata, platform));

        metadata.schema_version = 2;
        metadata.source = Some(OFFICIAL_RUNTIME_SOURCE.to_string());
        metadata.manifest_signature = None;
        metadata.artifact_signature_verified = false;
        assert!(has_install_authorization(&metadata, platform));

        metadata.source = Some("untrusted".to_string());
        assert!(!has_install_authorization(&metadata, platform));
    }

    #[test]
    fn failures_project_only_stable_redacted_codes() {
        assert!(should_retry_direct(
            "[browser-resource] Artifact stream failed: connection reset"
        ));
        assert!(should_retry_direct(
            "[browser-resource] Failed to build HTTP client: proxy unavailable"
        ));
        assert!(!should_retry_direct(
            "[browser-resource] Artifact SHA-256 mismatch"
        ));
        assert!(!should_retry_direct(
            "[browser-resource] Artifact download failed: HTTP 404 Not Found"
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
    fn direct_fallback_keeps_download_progress_monotonic() {
        assert_eq!(advanced_download_percent(50, 100, 0), Some(50));
        assert_eq!(advanced_download_percent(1, 100, 50), None);
        assert_eq!(advanced_download_percent(50, 100, 50), None);
        assert_eq!(advanced_download_percent(51, 100, 50), Some(51));
    }

    #[test]
    fn abandoned_operation_files_are_removed_before_the_next_space_check() {
        let temp = tempfile::tempdir().expect("tempdir");
        let download = temp.path().join(".download-dead.zip");
        let staging = temp.path().join(".staging-dead");
        let previous = temp.path().join(".old-preserved");
        let installed = temp.path().join("installed.json");
        fs::write(&download, b"partial archive").unwrap();
        fs::create_dir(&staging).unwrap();
        fs::write(staging.join("partial"), b"partial extraction").unwrap();
        fs::create_dir(&previous).unwrap();
        fs::write(&installed, b"{}").unwrap();

        cleanup_abandoned_operation_entries(temp.path()).expect("clean abandoned operation");

        assert!(!download.exists());
        assert!(!staging.exists());
        assert!(previous.exists());
        assert!(installed.exists());
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
    fn official_artifact_must_match_the_app_signed_runtime_lock() {
        let artifact = required_artifact().expect("official artifact for supported test platform");
        assert!(validate_official_artifact(&artifact).is_ok());

        let mut wrong_hash = artifact.clone();
        wrong_hash.sha256 = "not-a-sha256";
        assert!(validate_official_artifact(&wrong_hash).is_err());

        let mut wrong_origin = artifact.clone();
        wrong_origin.url = "https://example.com/browser.zip";
        assert!(validate_official_artifact(&wrong_origin).is_err());
    }

    #[test]
    fn archive_extraction_requires_the_locked_root_and_executable() {
        let temp = tempfile::tempdir().expect("tempdir");
        let entries = [("chromium/chrome", b"browser".as_slice())];
        let archive_path = temp.path().join("valid.zip");
        write_zip(&archive_path, &entries);
        let artifact = archive_artifact(1, 7);
        let staging = temp.path().join("valid");
        extract_archive(&archive_path, &staging, &artifact).expect("extract exact archive");
        assert_eq!(
            fs::read(staging.join("chromium/chrome")).unwrap(),
            b"browser"
        );

        let missing_path = temp.path().join("missing.zip");
        write_zip(&missing_path, &[("chromium/other", b"other".as_slice())]);
        assert!(extract_archive(
            &missing_path,
            &temp.path().join("missing"),
            &archive_artifact(1, 5),
        )
        .unwrap_err()
        .contains("Required Browser component is missing"));
    }

    #[test]
    fn archive_extraction_rejects_traversal_duplicates_and_wrong_root() {
        let temp = tempfile::tempdir().expect("tempdir");

        let traversal_entries = [("../outside", b"escape".as_slice())];
        let traversal_path = temp.path().join("traversal.zip");
        write_zip(&traversal_path, &traversal_entries);
        let traversal_artifact = archive_artifact(1, 6);
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
        let duplicate_artifact = archive_artifact(2, 11);
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

        let outside_root_entries = [("other/chrome", b"browser".as_slice())];
        let outside_root_path = temp.path().join("outside-root.zip");
        write_zip(&outside_root_path, &outside_root_entries);
        assert!(extract_archive(
            &outside_root_path,
            &temp.path().join("outside-root"),
            &archive_artifact(1, 7),
        )
        .unwrap_err()
        .contains("outside its locked root"));
    }

    #[cfg(unix)]
    #[test]
    fn archive_extraction_allows_only_internal_relative_symlinks() {
        let temp = tempfile::tempdir().expect("tempdir");
        let valid_path = temp.path().join("valid-symlink.zip");
        write_zip_with_symlink(&valid_path, "chrome");
        let valid_staging = temp.path().join("valid-symlink");
        extract_archive(&valid_path, &valid_staging, &archive_artifact(2, 13))
            .expect("extract internal symlink");
        assert_eq!(
            fs::canonicalize(valid_staging.join("chromium/current")).unwrap(),
            fs::canonicalize(valid_staging.join("chromium/chrome")).unwrap()
        );

        let escaping_path = temp.path().join("escaping-symlink.zip");
        write_zip_with_symlink(&escaping_path, "../../outside");
        assert!(extract_archive(
            &escaping_path,
            &temp.path().join("escaping-symlink"),
            &archive_artifact(2, 20),
        )
        .is_err());
    }

    #[test]
    #[ignore = "requires MYAGENTS_BROWSER_OFFICIAL_ARCHIVE pointing at the locked official ZIP"]
    fn locked_official_archive_extracts_to_the_expected_executable() {
        let archive_path = PathBuf::from(
            std::env::var("MYAGENTS_BROWSER_OFFICIAL_ARCHIVE")
                .expect("MYAGENTS_BROWSER_OFFICIAL_ARCHIVE"),
        );
        let artifact = required_artifact().expect("official artifact for supported test platform");
        assert_eq!(
            fs::metadata(&archive_path).unwrap().len(),
            artifact.archive_size_bytes
        );
        assert!(sha256_file(&archive_path)
            .unwrap()
            .eq_ignore_ascii_case(artifact.sha256));
        let temp = tempfile::tempdir().expect("tempdir");
        extract_archive(&archive_path, temp.path(), &artifact).expect("extract official archive");
        let executable = temp.path().join(artifact.executable_relative_path);
        assert!(executable.is_file());
        let version = crate::process_cmd::new(&executable)
            .arg("--version")
            .output()
            .expect("launch locked Browser executable");
        assert!(version.status.success());
        assert!(
            String::from_utf8_lossy(&version.stdout).contains(REQUIRED_CHROMIUM_BROWSER_VERSION)
        );
    }
}
