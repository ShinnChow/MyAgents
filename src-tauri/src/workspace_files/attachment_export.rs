//! Read/export tool attachments through the same trusted endpoint used for
//! rendering.
//!
//! Renderer-side attachment objects may carry absolute `savedPath` values for
//! diagnostics, but those paths are not the authority for byte access. The
//! authority is `refPath` plus the live session sidecar, which owns the
//! external-path registry and validates every served attachment.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::State;

use crate::commands::validate_file_path;
use crate::sidecar::ManagedSidecarManager;

const MAX_EXPORT_BYTES: u64 = 25 * 1024 * 1024;
const TOOL_ATTACHMENT_API_PREFIX: &str = "/api/attachment/tool/";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportToolAttachmentResult {
    pub destination_path: String,
    pub bytes: u64,
}

struct AttachmentRequest {
    url: String,
}

#[tauri::command]
pub async fn cmd_export_tool_attachment(
    state: State<'_, ManagedSidecarManager>,
    ref_path: String,
    destination_path: String,
) -> Result<ExportToolAttachmentResult, String> {
    let request = resolve_attachment_request(&state, &ref_path)?;
    let destination = validate_export_destination(&destination_path)?;
    let fetched = fetch_attachment_bytes(request).await?;

    write_export_file(&destination, &fetched.bytes)?;

    Ok(ExportToolAttachmentResult {
        destination_path: destination.to_string_lossy().to_string(),
        bytes: fetched.bytes.len() as u64,
    })
}

#[tauri::command]
pub async fn cmd_read_tool_attachment_bytes(
    state: State<'_, ManagedSidecarManager>,
    ref_path: String,
) -> Result<tauri::ipc::Response, String> {
    let request = resolve_attachment_request(&state, &ref_path)?;
    let fetched = fetch_attachment_bytes(request).await?;
    Ok(tauri::ipc::Response::new(fetched.bytes))
}

fn resolve_attachment_request(
    state: &State<'_, ManagedSidecarManager>,
    ref_path: &str,
) -> Result<AttachmentRequest, String> {
    let parsed = parse_tool_attachment_ref_path(ref_path)?;
    let port = {
        let mut manager = state.lock().map_err(|e| e.to_string())?;
        manager
            .get_session_port(&parsed.session_id)
            .ok_or_else(|| "Attachment session sidecar is not running".to_string())?
    };

    Ok(AttachmentRequest {
        url: format!(
            "http://127.0.0.1:{}/api/attachment/tool/{}/{}/{}",
            port,
            percent_encode_path_segment(&parsed.session_id),
            percent_encode_path_segment(&parsed.turn_id),
            percent_encode_path_segment(&parsed.filename)
        ),
    })
}

struct ParsedToolAttachmentRef {
    session_id: String,
    turn_id: String,
    filename: String,
}

fn parse_tool_attachment_ref_path(raw: &str) -> Result<ParsedToolAttachmentRef, String> {
    let trimmed = raw.trim();
    let Some(rest) = trimmed.strip_prefix(TOOL_ATTACHMENT_API_PREFIX) else {
        return Err("Invalid attachment refPath".to_string());
    };
    if rest.contains('?') || rest.contains('#') {
        return Err("Invalid attachment refPath".to_string());
    }
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() != 3 {
        return Err("Invalid attachment refPath".to_string());
    }

    let session_id = percent_decode_strict(parts[0])?;
    let turn_id = percent_decode_strict(parts[1])?;
    let filename = percent_decode_strict(parts[2])?;
    if [&session_id, &turn_id, &filename]
        .iter()
        .any(|segment| has_unsafe_segment(segment))
    {
        return Err("Unsafe attachment refPath".to_string());
    }

    Ok(ParsedToolAttachmentRef {
        session_id,
        turn_id,
        filename,
    })
}

struct FetchedAttachment {
    bytes: Vec<u8>,
}

