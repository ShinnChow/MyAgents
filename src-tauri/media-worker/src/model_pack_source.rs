use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

pub const MODEL_PACK_SOURCE_LOCK: &str = include_str!("../model-pack-source-lock.json");

const EXPECTED_ASSET_IDS: [&str; 4] = [
    "sensevoice",
    "silero-vad",
    "pyannote-segmentation",
    "3dspeaker-eres2net",
];
const EXPECTED_MODEL_PATHS: [&str; 5] = [
    "models/sensevoice/model.int8.onnx",
    "models/sensevoice/tokens.txt",
    "models/vad/silero_vad.int8.onnx",
    "models/diarization/pyannote-segmentation-3.0.int8.onnx",
    "models/diarization/3dspeaker-eres2net-base-zh-16k.onnx",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceLockError {
    InvalidJson,
    InvalidIdentity,
    InvalidSignaturePolicy,
    InvalidFramework,
    InvalidAsset,
    InvalidLegalArtifact,
    DuplicateIdentity,
    SizeMismatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstalledPackError {
    ManifestUnavailable,
    ManifestMismatch,
    InvalidInventory,
    MissingFile,
    UnsafePath,
    FileMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedModelPack {
    pub pack_revision: String,
    pub manifest_path: PathBuf,
    pub sense_voice_model: PathBuf,
    pub sense_voice_tokens: PathBuf,
    pub silero_vad_model: PathBuf,
    pub pyannote_segmentation_model: PathBuf,
    pub speaker_embedding_model: PathBuf,
}

/// Sanitized, immutable download/extraction plan derived from the exact source
/// lock compiled into the App and Worker. Installers must consume this plan
/// instead of reparsing mutable remote manifest fields into filesystem paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelPackInstallPlan {
    pub pack_id: String,
    pub pack_revision: String,
    pub source_download_bytes: u64,
    pub installed_model_bytes: u64,
    pub download_hard_limit_bytes: u64,
    pub assets: Vec<ModelPackAsset>,
    pub legal_artifacts: Vec<ModelPackLegalArtifact>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelPackAsset {
    pub id: String,
    pub url: String,
    pub sha256: String,
    pub size: u64,
    pub format: ModelPackAssetFormat,
    pub selected_files: Vec<ModelPackSelectedFile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelPackAssetFormat {
    File,
    TarBz2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelPackSelectedFile {
    pub source_path: String,
    pub install_path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelPackLegalArtifact {
    pub id: String,
    pub install_path: String,
    pub source: ModelPackLegalSource,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelPackLegalSource {
    Remote {
        url: String,
        sha256: String,
        size: u64,
    },
    Archive {
        asset_id: String,
        source_path: String,
        sha256: String,
        size: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ExpectedInstalledFile {
    path: String,
    sha256: String,
    size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceLock {
    schema_version: u32,
    pack_id: String,
    pack_revision: String,
    source_download_bytes: u64,
    installed_model_bytes: u64,
    download_hard_limit_bytes: u64,
    signature_policy: SignaturePolicy,
    framework: Framework,
    assets: Vec<Asset>,
    legal_artifacts: Vec<LegalArtifact>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignaturePolicy {
    algorithm: String,
    trust_root: String,
    detached_signature_required: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Framework {
    sherpa_onnx_version: String,
    sherpa_onnx_commit: String,
    onnx_runtime_version: String,
    sample_rate: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Asset {
    id: String,
    url: String,
    sha256: String,
    size: u64,
    format: AssetFormat,
    upstream_revision: String,
    license: String,
    selected_files: Vec<SelectedFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AssetFormat {
    File,
    TarBz2,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectedFile {
    source_path: String,
    install_path: String,
    sha256: String,
    size: u64,
    kind: SelectedFileKind,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SelectedFileKind {
    Model,
    Tokens,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegalArtifact {
    id: String,
    license: String,
    install_path: String,
    attribution: String,
    source: LegalSource,
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum LegalSource {
    Remote {
        url: String,
        sha256: String,
        size: u64,
        upstream_revision: String,
    },
    Archive {
        asset_id: String,
        source_path: String,
        sha256: String,
        size: u64,
    },
}

pub fn validate_source_lock_json(json: &str) -> Result<(), SourceLockError> {
    let lock: SourceLock = serde_json::from_str(json).map_err(|_| SourceLockError::InvalidJson)?;
    if lock.schema_version != 1
        || lock.pack_id != "local-standard-speech"
        || lock.pack_revision != "local-standard-speech-v2"
        || lock.download_hard_limit_bytes != 300 * 1024 * 1024
    {
        return Err(SourceLockError::InvalidIdentity);
    }
    if lock.signature_policy.algorithm != "minisign-ed25519"
        || lock.signature_policy.trust_root != "app-updater"
        || !lock.signature_policy.detached_signature_required
    {
        return Err(SourceLockError::InvalidSignaturePolicy);
    }
    if lock.framework.sherpa_onnx_version != "1.13.6"
        || lock.framework.sherpa_onnx_commit != "1cb484af5e69d3c7803c1eb0b3b5ab8041e0e911"
        || lock.framework.onnx_runtime_version != "1.28.0"
        || lock.framework.sample_rate != 16_000
    {
        return Err(SourceLockError::InvalidFramework);
    }
    if lock.assets.len() != EXPECTED_ASSET_IDS.len() {
        return Err(SourceLockError::InvalidAsset);
    }

    let mut asset_ids = HashSet::new();
    let mut model_paths = HashSet::new();
    let mut licenses = HashSet::new();
    let mut source_download_bytes = 0_u64;
    let mut installed_model_bytes = 0_u64;
    let mut asset_formats = HashMap::new();
    for asset in &lock.assets {
        if !asset_ids.insert(asset.id.as_str()) {
            return Err(SourceLockError::DuplicateIdentity);
        }
        if !EXPECTED_ASSET_IDS.contains(&asset.id.as_str())
            || !valid_first_party_source_url(&asset.url, &asset.sha256)
            || !valid_sha256(&asset.sha256)
            || asset.size == 0
            || asset.upstream_revision.trim().is_empty()
            || asset.license.trim().is_empty()
            || asset.selected_files.is_empty()
        {
            return Err(SourceLockError::InvalidAsset);
        }
        source_download_bytes = source_download_bytes
            .checked_add(asset.size)
            .ok_or(SourceLockError::SizeMismatch)?;
        asset_formats.insert(asset.id.as_str(), &asset.format);
        licenses.insert(asset.license.as_str());
        for selected in &asset.selected_files {
            if !model_paths.insert(selected.install_path.as_str()) {
                return Err(SourceLockError::DuplicateIdentity);
            }
            if !safe_relative_path(&selected.source_path)
                || !safe_relative_path(&selected.install_path)
                || !selected.install_path.starts_with("models/")
                || !EXPECTED_MODEL_PATHS.contains(&selected.install_path.as_str())
                || !valid_sha256(&selected.sha256)
                || selected.size == 0
            {
                return Err(SourceLockError::InvalidAsset);
            }
            if matches!(asset.format, AssetFormat::File)
                && (asset.selected_files.len() != 1
                    || selected.sha256 != asset.sha256
                    || selected.size != asset.size)
            {
                return Err(SourceLockError::InvalidAsset);
            }
            if matches!(selected.kind, SelectedFileKind::Tokens)
                != selected.install_path.ends_with("tokens.txt")
            {
                return Err(SourceLockError::InvalidAsset);
            }
            installed_model_bytes = installed_model_bytes
                .checked_add(selected.size)
                .ok_or(SourceLockError::SizeMismatch)?;
        }
    }
    if model_paths.len() != EXPECTED_MODEL_PATHS.len()
        || source_download_bytes != lock.source_download_bytes
        || installed_model_bytes != lock.installed_model_bytes
        || source_download_bytes > lock.download_hard_limit_bytes
    {
        return Err(SourceLockError::SizeMismatch);
    }

    let mut legal_ids = HashSet::new();
    let mut legal_paths = HashSet::new();
    let mut covered_licenses = HashSet::new();
    let mut legal_download_bytes = 0_u64;
    for legal in &lock.legal_artifacts {
        if !legal_ids.insert(legal.id.as_str()) || !legal_paths.insert(legal.install_path.as_str())
        {
            return Err(SourceLockError::DuplicateIdentity);
        }
        if !safe_path_component(&legal.id)
            || legal.license.trim().is_empty()
            || legal.attribution.trim().is_empty()
            || !safe_relative_path(&legal.install_path)
            || !legal.install_path.starts_with("legal/")
        {
            return Err(SourceLockError::InvalidLegalArtifact);
        }
        match &legal.source {
            LegalSource::Remote {
                url,
                sha256,
                size,
                upstream_revision,
            } => {
                if !valid_first_party_source_url(url, sha256)
                    || !valid_sha256(sha256)
                    || *size == 0
                    || upstream_revision.trim().is_empty()
                {
                    return Err(SourceLockError::InvalidLegalArtifact);
                }
                legal_download_bytes = legal_download_bytes
                    .checked_add(*size)
                    .ok_or(SourceLockError::SizeMismatch)?;
            }
            LegalSource::Archive {
                asset_id,
                source_path,
                sha256,
                size,
            } => {
                if !asset_ids.contains(asset_id.as_str())
                    || matches!(
                        asset_formats.get(asset_id.as_str()),
                        Some(AssetFormat::File)
                    )
                    || !safe_relative_path(source_path)
                    || !valid_sha256(sha256)
                    || *size == 0
                {
                    return Err(SourceLockError::InvalidLegalArtifact);
                }
            }
        }
        covered_licenses.insert(legal.license.as_str());
    }
    if !licenses.is_subset(&covered_licenses) {
        return Err(SourceLockError::InvalidLegalArtifact);
    }
    if source_download_bytes
        .checked_add(legal_download_bytes)
        .ok_or(SourceLockError::SizeMismatch)?
        > lock.download_hard_limit_bytes
    {
        return Err(SourceLockError::SizeMismatch);
    }
    Ok(())
}

pub fn install_plan() -> Result<ModelPackInstallPlan, SourceLockError> {
    validate_source_lock_json(MODEL_PACK_SOURCE_LOCK)?;
    let lock: SourceLock =
        serde_json::from_str(MODEL_PACK_SOURCE_LOCK).map_err(|_| SourceLockError::InvalidJson)?;
    Ok(ModelPackInstallPlan {
        pack_id: lock.pack_id,
        pack_revision: lock.pack_revision,
        source_download_bytes: lock.source_download_bytes,
        installed_model_bytes: lock.installed_model_bytes,
        download_hard_limit_bytes: lock.download_hard_limit_bytes,
        assets: lock
            .assets
            .into_iter()
            .map(|asset| ModelPackAsset {
                id: asset.id,
                url: asset.url,
                sha256: asset.sha256,
                size: asset.size,
                format: match asset.format {
                    AssetFormat::File => ModelPackAssetFormat::File,
                    AssetFormat::TarBz2 => ModelPackAssetFormat::TarBz2,
                },
                selected_files: asset
                    .selected_files
                    .into_iter()
                    .map(|selected| ModelPackSelectedFile {
                        source_path: selected.source_path,
                        install_path: selected.install_path,
                        sha256: selected.sha256,
                        size: selected.size,
                    })
                    .collect(),
            })
            .collect(),
        legal_artifacts: lock
            .legal_artifacts
            .into_iter()
            .map(|legal| ModelPackLegalArtifact {
                id: legal.id,
                install_path: legal.install_path,
                source: match legal.source {
                    LegalSource::Remote {
                        url, sha256, size, ..
                    } => ModelPackLegalSource::Remote { url, sha256, size },
                    LegalSource::Archive {
                        asset_id,
                        source_path,
                        sha256,
                        size,
                    } => ModelPackLegalSource::Archive {
                        asset_id,
                        source_path,
                        sha256,
                        size,
                    },
                },
            })
            .collect(),
    })
}

/// Verifies the exact activated speech model pack without trusting mutable
/// manifest fields. The manifest bytes must equal the source lock compiled
/// into this worker generation; every selected model and legal notice is then
/// re-opened as a no-symlink regular file and checked by size and SHA-256.
pub fn verify_installed_pack(
    manifest_path: &Path,
) -> Result<VerifiedModelPack, InstalledPackError> {
    inspect_installed_pack_inner(manifest_path, true)
}

/// Restores an App-activated pack from its immutable manifest and exact file
/// metadata without reading hundreds of MiB of model bytes. This is only a
/// discovery check: callers must never load a model from this result unless an
/// isolated Worker performs `verify_installed_pack` at its execution boundary.
pub fn inspect_installed_pack(
    manifest_path: &Path,
) -> Result<VerifiedModelPack, InstalledPackError> {
    inspect_installed_pack_inner(manifest_path, false)
}

fn inspect_installed_pack_inner(
    manifest_path: &Path,
    verify_digests: bool,
) -> Result<VerifiedModelPack, InstalledPackError> {
    if !manifest_path.is_absolute() {
        return Err(InstalledPackError::UnsafePath);
    }
    let metadata =
        fs::symlink_metadata(manifest_path).map_err(|_| InstalledPackError::ManifestUnavailable)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || has_execute_bits(&metadata)
        || metadata.len() != MODEL_PACK_SOURCE_LOCK.len() as u64
    {
        return Err(InstalledPackError::ManifestMismatch);
    }
    let manifest_bytes =
        fs::read(manifest_path).map_err(|_| InstalledPackError::ManifestUnavailable)?;
    if manifest_bytes != MODEL_PACK_SOURCE_LOCK.as_bytes() {
        return Err(InstalledPackError::ManifestMismatch);
    }
    let lock: SourceLock = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| InstalledPackError::ManifestMismatch)?;
    let root = manifest_path
        .parent()
        .ok_or(InstalledPackError::UnsafePath)?;
    ensure_plain_directory(root)?;
    let expected = expected_installed_files(&lock)?;
    let verified = inspect_file_inventory(root, &expected, verify_digests)?;
    let path = |relative: &str| {
        verified
            .get(relative)
            .cloned()
            .ok_or(InstalledPackError::InvalidInventory)
    };
    Ok(VerifiedModelPack {
        pack_revision: lock.pack_revision,
        manifest_path: manifest_path.to_path_buf(),
        sense_voice_model: path("models/sensevoice/model.int8.onnx")?,
        sense_voice_tokens: path("models/sensevoice/tokens.txt")?,
        silero_vad_model: path("models/vad/silero_vad.int8.onnx")?,
        pyannote_segmentation_model: path(
            "models/diarization/pyannote-segmentation-3.0.int8.onnx",
        )?,
        speaker_embedding_model: path("models/diarization/3dspeaker-eres2net-base-zh-16k.onnx")?,
    })
}

fn expected_installed_files(
    lock: &SourceLock,
) -> Result<Vec<ExpectedInstalledFile>, InstalledPackError> {
    let mut expected = Vec::with_capacity(EXPECTED_MODEL_PATHS.len() + lock.legal_artifacts.len());
    for asset in &lock.assets {
        for selected in &asset.selected_files {
            expected.push(ExpectedInstalledFile {
                path: selected.install_path.clone(),
                sha256: selected.sha256.clone(),
                size: selected.size,
            });
        }
    }
    for legal in &lock.legal_artifacts {
        let (sha256, size) = match &legal.source {
            LegalSource::Remote { sha256, size, .. }
            | LegalSource::Archive { sha256, size, .. } => (sha256.clone(), *size),
        };
        expected.push(ExpectedInstalledFile {
            path: legal.install_path.clone(),
            sha256,
            size,
        });
    }
    let unique = expected
        .iter()
        .map(|file| file.path.as_str())
        .collect::<HashSet<_>>();
    if expected.len() != EXPECTED_MODEL_PATHS.len() + lock.legal_artifacts.len()
        || unique.len() != expected.len()
    {
        return Err(InstalledPackError::InvalidInventory);
    }
    Ok(expected)
}

#[cfg(test)]
fn verify_file_inventory(
    root: &Path,
    expected: &[ExpectedInstalledFile],
) -> Result<HashMap<String, PathBuf>, InstalledPackError> {
    inspect_file_inventory(root, expected, true)
}

fn inspect_file_inventory(
    root: &Path,
    expected: &[ExpectedInstalledFile],
    verify_digests: bool,
) -> Result<HashMap<String, PathBuf>, InstalledPackError> {
    let mut verified = HashMap::with_capacity(expected.len());
    for file in expected {
        let path = resolve_plain_file(root, &file.path)?;
        let metadata = fs::symlink_metadata(&path).map_err(|_| InstalledPackError::MissingFile)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || has_execute_bits(&metadata)
            || metadata.len() != file.size
            || (verify_digests && sha256_file(&path)? != file.sha256)
        {
            return Err(InstalledPackError::FileMismatch);
        }
        verified.insert(file.path.clone(), path);
    }
    Ok(verified)
}

fn has_execute_bits(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        false
    }
}

fn ensure_plain_directory(path: &Path) -> Result<(), InstalledPackError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| InstalledPackError::UnsafePath)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(InstalledPackError::UnsafePath);
    }
    Ok(())
}

fn resolve_plain_file(root: &Path, relative: &str) -> Result<PathBuf, InstalledPackError> {
    if !safe_relative_path(relative) {
        return Err(InstalledPackError::UnsafePath);
    }
    let mut path = root.to_path_buf();
    let components = Path::new(relative).components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(InstalledPackError::UnsafePath);
        };
        path.push(name);
        if index + 1 < components.len() {
            ensure_plain_directory(&path)?;
        }
    }
    Ok(path)
}

fn sha256_file(path: &Path) -> Result<String, InstalledPackError> {
    let mut file = fs::File::open(path).map_err(|_| InstalledPackError::MissingFile)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| InstalledPackError::FileMismatch)?;
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

fn valid_first_party_source_url(value: &str, sha256: &str) -> bool {
    if !valid_sha256(sha256) {
        return false;
    }
    let prefix = format!("https://download.myagents.io/models/speech/assets/sha256/{sha256}/");
    let Some(filename) = value.strip_prefix(&prefix) else {
        return false;
    };
    !filename.is_empty()
        && filename.len() <= 192
        && !filename.contains(['/', '\\', '\0'])
        && filename
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn safe_relative_path(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.contains(['\\', '\0'])
        && value
            .split('/')
            .all(|part| !part.is_empty() && !matches!(part, "." | ".."))
}

fn safe_path_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn committed_source_lock_has_exact_models_sizes_licenses_and_signature_policy() {
        validate_source_lock_json(MODEL_PACK_SOURCE_LOCK).unwrap();
        let plan = install_plan().unwrap();
        assert_eq!(plan.assets.len(), 4);
        assert_eq!(
            plan.assets
                .iter()
                .map(|asset| asset.selected_files.len())
                .sum::<usize>(),
            5
        );
        assert_eq!(plan.legal_artifacts.len(), 5);
        assert_eq!(plan.source_download_bytes, 209_767_948);
        assert_eq!(plan.installed_model_bytes, 280_896_862);
        assert_eq!(plan.download_hard_limit_bytes, 300 * 1024 * 1024);
    }

    #[test]
    fn rejects_download_or_install_size_drift() {
        let download_drift = MODEL_PACK_SOURCE_LOCK.replace(
            "\"sourceDownloadBytes\": 209767948",
            "\"sourceDownloadBytes\": 209767949",
        );
        assert_eq!(
            validate_source_lock_json(&download_drift),
            Err(SourceLockError::SizeMismatch)
        );
        let install_drift = MODEL_PACK_SOURCE_LOCK.replace(
            "\"installedModelBytes\": 280896862",
            "\"installedModelBytes\": 280896861",
        );
        assert_eq!(
            validate_source_lock_json(&install_drift),
            Err(SourceLockError::SizeMismatch)
        );
    }

    #[test]
    fn rejects_path_traversal_and_untrusted_download_hosts() {
        let traversal = MODEL_PACK_SOURCE_LOCK.replacen(
            "models/sensevoice/model.int8.onnx",
            "models/../escape.onnx",
            1,
        );
        assert!(matches!(
            validate_source_lock_json(&traversal),
            Err(SourceLockError::InvalidAsset)
        ));
        let host = MODEL_PACK_SOURCE_LOCK.replacen(
            "https://download.myagents.io/",
            "https://example.com/",
            1,
        );
        assert_eq!(
            validate_source_lock_json(&host),
            Err(SourceLockError::InvalidAsset)
        );
        let hash_path = MODEL_PACK_SOURCE_LOCK.replacen(
            "assets/sha256/7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e/",
            "assets/sha256/c36d490aff5ab924ca6c7aeec4d8f6bd3d22db6fa17611b9c5b17eae58ac3a20/",
            1,
        );
        assert_eq!(
            validate_source_lock_json(&hash_path),
            Err(SourceLockError::InvalidAsset)
        );
    }

    #[test]
    fn rejects_missing_detached_signature_or_license_coverage() {
        let unsigned = MODEL_PACK_SOURCE_LOCK.replace(
            "\"detachedSignatureRequired\": true",
            "\"detachedSignatureRequired\": false",
        );
        assert_eq!(
            validate_source_lock_json(&unsigned),
            Err(SourceLockError::InvalidSignaturePolicy)
        );
        let missing_license = MODEL_PACK_SOURCE_LOCK.replacen(
            "\"license\": \"FunASR-Model-License-1.1\"",
            "\"license\": \"Uncovered-Model-License\"",
            1,
        );
        assert_eq!(
            validate_source_lock_json(&missing_license),
            Err(SourceLockError::InvalidLegalArtifact)
        );
    }

    #[test]
    fn installed_inventory_accepts_only_plain_files_with_exact_bytes() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("models")).unwrap();
        fs::create_dir(root.path().join("legal")).unwrap();
        fs::write(root.path().join("models/model.onnx"), b"model-bytes").unwrap();
        fs::write(root.path().join("legal/LICENSE.txt"), b"license-bytes").unwrap();
        let expected = vec![
            ExpectedInstalledFile {
                path: "models/model.onnx".into(),
                sha256: format!("{:x}", Sha256::digest(b"model-bytes")),
                size: 11,
            },
            ExpectedInstalledFile {
                path: "legal/LICENSE.txt".into(),
                sha256: format!("{:x}", Sha256::digest(b"license-bytes")),
                size: 13,
            },
        ];
        let verified = verify_file_inventory(root.path(), &expected).unwrap();
        assert_eq!(verified.len(), 2);

        fs::write(root.path().join("models/model.onnx"), b"model-drift").unwrap();
        assert_eq!(
            verify_file_inventory(root.path(), &expected),
            Err(InstalledPackError::FileMismatch)
        );
    }

    #[test]
    fn discovery_inventory_does_not_hash_model_bytes() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("models")).unwrap();
        fs::write(root.path().join("models/model.onnx"), b"model-drift").unwrap();
        let expected = vec![ExpectedInstalledFile {
            path: "models/model.onnx".into(),
            sha256: format!("{:x}", Sha256::digest(b"other-digest")),
            size: 11,
        }];

        assert!(inspect_file_inventory(root.path(), &expected, false).is_ok());
        assert_eq!(
            inspect_file_inventory(root.path(), &expected, true),
            Err(InstalledPackError::FileMismatch)
        );
    }

    #[test]
    fn installed_manifest_must_be_absolute_and_byte_identical() {
        assert_eq!(
            verify_installed_pack(Path::new("relative/manifest.json")),
            Err(InstalledPackError::UnsafePath)
        );
        let root = tempfile::tempdir().unwrap();
        let manifest = root.path().join("manifest.json");
        fs::write(
            &manifest,
            MODEL_PACK_SOURCE_LOCK.replace("1.13.6", "1.13.5"),
        )
        .unwrap();
        assert_eq!(
            verify_installed_pack(&manifest),
            Err(InstalledPackError::ManifestMismatch)
        );
    }

    #[cfg(unix)]
    #[test]
    fn installed_inventory_rejects_executable_data_files() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("models")).unwrap();
        let path = root.path().join("models/model.onnx");
        fs::write(&path, b"model-bytes").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let expected = vec![ExpectedInstalledFile {
            path: "models/model.onnx".into(),
            sha256: format!("{:x}", Sha256::digest(b"model-bytes")),
            size: 11,
        }];
        assert_eq!(
            verify_file_inventory(root.path(), &expected),
            Err(InstalledPackError::FileMismatch)
        );
    }

    #[cfg(unix)]
    #[test]
    fn installed_inventory_rejects_symlinked_parent_or_file() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("model.onnx"), b"model-bytes").unwrap();
        symlink(outside.path(), root.path().join("models")).unwrap();
        let expected = vec![ExpectedInstalledFile {
            path: "models/model.onnx".into(),
            sha256: format!("{:x}", Sha256::digest(b"model-bytes")),
            size: 11,
        }];
        assert_eq!(
            verify_file_inventory(root.path(), &expected),
            Err(InstalledPackError::UnsafePath)
        );
    }
}
