//! Verification and exact-path loading for App-bundled speech executables.
//!
//! The user-managed model pack contains data only. This manifest covers the
//! target-specific executable layer shipped and platform-signed with the App,
//! while its ONNX Runtime entry references (and re-hashes) the one shared
//! App-owned file selected by `LocalInferenceRuntimeRegistry`.

use crate::model_pack_source::VerifiedModelPack;
use crate::native_adapter::{
    ADAPTER_ABI_VERSION, AsrEngine, DiarizerEngine, NativeAdapterError, NativeApiV1,
    NativeBuildIdentity, VadEngine, create_asr_engine, create_diarizer_engine, create_vad_engine,
    validate_api,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::ptr::NonNull;

const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_NATIVE_INCREMENT_BYTES: u64 = 80 * 1024 * 1024;
const MAX_RUNTIME_BYTES: u64 = 128 * 1024 * 1024;
const SHERPA_ONNX_VERSION: &str = "1.13.6";
const SHERPA_ONNX_COMMIT: &str = "1cb484af5e69d3c7803c1eb0b3b5ab8041e0e911";
const ONNX_RUNTIME_VERSION: &str = "1.28.0";
const ONNX_RUNTIME_REVISION: &str = "v1.28.0@da9b5e364c465de65c49d91e696cd6485270757f";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeBundleError {
    ManifestUnavailable,
    ManifestInvalid,
    TargetMismatch,
    FrameworkMismatch,
    UnsafePath,
    FileMissing,
    FileMismatch,
    RuntimeMismatch,
    WorkerIdentityMismatch,
    LoadFailed,
    Adapter(NativeAdapterError),
}

#[derive(Clone, PartialEq, Eq)]
pub struct VerifiedNativeBundle {
    manifest_path: PathBuf,
    worker_path: PathBuf,
    adapter_path: PathBuf,
    sherpa_onnx_path: PathBuf,
    onnx_runtime_path: PathBuf,
}

impl std::fmt::Debug for VerifiedNativeBundle {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("VerifiedNativeBundle([REDACTED])")
    }
}

impl VerifiedNativeBundle {
    pub fn manifest_path(&self) -> &Path {
        &self.manifest_path
    }

    pub fn worker_path(&self) -> &Path {
        &self.worker_path
    }

    pub fn adapter_path(&self) -> &Path {
        &self.adapter_path
    }

    pub fn sherpa_onnx_path(&self) -> &Path {
        &self.sherpa_onnx_path
    }