async fn fetch_attachment_bytes(request: AttachmentRequest) -> Result<FetchedAttachment, String> {
    let client = crate::local_http::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to create attachment HTTP client: {}", e))?;
    let response = client
        .get(request.url)
        .send()
        .await
        .map_err(|e| format!("Failed to read attachment: {}", e))?;
    if !response.status().is_success() {
        return Err(format!(
            "Attachment endpoint returned {}",
            response.status()
        ));
    }
    if let Some(len) = response.content_length() {
        if len > MAX_EXPORT_BYTES {
            return Err(format!(
                "Attachment too large to export (max {} MB)",
                MAX_EXPORT_BYTES / 1024 / 1024
            ));
        }
    }
    let mut bytes =
        Vec::with_capacity(response.content_length().unwrap_or(0).min(MAX_EXPORT_BYTES) as usize);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Failed to read attachment body: {}", e))?;
        if bytes.len() as u64 + chunk.len() as u64 > MAX_EXPORT_BYTES {
            return Err(format!(
                "Attachment too large to export (max {} MB)",
                MAX_EXPORT_BYTES / 1024 / 1024
            ));
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(FetchedAttachment { bytes })
}

pub(crate) fn validate_export_destination(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("destinationPath is required".to_string());
    }

    let lexical_destination = validate_file_path(trimmed)?;
    let file_name = lexical_destination
        .file_name()
        .ok_or_else(|| "Destination filename is invalid".to_string())?;
    let parent = lexical_destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "Destination parent directory is invalid".to_string())?;
    let canonical_parent = validate_existing_parent(parent)?;
    let destination = canonical_parent.join(file_name);

    match fs::symlink_metadata(&destination) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err("Destination cannot be a symlink".to_string());
            }
            if !meta.is_file() {
                return Err("Destination is not a regular file".to_string());
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Destination is not accessible: {}", e)),
    }

    Ok(destination)
}

fn validate_existing_parent(parent: &Path) -> Result<PathBuf, String> {
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|_| "Destination parent directory does not exist".to_string())?;
    let parent_str = canonical_parent
        .to_str()
        .ok_or_else(|| "Destination parent path is not valid UTF-8".to_string())?;
    let _ = validate_file_path(parent_str)?;
    let meta = fs::symlink_metadata(&canonical_parent)
        .map_err(|_| "Destination parent directory does not exist".to_string())?;
    if !meta.is_dir() {
        return Err("Destination parent is not a directory".to_string());
    }
    Ok(canonical_parent)
}

fn write_export_file(destination: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "Destination parent directory is invalid".to_string())?;
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Destination filename is invalid".to_string())?;

    for nonce in 0..100u32 {
        let tmp_path = parent.join(format!(
            ".{}.myagents-export-{}-{}.tmp",
            file_name,
            std::process::id(),
            nonce
        ));
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Failed to create export temp file: {}", e)),
        };

        if let Err(e) = file.write_all(bytes) {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("Failed to save attachment: {}", e));
        }
        if let Err(e) = file.sync_all() {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("Failed to flush attachment: {}", e));
        }
        drop(file);

        if let Err(e) = fs::rename(&tmp_path, destination) {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!("Failed to finalize attachment export: {}", e));
        }
        return Ok(());
    }

    Err("Failed to allocate export temp file".to_string())
}

fn has_unsafe_segment(segment: &str) -> bool {
    segment.is_empty()
        || segment == "."
        || segment == ".."
        || segment.contains("..")
        || segment
            .chars()
            .any(|ch| ch < ' ' || ch == '/' || ch == '\\')
}

fn percent_decode_strict(input: &str) -> Result<String, String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("Malformed attachment refPath".to_string());
            }
            let h = hex(bytes[i + 1]).ok_or_else(|| "Malformed attachment refPath".to_string())?;
            let l = hex(bytes[i + 2]).ok_or_else(|| "Malformed attachment refPath".to_string())?;
            out.push((h << 4) | l);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).map_err(|_| "Malformed attachment refPath".to_string())
}

fn percent_encode_path_segment(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for &byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_ref_path() {
        let parsed =
            parse_tool_attachment_ref_path("/api/attachment/tool/session-a/turn-b/image.png")
                .unwrap();
        assert_eq!(parsed.session_id, "session-a");
        assert_eq!(parsed.turn_id, "turn-b");
        assert_eq!(parsed.filename, "image.png");
    }

    #[test]
    fn parses_encoded_filename_space() {
        let parsed =
            parse_tool_attachment_ref_path("/api/attachment/tool/session-a/turn-b/image%201.png")
                .unwrap();
        assert_eq!(parsed.filename, "image 1.png");
        assert_eq!(
            percent_encode_path_segment(&parsed.filename),
            "image%201.png"
        );
    }

    #[test]
    fn rejects_traversal_segments() {
        assert!(
            parse_tool_attachment_ref_path("/api/attachment/tool/session-a/%2e%2e/image.png")
                .is_err()
        );
        assert!(parse_tool_attachment_ref_path(
            "/api/attachment/tool/session-a/turn-b/bad%5Cname.png"
        )
        .is_err());
    }
}
