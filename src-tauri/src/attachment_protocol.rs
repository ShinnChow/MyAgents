// Custom `myagents-resource://` URI scheme for binary attachment delivery.
//
// Regular user attachments are served directly from the app data directory.
// Tool attachments are proxied to the session sidecar because the sidecar owns
// the external-attachment registry and path validation logic.
//
// URL forms:
//   macOS / Linux: myagents-resource://attachment/<sessionId>/<filename.ext>
//   Windows:       http://myagents-resource.localhost/attachment/<sessionId>/<filename.ext>
//   macOS / Linux: myagents-resource://tool-attachment/<sessionId>/<turnId>/<filename.ext>
//   Windows:       http://myagents-resource.localhost/tool-attachment/<sessionId>/<turnId>/<filename.ext>
//
// The old `myagents://attachment` and `myagents://tool-attachment` forms are
// accepted only by the separately registered WebView compatibility handler.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::http::{Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

use crate::app_dirs::myagents_data_dir;
use crate::sidecar::ManagedSidecarManager;

fn attachments_root() -> Option<PathBuf> {
    myagents_data_dir().map(|d| d.join("attachments"))
}

fn mime_from_ext(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "txt" | "log" | "md" => "text/plain; charset=utf-8",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .body(Vec::new())
        .unwrap()
}

fn extract_path_after_marker(uri: &str, marker: &str) -> Option<String> {
    let idx = uri.find(marker)?;
    let rest = &uri[idx + marker.len()..];
    let rest = rest.split('?').next().unwrap_or(rest);
    let rest = rest.split('#').next().unwrap_or(rest);
    if rest.is_empty() {
        return None;
    }
    Some(percent_decode(rest))
}

fn extract_relative_path(uri: &str) -> Option<String> {
    extract_path_after_marker(uri, "://attachment/")
        .or_else(|| extract_path_after_marker(uri, "/attachment/"))
}

