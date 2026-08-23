use std::path::PathBuf;

use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::{
    authorized_multipart_data_request, normalized_avatar_upload_part, require_session,
    url_component, SpaceCommandResult,
};

const MAX_TOOL_ICON_INPUT_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpacePublishToolInput {
    pub space_id: String,
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub portable_mcp_manifest: Option<Value>,
    #[serde(default)]
    pub custom_install_instruction: Option<String>,
    #[serde(default)]
    pub icon_file_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceUpdateToolInput {
    pub tool_id: String,
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub portable_mcp_manifest: Option<Value>,
    #[serde(default)]
    pub custom_install_instruction: Option<String>,
    pub expected_latest_revision: u32,
    #[serde(default)]
    pub icon_file_path: Option<String>,
    #[serde(default)]
    pub reset_icon: bool,
}

fn required_text(value: &str, label: &str, max_chars: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is required"));
    }
    if trimmed.chars().count() > max_chars {
        return Err(format!("{label} exceeds {max_chars} characters"));
    }
    if trimmed.chars().any(|character| {
        character == '\0' || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    }) {
        return Err(format!("{label} contains unsupported control characters"));
    }
    Ok(trimmed.to_string())
}

fn optional_text(value: &str, label: &str, max_chars: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.chars().count() > max_chars {
        return Err(format!("{label} exceeds {max_chars} characters"));
    }
    if trimmed.chars().any(|character| {
        character == '\0' || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    }) {
        return Err(format!("{label} contains unsupported control characters"));
    }
    Ok(trimmed.to_string())
}

fn optional_icon_part(path: Option<&str>) -> Result<Option<reqwest::multipart::Part>, String> {
    let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) else {
        return Ok(None);
    };
    let file_path = PathBuf::from(path);
    Ok(Some(normalized_avatar_upload_part(
        &file_path,
        MAX_TOOL_ICON_INPUT_BYTES,
    )?))
}

fn tool_payload(
    kind: &str,
    name: &str,
    description: &str,
    portable_mcp_manifest: Option<Value>,
    custom_install_instruction: Option<&str>,
    expected_latest_revision: Option<u32>,
    reset_icon: bool,
) -> Result<Value, String> {
    let name = required_text(name, "Tool name", 100)?;
    let description = if kind == "mcp" {
        optional_text(description, "Tool description", 1_000)?
    } else {
        required_text(description, "Tool description", 1_000)?
    };
    let mut payload = Map::from_iter([
        ("kind".to_string(), json!(kind)),
        ("name".to_string(), json!(name)),
        ("description".to_string(), json!(description)),
    ]);
    match kind {
        "mcp" => {
            if custom_install_instruction.is_some() {
                return Err("MCP Tools cannot contain custom install instructions".to_string());
            }
            let manifest = portable_mcp_manifest
                .filter(Value::is_object)
                .ok_or_else(|| "Portable MCP manifest is required".to_string())?;
            payload.insert("portableMcpManifest".to_string(), manifest);
        }
        "custom_install_prompt" => {
            if portable_mcp_manifest.is_some() {
                return Err("Custom Tools cannot contain an MCP manifest".to_string());
            }
            let instruction = required_text(
                custom_install_instruction.unwrap_or_default(),
                "Tool install instruction",
                20_000,
            )?;
            payload.insert("customInstallInstruction".to_string(), json!(instruction));
        }
        _ => return Err("Unsupported Tool kind".to_string()),
    }
    if let Some(revision) = expected_latest_revision {
        payload.insert("expectedLatestRevision".to_string(), json!(revision));
    }
    if reset_icon {
        payload.insert("resetIcon".to_string(), json!(true));
    }
    Ok(Value::Object(payload))
}

fn multipart_form(
    payload: Value,
    icon: Option<reqwest::multipart::Part>,
) -> reqwest::multipart::Form {
    let mut form = reqwest::multipart::Form::new().text("payload", payload.to_string());
    if let Some(icon) = icon {
        form = form.part("file", icon);
    }
    form
}

#[tauri::command]
pub async fn cmd_space_publish_tool(input: SpacePublishToolInput) -> SpaceCommandResult<Value> {
    let space_id = required_text(&input.space_id, "Space id", 256)?;
    let payload = tool_payload(
        &input.kind,
        &input.name,
        &input.description,
        input.portable_mcp_manifest,
        input.custom_install_instruction.as_deref(),
        None,
        false,
    )?;
    let icon = optional_icon_part(input.icon_file_path.as_deref())?;
    let path = format!("/api/spaces/{}/tools", url_component(&space_id));
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::tool_multipart_mutation(&path, payload, icon.is_some())
            .map_err(Into::into);
    }
    let session = require_session()?;
    authorized_multipart_data_request(&session, &path, multipart_form(payload, icon)).await
}

