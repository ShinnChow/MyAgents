//! User message attachment preparation.
//!
//! Tauri owns OS path reads. For image drops that should remain visual
//! attachments, copy bytes from the external path into the app-owned
//! `~/.myagents/attachments/<session>/` store and return only a relative ref
//! to the renderer. The renderer then sends the ref to Sidecar instead of
//! pushing large base64 through IPC/JSON.

use std::path::Path;

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::app_dirs::myagents_data_dir;

use super::path_safety::{sanitize_filename, validate_external_read_path};

const MAX_USER_IMAGE_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024;

const ALLOWED_IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedUserImageAttachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    /// Relative path under `~/.myagents/attachments/`, suitable for
    /// `myagents-resource://attachment/<relativePath>`.
    pub relative_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareUserImageAttachmentError {
    pub path: String,
    pub name: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareUserImageAttachmentsResponse {
    pub success: bool,
    pub attachments: Vec<PreparedUserImageAttachment>,
    pub errors: Vec<PrepareUserImageAttachmentError>,
}

#[tauri::command]
pub async fn cmd_prepare_user_image_attachments(
    session_id: String,
    paths: Vec<String>,
) -> Result<PrepareUserImageAttachmentsResponse, String> {
    if paths.is_empty() {
        return Err("paths is required".to_string());
    }
    validate_session_segment(&session_id)?;

    let mut attachments = Vec::with_capacity(paths.len());
    let mut errors = Vec::new();

    for path in paths {
        match prepare_one_user_image_attachment(&session_id, &path).await {
            Ok(item) => attachments.push(item),
            Err(err) => errors.push(err),
        }
    }

    Ok(PrepareUserImageAttachmentsResponse {
        success: true,
        attachments,
        errors,
    })
}

async fn prepare_one_user_image_attachment(
    session_id: &str,
    raw_path: &str,
) -> Result<PreparedUserImageAttachment, PrepareUserImageAttachmentError> {
    let name = Path::new(raw_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let safe_name = sanitize_filename(&name);

    let make_err = |code: &str, message: String| PrepareUserImageAttachmentError {
        path: raw_path.to_string(),
        name: name.clone(),
        code: code.to_string(),
        message,
    };

    let ext = Path::new(raw_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());

    match ext.as_deref() {
        Some(e) if ALLOWED_IMAGE_EXTS.contains(&e) => {}
        _ => {
            return Err(make_err(
                "invalid_type",
                "Only image files are allowed".to_string(),
            ))
        }
    }

    let resolved = validate_external_read_path(raw_path)
        .map_err(|e| make_err("access_denied", format!("Access denied: {}", e)))?;

    let symlink_meta = tokio::fs::symlink_metadata(&resolved)
        .await
        .map_err(|_| make_err("not_found", "File not found".to_string()))?;
    if symlink_meta.is_symlink() {
        return Err(make_err("symlink", "Symlinks are not allowed".to_string()));
    }
    if !symlink_meta.is_file() {
        return Err(make_err("not_regular", "Not a regular file".to_string()));
    }
    if symlink_meta.len() > MAX_USER_IMAGE_ATTACHMENT_BYTES {
        return Err(make_err(
            "too_large",
            "File too large (max 10MB)".to_string(),
        ));
    }

    let mut file = tokio::fs::File::open(&resolved)
        .await
        .map_err(|e| make_err("open_failed", format!("Open failed: {}", e)))?;
    let mut bytes = Vec::with_capacity(symlink_meta.len() as usize);
    if let Err(e) = (&mut file)
        .take(MAX_USER_IMAGE_ATTACHMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .await
    {
        return Err(make_err("read_failed", format!("Read failed: {}", e)));
    }
    if bytes.len() as u64 > MAX_USER_IMAGE_ATTACHMENT_BYTES {
        return Err(make_err(
            "too_large",
            "File too large (max 10MB)".to_string(),
        ));
    }

    let Some(data_dir) = myagents_data_dir() else {
        return Err(make_err(
            "storage_unavailable",
            "MyAgents data directory is unavailable".to_string(),
        ));
    };
    let session_dir = data_dir.join("attachments").join(session_id);
    tokio::fs::create_dir_all(&session_dir).await.map_err(|e| {
        make_err(
            "write_failed",
            format!("Failed to create attachment dir: {}", e),
        )
    })?;

    let id = uuid::Uuid::new_v4().to_string();
    let ext_for_file =
        extension_for_mime_or_source(&mime_for_ext(ext.as_deref().unwrap_or("")), ext.as_deref());
    let file_name = format!("{}.{}", id, ext_for_file);
    let target = session_dir.join(&file_name);
    let mut out = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .await
        .map_err(|e| {
            make_err(
                "write_failed",
                format!("Failed to create attachment: {}", e),
            )
        })?;
    out.write_all(&bytes)
        .await
        .map_err(|e| make_err("write_failed", format!("Failed to write attachment: {}", e)))?;
    out.flush()
        .await
        .map_err(|e| make_err("write_failed", format!("Failed to flush attachment: {}", e)))?;

    Ok(PreparedUserImageAttachment {
        id,
        name: safe_name,
        mime_type: mime_for_ext(ext.as_deref().unwrap_or("")),
        size_bytes: bytes.len() as u64,
        relative_path: format!("{}/{}", session_id, file_name),
    })
}

fn validate_session_segment(segment: &str) -> Result<(), String> {
    if segment.is_empty()
        || segment == "."
        || segment == ".."
        || segment.contains("..")
        || segment.contains('/')
        || segment.contains('\\')
        || segment.chars().any(|ch| ch < ' ')
    {
        return Err("Invalid session id for attachment path".to_string());
    }
    Ok(())
}

fn mime_for_ext(ext: &str) -> String {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "tiff" | "tif" => "image/tiff",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn extension_for_mime_or_source(mime: &str, source_ext: Option<&str>) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpeg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/bmp" => "bmp",
        "image/x-icon" => "ico",
        "image/tiff" => "tiff",
        "image/avif" => "avif",
        _ => match source_ext {
            Some("jpg") => "jpg",
            Some("jpeg") => "jpeg",
            Some("png") => "png",
            Some("gif") => "gif",
            Some("webp") => "webp",
            _ => "bin",
        },
    }
}