    pub fn onnx_runtime_path(&self) -> &Path {
        &self.onnx_runtime_path
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeManifest {
    schema_version: u32,
    capability: String,
    adapter_abi_version: u32,
    platform: String,
    architecture: String,
    native_increment_bytes: u64,
    framework: NativeFramework,
    files: NativeFiles,
    onnx_runtime: RuntimeReference,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeFramework {
    sherpa_onnx_version: String,
    sherpa_onnx_commit: String,
    onnx_runtime_version: String,
    onnx_runtime_upstream_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeFiles {
    media_worker: NativeFile,
    adapter: NativeFile,
    sherpa_onnx: NativeFile,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeFile {
    path: String,
    sha256: String,
    size: u64,
    license: String,
    upstream_revision: String,
    artifact_source: String,
    signing: NativeSigning,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeReference {
    sha256: String,
    size: u64,
    license: String,
    upstream_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeSigning {
    kind: String,
    identity: String,
}

/// Verify the target-specific native inventory before any dynamic loader call.
///
/// `requested_runtime` is the exact absolute path supplied by the App's shared
/// runtime registry. `current_worker` is `current_exe()` in production; taking
/// it explicitly keeps identity and tamper cases deterministic in tests.
pub fn verify_native_bundle(
    manifest_path: &Path,
    requested_runtime: &Path,
    current_worker: &Path,
) -> Result<VerifiedNativeBundle, NativeBundleError> {
    if !manifest_path.is_absolute()
        || !requested_runtime.is_absolute()
        || !current_worker.is_absolute()
    {
        return Err(NativeBundleError::UnsafePath);
    }
    verify_plain_file_shape(manifest_path, 1, MAX_MANIFEST_BYTES)
        .map_err(|_| NativeBundleError::ManifestUnavailable)?;
    let bytes = fs::read(manifest_path).map_err(|_| NativeBundleError::ManifestUnavailable)?;
    let manifest: NativeManifest =
        serde_json::from_slice(&bytes).map_err(|_| NativeBundleError::ManifestInvalid)?;
    let (platform, architecture) = current_target()?;
    if manifest.schema_version != 1
        || manifest.capability != "speech-inference"
        || manifest.adapter_abi_version != ADAPTER_ABI_VERSION
        || manifest.native_increment_bytes == 0
        || manifest.native_increment_bytes > MAX_NATIVE_INCREMENT_BYTES
    {
        return Err(NativeBundleError::ManifestInvalid);
    }
    if manifest.platform != platform || manifest.architecture != architecture {
        return Err(NativeBundleError::TargetMismatch);
    }
    if manifest.framework.sherpa_onnx_version != SHERPA_ONNX_VERSION
        || manifest.framework.sherpa_onnx_commit != SHERPA_ONNX_COMMIT
        || manifest.framework.onnx_runtime_version != ONNX_RUNTIME_VERSION
        || manifest.framework.onnx_runtime_upstream_revision != ONNX_RUNTIME_REVISION
    {
        return Err(NativeBundleError::FrameworkMismatch);
    }
    let root = manifest_path
        .parent()
        .ok_or(NativeBundleError::UnsafePath)?;
    ensure_plain_directory(root)?;
    let expected_signing = expected_signing_kind(platform);
    let worker_path = verify_native_file(
        root,
        &manifest.files.media_worker,
        "AGPL-3.0-only",
        expected_signing,
    )?;
    let adapter_path = verify_native_file(
        root,
        &manifest.files.adapter,
        "AGPL-3.0-only",
        expected_signing,
    )?;
    let sherpa_onnx_path = verify_native_file(
        root,
        &manifest.files.sherpa_onnx,
        "Apache-2.0",
        expected_signing,
    )?;
    let native_bytes = manifest
        .files
        .media_worker
        .size
        .checked_add(manifest.files.adapter.size)
        .and_then(|value| value.checked_add(manifest.files.sherpa_onnx.size))
        .ok_or(NativeBundleError::ManifestInvalid)?;
    if native_bytes != manifest.native_increment_bytes {
        return Err(NativeBundleError::ManifestInvalid);
    }
    if worker_path != current_worker {
        return Err(NativeBundleError::WorkerIdentityMismatch);
    }

    let runtime = &manifest.onnx_runtime;
    if !valid_sha256(&runtime.sha256)
        || runtime.size == 0
        || runtime.size > MAX_RUNTIME_BYTES
        || runtime.license != "MIT"
        || runtime.upstream_revision != ONNX_RUNTIME_REVISION
    {
        return Err(NativeBundleError::ManifestInvalid);
    }
    verify_plain_absolute_file(requested_runtime, runtime.size, &runtime.sha256)
        .map_err(|_| NativeBundleError::RuntimeMismatch)?;

    Ok(VerifiedNativeBundle {
        manifest_path: manifest_path.to_path_buf(),
        worker_path,
        adapter_path,
        sherpa_onnx_path,
        onnx_runtime_path: requested_runtime.to_path_buf(),
    })
}

fn verify_native_file(
    root: &Path,
    file: &NativeFile,
    expected_license: &str,
    expected_signing: &str,
) -> Result<PathBuf, NativeBundleError> {
    if !valid_sha256(&file.sha256)
        || file.size == 0
        || file.size > MAX_NATIVE_INCREMENT_BYTES
        || file.license != expected_license
        || file.upstream_revision.trim().is_empty()
        || file.artifact_source.trim().is_empty()
        || file.signing.kind != expected_signing
        || file.signing.identity.trim().is_empty()
        || file.signing.identity.len() > 256
    {
        return Err(NativeBundleError::ManifestInvalid);
    }
    let path = resolve_plain_file(root, &file.path)?;
    verify_plain_file(&path, file.size, &file.sha256)?;
    Ok(path)
}

fn verify_plain_absolute_file(
    path: &Path,
    size: u64,
    sha256: &str,
) -> Result<(), NativeBundleError> {
    if !path.is_absolute() {
        return Err(NativeBundleError::UnsafePath);
    }
    let parent = path.parent().ok_or(NativeBundleError::UnsafePath)?;
    ensure_plain_directory(parent)?;
    verify_plain_file(path, size, sha256)
}

fn verify_plain_file(path: &Path, size: u64, sha256: &str) -> Result<(), NativeBundleError> {
    verify_plain_file_shape(path, size, size)?;
    if sha256_file(path)? != sha256 {
        return Err(NativeBundleError::FileMismatch);
    }
    Ok(())
}

fn verify_plain_file_shape(path: &Path, min: u64, max: u64) -> Result<(), NativeBundleError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| NativeBundleError::FileMissing)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() < min
        || metadata.len() > max
    {
        return Err(NativeBundleError::FileMismatch);
    }
    Ok(())
}

fn ensure_plain_directory(path: &Path) -> Result<(), NativeBundleError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| NativeBundleError::UnsafePath)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(NativeBundleError::UnsafePath);
    }
    Ok(())
}

fn resolve_plain_file(root: &Path, relative: &str) -> Result<PathBuf, NativeBundleError> {
    let relative = Path::new(relative);
    if relative.is_absolute() {
        return Err(NativeBundleError::UnsafePath);
    }
    let mut path = root.to_path_buf();
    let components = relative.components().collect::<Vec<_>>();
    if components.is_empty() {
        return Err(NativeBundleError::UnsafePath);
    }
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(NativeBundleError::UnsafePath);
        };
        path.push(name);
        if index + 1 < components.len() {
            ensure_plain_directory(&path)?;
        }
    }
    Ok(path)
}