#[tauri::command]
pub async fn cmd_space_update_tool(input: SpaceUpdateToolInput) -> SpaceCommandResult<Value> {
    let tool_id = required_text(&input.tool_id, "Tool id", 256)?;
    let payload = tool_payload(
        &input.kind,
        &input.name,
        &input.description,
        input.portable_mcp_manifest,
        input.custom_install_instruction.as_deref(),
        Some(input.expected_latest_revision),
        input.reset_icon,
    )?;
    let icon = optional_icon_part(input.icon_file_path.as_deref())?;
    if icon.is_some() && input.reset_icon {
        return Err("Cannot upload and reset a Tool icon together".into());
    }
    let path = format!("/api/tools/{}/revisions", url_component(&tool_id));
    if crate::space_cloud_mock::is_enabled() {
        return crate::space_cloud_mock::tool_multipart_mutation(&path, payload, icon.is_some())
            .map_err(Into::into);
    }
    let session = require_session()?;
    authorized_multipart_data_request(&session, &path, multipart_form(payload, icon)).await
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use image::{DynamicImage, GenericImageView, ImageFormat, RgbaImage};

    use super::*;

    #[test]
    fn custom_payload_rejects_empty_and_control_text() {
        assert!(tool_payload(
            "custom_install_prompt",
            "",
            "description",
            None,
            Some("install"),
            None,
            false,
        )
        .is_err());
        assert!(tool_payload(
            "custom_install_prompt",
            "Tool",
            "description",
            None,
            Some("bad\0instruction"),
            None,
            false,
        )
        .is_err());
    }

    #[test]
    fn tool_payload_keeps_only_the_cloud_contract_fields() {
        let payload = tool_payload(
            "custom_install_prompt",
            " Tool ",
            " Description ",
            None,
            Some(" Install "),
            Some(7),
            true,
        )
        .expect("payload");
        assert_eq!(
            payload,
            json!({
                "kind": "custom_install_prompt",
                "name": "Tool",
                "description": "Description",
                "customInstallInstruction": "Install",
                "expectedLatestRevision": 7,
                "resetIcon": true,
            })
        );

        let manifest = json!({
            "schemaVersion": 1,
            "serverId": "中文-mcp",
            "transport": "stdio",
            "stdio": { "command": "npx", "args": [], "envTemplates": {} },
            "requiredConfigKeys": [],
        });
        assert_eq!(
            tool_payload(
                "mcp",
                " MCP ",
                "",
                Some(manifest.clone()),
                None,
                None,
                false,
            )
            .expect("MCP payload"),
            json!({
                "kind": "mcp",
                "name": "MCP",
                "description": "",
                "portableMcpManifest": manifest,
            })
        );
    }

    #[test]
    fn tool_icon_rejects_relative_and_oversized_inputs() {
        assert!(optional_icon_part(Some("relative.png")).is_err());

        let dir = tempfile::tempdir().expect("Tool icon tempdir");
        let oversized = dir.path().join("oversized.png");
        std::fs::write(&oversized, vec![0; MAX_TOOL_ICON_INPUT_BYTES as usize + 1])
            .expect("write oversized icon");
        assert!(optional_icon_part(oversized.to_str()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn tool_icon_rejects_symlinks() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().expect("Tool icon tempdir");
        let source = dir.path().join("source.png");
        std::fs::write(&source, b"not decoded because the symlink fails first")
            .expect("write icon source");
        let link = dir.path().join("link.png");
        symlink(&source, &link).expect("create icon symlink");
        assert!(optional_icon_part(link.to_str()).is_err());
    }

    #[test]
    fn tool_icon_normalization_bounds_dimensions_and_output_size() {
        let input = DynamicImage::ImageRgba8(RgbaImage::from_pixel(
            800,
            400,
            image::Rgba([120, 80, 40, 255]),
        ));
        let mut png = Vec::new();
        input
            .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
            .expect("encode source png");

        let webp = super::super::normalize_avatar_bytes_to_webp(&png).expect("normalize Tool icon");
        let decoded = image::load_from_memory_with_format(&webp, ImageFormat::WebP)
            .expect("decode normalized webp");
        assert!(decoded.dimensions().0 <= 256);
        assert!(decoded.dimensions().1 <= 256);
        assert!(webp.len() <= super::super::NORMALIZED_AVATAR_MAX_BYTES);
    }
}