fn extract_tool_attachment_segments(uri: &str) -> Option<(String, String, String)> {
    let rel = extract_path_after_marker(uri, "://tool-attachment/")
        .or_else(|| extract_path_after_marker(uri, "/tool-attachment/"))?;
    let segments: Vec<&str> = rel.split('/').collect();
    if segments.len() != 3 || segments.iter().any(|segment| has_unsafe_segment(segment)) {
        return None;
    }
    Some((
        segments[0].to_string(),
        segments[1].to_string(),
        segments[2].to_string(),
    ))
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

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
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

fn build_attachment_response(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri_str = request.uri().to_string();
    let Some(rel) = extract_relative_path(&uri_str) else {
        return empty(StatusCode::NOT_FOUND);
    };

    let Some(root) = attachments_root() else {
        return empty(StatusCode::NOT_FOUND);
    };
    let candidate = root.join(&rel);

    let canonical = match candidate.canonicalize() {
        Ok(p) => p,
        Err(_) => return empty(StatusCode::NOT_FOUND),
    };
    let root_canonical = match root.canonicalize() {
        Ok(p) => p,
        Err(_) => return empty(StatusCode::NOT_FOUND),
    };
    if !canonical.starts_with(&root_canonical) {
        return empty(StatusCode::FORBIDDEN);
    }

    let bytes = match std::fs::read(&canonical) {
        Ok(b) => b,
        Err(_) => return empty(StatusCode::NOT_FOUND),
    };

    let mime = mime_from_ext(&canonical);
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", mime)
        .header("Content-Length", bytes.len().to_string())
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .unwrap()
}

fn build_tool_attachment_response(
    port: u16,
    session_id: &str,
    turn_id: &str,
    filename: &str,
) -> Response<Vec<u8>> {
    let url = format!(
        "http://127.0.0.1:{}/api/attachment/tool/{}/{}/{}",
        port,
        percent_encode_path_segment(session_id),
        percent_encode_path_segment(turn_id),
        percent_encode_path_segment(filename)
    );

    let client = match crate::local_http::blocking_builder()
        .timeout(Duration::from_secs(30))
        .build()
    {
        Ok(client) => client,
        Err(_) => return empty(StatusCode::BAD_GATEWAY),
    };

    let response = match client.get(url).send() {
        Ok(response) => response,
        Err(_) => return empty(StatusCode::BAD_GATEWAY),
    };

    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let cache_control = response
        .headers()
        .get(reqwest::header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let bytes = match response.bytes() {
        Ok(bytes) => bytes.to_vec(),
        Err(_) => return empty(StatusCode::BAD_GATEWAY),
    };

    let mut builder = Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        .header("Content-Length", bytes.len().to_string())
        .header("Access-Control-Allow-Origin", "*");
    if let Some(cache_control) = cache_control {
        builder = builder.header("Cache-Control", cache_control);
    }
    builder.body(bytes).unwrap()
}

fn session_sidecar_port<R: Runtime>(
    ctx: &UriSchemeContext<'_, R>,
    session_id: &str,
) -> Option<u16> {
    let manager = ctx.app_handle().try_state::<ManagedSidecarManager>()?;
    let mut guard = manager.lock().ok()?;
    guard.get_session_port(session_id)
}

/// Async URI scheme handler. File I/O and loopback HTTP run on Tauri's pooled
/// blocking executor so large reads never block the webview thread.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let uri_str = request.uri().to_string();
    if let Some((session_id, turn_id, filename)) = extract_tool_attachment_segments(&uri_str) {
        let port = session_sidecar_port(&ctx, &session_id);
        tauri::async_runtime::spawn_blocking(move || {
            let response = match port {
                Some(port) => {
                    build_tool_attachment_response(port, &session_id, &turn_id, &filename)
                }
                None => empty(StatusCode::NOT_FOUND),
            };
            responder.respond(response);
        });
        return;
    }

    tauri::async_runtime::spawn_blocking(move || {
        let response = build_attachment_response(&request);
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_macos_form() {
        let r = extract_relative_path("myagents-resource://attachment/abc/file.png").unwrap();
        assert_eq!(r, "abc/file.png");
    }

    #[test]
    fn extract_windows_form() {
        let r = extract_relative_path("http://myagents-resource.localhost/attachment/abc/file.png")
            .unwrap();
        assert_eq!(r, "abc/file.png");
    }

    #[test]
    fn strips_query_string() {
        let r = extract_relative_path("myagents-resource://attachment/abc/file.png?v=1").unwrap();
        assert_eq!(r, "abc/file.png");
    }

    #[test]
    fn percent_decodes_spaces() {
        assert_eq!(percent_decode("foo%20bar"), "foo bar");
    }

    #[test]
    fn rejects_non_attachment_uri() {
        assert!(extract_relative_path("myagents-resource://other/foo").is_none());
    }

    #[test]
    fn regular_attachment_rejects_tool_attachment_uri() {
        assert!(
            extract_relative_path("myagents-resource://tool-attachment/s/t/file.png").is_none()
        );
    }

    #[test]
    fn extracts_tool_macos_form() {
        let r =
            extract_tool_attachment_segments("myagents-resource://tool-attachment/s/t/file.png")
                .unwrap();
        assert_eq!(
            r,
            ("s".to_string(), "t".to_string(), "file.png".to_string())
        );
    }

    #[test]
    fn extracts_tool_windows_form() {
        let r = extract_tool_attachment_segments(
            "http://myagents-resource.localhost/tool-attachment/s/t/file.png",
        )
        .unwrap();
        assert_eq!(
            r,
            ("s".to_string(), "t".to_string(), "file.png".to_string())
        );
    }

    #[test]
    fn tool_attachment_rejects_unsafe_segment() {
        assert!(extract_tool_attachment_segments(
            "myagents-resource://tool-attachment/s/%2e%2e/file.png",
        )
        .is_none());
        assert!(extract_tool_attachment_segments(
            "myagents-resource://tool-attachment/s/t/bad%5Cname.png",
        )
        .is_none());
    }

    #[test]
    fn legacy_resource_forms_remain_webview_compatible() {
        assert_eq!(
            extract_relative_path("myagents://attachment/abc/file.png").as_deref(),
            Some("abc/file.png")
        );
        assert_eq!(
            extract_tool_attachment_segments("myagents://tool-attachment/s/t/file.png"),
            Some(("s".into(), "t".into(), "file.png".into()))
        );
        assert_eq!(
            extract_relative_path("http://myagents.localhost/attachment/abc/file.png").as_deref(),
            Some("abc/file.png")
        );
    }

    #[test]
    fn percent_encodes_path_segment() {
        assert_eq!(percent_encode_path_segment("a b.png"), "a%20b.png");
        assert_eq!(percent_encode_path_segment("a+b.png"), "a%2Bb.png");
    }
}