fn sha256_file(path: &Path) -> Result<String, NativeBundleError> {
    let mut file = fs::File::open(path).map_err(|_| NativeBundleError::FileMissing)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| NativeBundleError::FileMismatch)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn current_target() -> Result<(&'static str, &'static str), NativeBundleError> {
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return Err(NativeBundleError::TargetMismatch);
    };
    let architecture = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else if cfg!(target_arch = "x86_64") {
        "x64"
    } else {
        return Err(NativeBundleError::TargetMismatch);
    };
    Ok((platform, architecture))
}

fn expected_signing_kind(platform: &str) -> &'static str {
    match platform {
        "macos" => "codesign",
        "windows" => "authenticode",
        _ => "sha256-manifest",
    }
}

type GetApi = unsafe extern "C" fn(u32) -> *const NativeApiV1;

pub struct LoadedNativeAdapter {
    api: NonNull<NativeApiV1>,
    build_identity: NativeBuildIdentity,
    // Drop in dependency order: adapter -> sherpa -> runtime.
    _adapter: PlatformLibrary,
    _sherpa_onnx: PlatformLibrary,
    _onnx_runtime: PlatformLibrary,
}

impl std::fmt::Debug for LoadedNativeAdapter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LoadedNativeAdapter")
            .field("build_identity", &self.build_identity)
            .finish_non_exhaustive()
    }
}

impl LoadedNativeAdapter {
    pub fn load(bundle: &VerifiedNativeBundle) -> Result<Self, NativeBundleError> {
        // SAFETY: `verify_native_bundle` has size/hash checked all three exact
        // absolute files. The loader never accepts a basename or PATH lookup.
        let onnx_runtime = unsafe { load_dependency(&bundle.onnx_runtime_path) }?;
        // SAFETY: Same verified exact-file contract; ORT remains loaded first.
        let sherpa_onnx = unsafe { load_dependency(&bundle.sherpa_onnx_path) }?;
        // SAFETY: Same verified exact-file contract; dependencies remain live.
        let adapter = unsafe { load_adapter(&bundle.adapter_path) }?;
        // SAFETY: Symbol type exactly matches the sole exported ABI-v1 getter.
        let get_api = unsafe { load_get_api(&adapter) }?;
        // SAFETY: The adapter and both dependencies are live in local values.
        let api = unsafe { get_api(ADAPTER_ABI_VERSION) };
        // SAFETY: The table is owned by the still-live verified adapter.
        let api_ref = unsafe { validate_api(api) }.map_err(NativeBundleError::Adapter)?;
        // SAFETY: Same live adapter/table guarantee.
        let build_identity =
            unsafe { api_ref.build_identity() }.map_err(NativeBundleError::Adapter)?;
        let api = NonNull::from(api_ref);
        Ok(Self {
            api,
            build_identity,
            _adapter: adapter,
            _sherpa_onnx: sherpa_onnx,
            _onnx_runtime: onnx_runtime,
        })
    }

    pub fn build_identity(&self) -> &NativeBuildIdentity {
        &self.build_identity
    }

    pub fn create_asr<'adapter>(
        &'adapter self,
        models: &VerifiedModelPack,
    ) -> Result<AsrEngine<'adapter>, NativeBundleError> {
        create_asr_engine(
            self.api(),
            &models.sense_voice_model,
            &models.sense_voice_tokens,
        )
        .map_err(NativeBundleError::Adapter)
    }

    pub fn create_vad<'adapter>(
        &'adapter self,
        models: &VerifiedModelPack,
    ) -> Result<VadEngine<'adapter>, NativeBundleError> {
        create_vad_engine(self.api(), &models.silero_vad_model).map_err(NativeBundleError::Adapter)
    }

    pub fn create_diarizer<'adapter>(
        &'adapter self,
        models: &VerifiedModelPack,
    ) -> Result<DiarizerEngine<'adapter>, NativeBundleError> {
        create_diarizer_engine(
            self.api(),
            &models.pyannote_segmentation_model,
            &models.speaker_embedding_model,
        )
        .map_err(NativeBundleError::Adapter)
    }

    pub fn api(&self) -> &NativeApiV1 {
        // SAFETY: The pointer is validated during construction and the owning
        // library fields cannot be dropped before `self`.
        unsafe { self.api.as_ref() }
    }
}

