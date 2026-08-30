//! Shared verification for first-party downloadable resource manifests.
//!
//! The public key is intentionally the same trust root used by the Tauri app
//! updater. Resource owners may reuse this verifier, but they still own their
//! manifest schema, download allowlist, staging, and activation lifecycle.

use base64::{engine::general_purpose, Engine as _};
use minisign_verify::{Error as MinisignError, PublicKey, Signature};
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

// Keep this in sync with `tauri.conf.json > plugins.updater.pubkey`.
pub(crate) const MYAGENTS_MINISIGN_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEY3RkQ5QjIzMTE4RTgyRTkKUldUcGdvNFJJNXY5OTB3T2pnUzVUbjFrV203Zk5ZTDg0NVJRdGI0UVRranJzTUsvM0hGcmFlc0IK";

fn decode_base64_text(value: &str, label: &str) -> Result<String, String> {
    let bytes = general_purpose::STANDARD
        .decode(value)
        .map_err(|error| format!("invalid {label} base64: {error}"))?;
    String::from_utf8(bytes).map_err(|error| format!("invalid {label} UTF-8: {error}"))
}

fn public_key() -> Result<PublicKey, String> {
    let decoded = decode_base64_text(MYAGENTS_MINISIGN_PUBKEY, "public key")?;
    PublicKey::decode(&decoded).map_err(|error| format!("invalid minisign public key: {error}"))
}

fn signature(value: &str, label: &str) -> Result<Signature, String> {
    let decoded = decode_base64_text(value, label)?;
    Signature::decode(&decoded).map_err(|error| format!("invalid {label}: {error}"))
}

pub(crate) fn verify_minisign_bytes(
    bytes: &[u8],
    signature_value: &str,
    label: &str,
) -> Result<(), String> {
    let public_key = public_key()?;
    let signature = signature(signature_value, label)?;
    public_key
        .verify(bytes, &signature, true)
        .map_err(|error| format!("{label} signature mismatch: {error}"))
}

pub(crate) fn verify_minisign_file(path: &Path, signature_value: &str) -> Result<(), String> {
    let public_key = public_key()?;
    let signature = signature(signature_value, "artifact signature")?;
    match public_key.verify_stream(&signature) {
        Ok(mut verifier) => {
            let mut file = File::open(path).map_err(|error| format!("open artifact: {error}"))?;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = file
                    .read(&mut buffer)
                    .map_err(|error| format!("read artifact: {error}"))?;
                if read == 0 {
                    break;
                }
                verifier.update(&buffer[..read]);
            }
            verifier
                .finalize()
                .map_err(|error| format!("artifact signature mismatch: {error}"))
        }
        Err(MinisignError::UnsupportedLegacyMode) => {
            let bytes = fs::read(path).map_err(|error| format!("read artifact: {error}"))?;
            public_key
                .verify(&bytes, &signature, true)
                .map_err(|error| format!("artifact signature mismatch: {error}"))
        }
        Err(error) => Err(format!(
            "cannot initialize artifact signature verifier: {error}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_pubkey_matches_tauri_updater_pubkey() {
        let conf_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let content = fs::read_to_string(conf_path).expect("tauri.conf.json");
        let json: serde_json::Value = serde_json::from_str(&content).expect("valid tauri config");
        let updater_pubkey = json
            .get("plugins")
            .and_then(|value| value.get("updater"))
            .and_then(|value| value.get("pubkey"))
            .and_then(|value| value.as_str())
            .expect("updater pubkey");
        assert_eq!(updater_pubkey, MYAGENTS_MINISIGN_PUBKEY);
    }
}
