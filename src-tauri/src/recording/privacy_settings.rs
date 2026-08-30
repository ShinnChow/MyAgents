//! Trusted OS navigation for recording privacy settings.

use crate::{process_cmd, ulog_warn};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Platform {
    #[cfg(any(target_os = "macos", test))]
    Macos,
    #[cfg(any(target_os = "windows", test))]
    Windows,
    #[cfg(any(not(any(target_os = "macos", target_os = "windows")), test))]
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PrivacySettingsTarget {
    program: &'static str,
    argument: &'static str,
}

fn current_platform() -> Platform {
    #[cfg(target_os = "macos")]
    {
        Platform::Macos
    }
    #[cfg(target_os = "windows")]
    {
        Platform::Windows
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Platform::Unsupported
    }
}

fn privacy_settings_target(source: &str, platform: Platform) -> Option<PrivacySettingsTarget> {
    match (platform, source) {
        #[cfg(any(target_os = "macos", test))]
        (Platform::Macos, "microphone") => Some(PrivacySettingsTarget {
            program: "/usr/bin/open",
            argument: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        }),
        #[cfg(any(target_os = "macos", test))]
        (Platform::Macos, "system") => Some(PrivacySettingsTarget {
            program: "/usr/bin/open",
            argument:
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        }),
        #[cfg(any(target_os = "windows", test))]
        (Platform::Windows, "microphone") => Some(PrivacySettingsTarget {
            program: "explorer.exe",
            argument: "ms-settings:privacy-microphone",
        }),
        _ => None,
    }
}

#[tauri::command]
pub async fn cmd_open_recording_privacy_settings(source: String) -> Result<(), String> {
    let target = privacy_settings_target(source.as_str(), current_platform())
        .ok_or_else(|| "Recording privacy settings are unavailable for this source".to_string())?;

    let status = tauri::async_runtime::spawn_blocking(move || {
        process_cmd::new(target.program)
            .arg(target.argument)
            .status()
    })
    .await
    .map_err(|error| {
        ulog_warn!("[recording] privacy settings opener task failed: {}", error);
        "Failed to open recording privacy settings".to_string()
    })?
    .map_err(|error| {
        ulog_warn!("[recording] failed to open privacy settings: {}", error);
        "Failed to open recording privacy settings".to_string()
    })?;

    if status.success() {
        Ok(())
    } else {
        ulog_warn!(
            "[recording] privacy settings opener exited unsuccessfully: {:?}",
            status.code()
        );
        Err("Failed to open recording privacy settings".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privacy_settings_targets_are_exact_and_fail_closed() {
        assert_eq!(
            privacy_settings_target("microphone", Platform::Macos),
            Some(PrivacySettingsTarget {
                program: "/usr/bin/open",
                argument:
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
            })
        );
        assert_eq!(
            privacy_settings_target("system", Platform::Macos),
            Some(PrivacySettingsTarget {
                program: "/usr/bin/open",
                argument:
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            })
        );
        assert_eq!(
            privacy_settings_target("microphone", Platform::Windows),
            Some(PrivacySettingsTarget {
                program: "explorer.exe",
                argument: "ms-settings:privacy-microphone",
            })
        );
        assert_eq!(privacy_settings_target("system", Platform::Windows), None);
        assert_eq!(
            privacy_settings_target("microphone", Platform::Unsupported),
            None
        );
        assert_eq!(privacy_settings_target("arbitrary", Platform::Macos), None);
    }
}
