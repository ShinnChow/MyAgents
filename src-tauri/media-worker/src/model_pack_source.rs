use serde::Deserialize;
use std::collections::{HashMap, HashSet};

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
        || lock.pack_revision != "sensevoice-2024-07-17-v1"
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
            || !valid_https_source_url(&asset.url)
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
        if legal.id.trim().is_empty()
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
                if !valid_https_source_url(url)
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

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_https_source_url(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split('/').next().unwrap_or_default();
    matches!(host, "github.com" | "raw.githubusercontent.com")
        && !rest.contains(['\\', '\0'])
        && !rest.split('/').any(|part| matches!(part, "." | ".."))
}

fn safe_relative_path(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('/')
        && !value.contains(['\\', '\0'])
        && value
            .split('/')
            .all(|part| !part.is_empty() && !matches!(part, "." | ".."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn committed_source_lock_has_exact_models_sizes_licenses_and_signature_policy() {
        validate_source_lock_json(MODEL_PACK_SOURCE_LOCK).unwrap();
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
        let host =
            MODEL_PACK_SOURCE_LOCK.replacen("https://github.com/", "https://example.com/", 1);
        assert_eq!(
            validate_source_lock_json(&host),
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
}