#[cfg(unix)]
type PlatformLibrary = libloading::os::unix::Library;
#[cfg(windows)]
type PlatformLibrary = libloading::os::windows::Library;

#[cfg(unix)]
unsafe fn load_dependency(path: &Path) -> Result<PlatformLibrary, NativeBundleError> {
    use libloading::os::unix::{Library, RTLD_GLOBAL, RTLD_NOW};
    // SAFETY: Propagated verified-library precondition from the caller.
    unsafe { Library::open(Some(path), RTLD_NOW | RTLD_GLOBAL) }
        .map_err(|_| NativeBundleError::LoadFailed)
}

#[cfg(unix)]
unsafe fn load_adapter(path: &Path) -> Result<PlatformLibrary, NativeBundleError> {
    use libloading::os::unix::{Library, RTLD_LOCAL, RTLD_NOW};
    // SAFETY: Propagated verified-library precondition from the caller.
    unsafe { Library::open(Some(path), RTLD_NOW | RTLD_LOCAL) }
        .map_err(|_| NativeBundleError::LoadFailed)
}

#[cfg(windows)]
unsafe fn load_dependency(path: &Path) -> Result<PlatformLibrary, NativeBundleError> {
    use libloading::os::windows::{
        LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32, Library,
    };
    // Excludes the current directory, PATH, and user DLL directories. The
    // exact shared ORT is loaded first and satisfies sherpa's import by module
    // identity; remaining OS dependencies may resolve only from System32.
    // SAFETY: Propagated verified-library precondition from the caller.
    unsafe {
        Library::load_with_flags(
            path,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
        )
    }
    .map_err(|_| NativeBundleError::LoadFailed)
}

#[cfg(windows)]
unsafe fn load_adapter(path: &Path) -> Result<PlatformLibrary, NativeBundleError> {
    // SAFETY: The same restricted search policy applies to the adapter.
    unsafe { load_dependency(path) }
}

unsafe fn load_get_api(library: &PlatformLibrary) -> Result<GetApi, NativeBundleError> {
    // SAFETY: The verified adapter contract exports exactly this symbol/type.
    let symbol = unsafe { library.get::<GetApi>(b"myagents_speech_adapter_get_api\0") }
        .map_err(|_| NativeBundleError::LoadFailed)?;
    Ok(*symbol)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write_file(root: &Path, relative: &str, bytes: &[u8]) -> NativeFileFixture {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        NativeFileFixture {
            relative: relative.into(),
            path,
            size: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }

    struct NativeFileFixture {
        relative: String,
        path: PathBuf,
        size: u64,
        sha256: String,
    }

    fn native_entry(file: &NativeFileFixture, license: &str, signing: &str) -> serde_json::Value {
        json!({
            "path": file.relative,
            "sha256": file.sha256,
            "size": file.size,
            "license": license,
            "upstreamRevision": "fixture-revision",
            "artifactSource": "fixture-source",
            "signing": { "kind": signing, "identity": "fixture-signing" }
        })
    }

    fn write_manifest(root: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let (platform, architecture) = current_target().unwrap();
        let signing = expected_signing_kind(platform);
        let worker = write_file(root, "bin/myagents-media-worker", b"worker");
        let adapter = write_file(root, "native/adapter", b"adapter");
        let sherpa = write_file(root, "native/sherpa", b"sherpa");
        let runtime = write_file(root, "shared/onnxruntime", b"runtime");
        let manifest = json!({
            "schemaVersion": 1,
            "capability": "speech-inference",
            "adapterAbiVersion": 1,
            "platform": platform,
            "architecture": architecture,
            "nativeIncrementBytes": worker.size + adapter.size + sherpa.size,
            "framework": {
                "sherpaOnnxVersion": SHERPA_ONNX_VERSION,
                "sherpaOnnxCommit": SHERPA_ONNX_COMMIT,
                "onnxRuntimeVersion": ONNX_RUNTIME_VERSION,
                "onnxRuntimeUpstreamRevision": ONNX_RUNTIME_REVISION
            },
            "files": {
                "mediaWorker": native_entry(&worker, "AGPL-3.0-only", signing),
                "adapter": native_entry(&adapter, "AGPL-3.0-only", signing),
                "sherpaOnnx": native_entry(&sherpa, "Apache-2.0", signing)
            },
            "onnxRuntime": {
                "sha256": runtime.sha256,
                "size": runtime.size,
                "license": "MIT",
                "upstreamRevision": ONNX_RUNTIME_REVISION
            }
        });
        let manifest_path = root.join("manifest.json");
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        (manifest_path, runtime.path, worker.path)
    }

    #[test]
    fn verifies_exact_target_inventory_and_redacts_debug_paths() {
        let root = tempfile::tempdir().unwrap();
        let (manifest, runtime, worker) = write_manifest(root.path());
        let verified = verify_native_bundle(&manifest, &runtime, &worker).unwrap();
        assert_eq!(verified.manifest_path(), manifest);
        assert_eq!(verified.onnx_runtime_path(), runtime);
        assert_eq!(format!("{verified:?}"), "VerifiedNativeBundle([REDACTED])");
    }

    #[test]
    fn rejects_target_framework_and_native_size_drift() {
        let root = tempfile::tempdir().unwrap();
        let (manifest, runtime, worker) = write_manifest(root.path());
        let original: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();

        let mut target = original.clone();
        target["architecture"] = json!("wrong");
        fs::write(&manifest, serde_json::to_vec(&target).unwrap()).unwrap();
        assert_eq!(
            verify_native_bundle(&manifest, &runtime, &worker),
            Err(NativeBundleError::TargetMismatch)
        );

        let mut framework = original.clone();
        framework["framework"]["sherpaOnnxVersion"] = json!("1.13.5");
        fs::write(&manifest, serde_json::to_vec(&framework).unwrap()).unwrap();
        assert_eq!(
            verify_native_bundle(&manifest, &runtime, &worker),
            Err(NativeBundleError::FrameworkMismatch)
        );

        let mut size = original;
        size["nativeIncrementBytes"] = json!(1);
        fs::write(&manifest, serde_json::to_vec(&size).unwrap()).unwrap();
        assert_eq!(
            verify_native_bundle(&manifest, &runtime, &worker),
            Err(NativeBundleError::ManifestInvalid)
        );
    }

    #[test]
    fn rejects_runtime_worker_and_native_file_identity_drift() {
        let root = tempfile::tempdir().unwrap();
        let (manifest, runtime, worker) = write_manifest(root.path());
        fs::write(&runtime, b"drifted").unwrap();
        assert_eq!(
            verify_native_bundle(&manifest, &runtime, &worker),
            Err(NativeBundleError::RuntimeMismatch)
        );

        let root = tempfile::tempdir().unwrap();
        let (manifest, runtime, worker) = write_manifest(root.path());
        let other_worker = root.path().join("other-worker");
        fs::write(&other_worker, b"worker").unwrap();
        assert_eq!(
            verify_native_bundle(&manifest, &runtime, &other_worker),
            Err(NativeBundleError::WorkerIdentityMismatch)
        );

        fs::write(root.path().join("native/adapter"), b"drifted").unwrap();
        assert_eq!(
            verify_native_bundle(&manifest, &runtime, &worker),
            Err(NativeBundleError::FileMismatch)
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_native_file_or_parent() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let (manifest, runtime, worker) = write_manifest(root.path());
        fs::remove_file(root.path().join("native/adapter")).unwrap();
        fs::write(outside.path().join("adapter"), b"adapter").unwrap();
        symlink(
            outside.path().join("adapter"),
            root.path().join("native/adapter"),
        )
        .unwrap();
        assert_eq!(
            verify_native_bundle(&manifest, &runtime, &worker),
            Err(NativeBundleError::FileMismatch)
        );

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let (manifest, runtime, worker) = write_manifest(root.path());
        fs::remove_file(root.path().join("native/adapter")).unwrap();
        fs::remove_file(root.path().join("native/sherpa")).unwrap();
        fs::remove_dir(root.path().join("native")).unwrap();
        fs::create_dir(outside.path().join("native")).unwrap();
        fs::write(outside.path().join("native/adapter"), b"adapter").unwrap();
        fs::write(outside.path().join("native/sherpa"), b"sherpa").unwrap();
        symlink(outside.path().join("native"), root.path().join("native")).unwrap();
        assert_eq!(
            verify_native_bundle(&manifest, &runtime, &worker),
            Err(NativeBundleError::UnsafePath)
        );
    }
}
