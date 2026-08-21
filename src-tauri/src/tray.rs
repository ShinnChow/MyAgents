// System tray implementation for MyAgents
// Provides minimize-to-tray functionality and right-click menu

use serde::Deserialize;
use std::fs;
#[cfg(target_os = "macos")]
use tauri::image::Image;
use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, Runtime, Wry,
};

use crate::utils::bom::strip_bom;
use crate::{ulog_debug, ulog_error, ulog_info, ulog_warn};

/// Menu item IDs for tray right-click menu
const MENU_OPEN: &str = "open";
const MENU_SETTINGS: &str = "settings";
const MENU_FORCE_WAKE_LOCK: &str = "force_wake_lock";
const MENU_EXIT: &str = "exit";
const MAIN_WINDOW_PRESENTATION_EVENT: &str = "main-window:presentation-changed";

fn emit_main_window_presentation<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    surface_available: bool,
) {
    if let Err(error) = window.emit(MAIN_WINDOW_PRESENTATION_EVENT, surface_available) {
        ulog_warn!(
            "[Tray] Failed to emit main-window presentation={} error={}",
            surface_available,
            error
        );
    }
}

/// Tray-menu items whose check state we need to mutate at runtime
/// (PRD 0.2.35 D4: handle MUST live in app state so `apply_force_wake_lock`
/// can call `set_checked()` from any thread — `CheckMenuItem::set_checked`
/// internally marshals onto the main thread via `run_item_main_thread!`,
/// so any-thread access is safe).
///
/// Non-generic over Runtime: production uses `Wry` everywhere; pinning the
/// type here avoids dragging an `R: Runtime` parameter through every consumer.
pub struct TrayMenuHandles {
    // Keep the tray icon handle alive for the lifetime of the app; macOS also
    // reads it to update the menu-bar badge/title.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub tray: TrayIcon<Wry>,
    pub open: MenuItem<Wry>,
    pub settings: MenuItem<Wry>,
    pub force_wake_lock: CheckMenuItem<Wry>,
    pub exit: MenuItem<Wry>,
}

/// Initialize the system tray with icon and menu.
///
/// Pinned to `Wry` because production runs on Wry and `TrayMenuHandles` stores
/// `CheckMenuItem<Wry>` non-generically. All callers pass `&mut App<Wry>`.
pub fn setup_tray(app: &tauri::App<Wry>) -> Result<(), Box<dyn std::error::Error>> {
    let locale = crate::i18n::current_locale();
    // Build the tray menu
    let open_item =
        MenuItemBuilder::with_id(MENU_OPEN, crate::i18n::t("tray.open", locale)).build(app)?;
    let settings_item =
        MenuItemBuilder::with_id(MENU_SETTINGS, crate::i18n::t("tray.settings", locale))
            .build(app)?;
    // PRD 0.2.35 — global force wake-lock toggle. Initial check state mirrors
    // disk truth (`config.json::forceWakeLock`). The CheckMenuItem handle is
    // managed (below) so `apply_force_wake_lock` can call `set_checked()` when
    // the value changes from the Settings page.
    let initial_force_wl = crate::wake_lock::should_force_wake_lock();
    let force_wake_lock_item: CheckMenuItem<Wry> = CheckMenuItemBuilder::with_id(
        MENU_FORCE_WAKE_LOCK,
        crate::i18n::t("tray.forceWakeLock", locale),
    )
    .checked(initial_force_wl)
    .build(app)?;
    let exit_item =
        MenuItemBuilder::with_id(MENU_EXIT, crate::i18n::t("tray.exit", locale)).build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&open_item)
        .item(&settings_item)
        .separator()
        .item(&force_wake_lock_item)
        .separator()
        .item(&exit_item)
        .build()?;

    // Load tray icon - use template icon on macOS for proper menu bar appearance
    #[cfg(target_os = "macos")]
    let tray_icon = {
        // Load template icon from embedded bytes (22x22 for best menu bar appearance)
        let icon_bytes = include_bytes!("../icons/trayIconTemplate@2x.png");
        Image::from_bytes(icon_bytes).unwrap_or_else(|_| {
            ulog_warn!("[Tray] Failed to load template icon, using default");
            app.default_window_icon().unwrap().clone()
        })
    };

    #[cfg(not(target_os = "macos"))]
    let tray_icon = app.default_window_icon().unwrap().clone();

    // Build the tray icon
    let tray_builder = TrayIconBuilder::new()
        .icon(tray_icon)
        .menu(&menu)
        .tooltip("MyAgents")
        .show_menu_on_left_click(false);

    // On macOS, mark as template image so system can adjust colors for light/dark mode
    #[cfg(target_os = "macos")]
    let tray_builder = tray_builder.icon_as_template(true);

    let tray = tray_builder
        .on_menu_event(move |app, event| {
            match event.id().as_ref() {
                MENU_OPEN => {
                    ulog_info!("[Tray] Open menu clicked");
                    show_main_window(app);
                }
                MENU_SETTINGS => {
                    ulog_info!("[Tray] Settings menu clicked");
                    show_main_window(app);
                    // Emit event to navigate to settings
                    if let Err(e) = app.emit("tray:open-settings", ()) {
                        ulog_error!("[Tray] Failed to emit settings event: {}", e);
                    }
                }
                MENU_FORCE_WAKE_LOCK => {
                    // PRD 0.2.35 D2: the same `apply_force_wake_lock` chokepoint
                    // serves both the Settings page (via `cmd_set_force_wake_lock`)
                    // and the tray click.
                    //
                    // ⚠️ Subtle (codex review BLOCKING #1, 2026-06-13): muda's
                    // platform impls for `CheckMenuItem` *auto-toggle* the
                    // visible check state BEFORE sending `MenuEvent::send`. We
                    // verified this in:
                    //   - macOS  ~/.cargo/registry/.../muda-0.17.2/src/platform_impl/macos/mod.rs:1124
                    //              `item.set_checked(!item.is_checked());`
                    //   - Windows ~/.cargo/.../muda-0.17.2/src/platform_impl/windows/mod.rs
                    //              `let checked = !item.checked; item.set_checked(checked);`
                    //   - GTK    GTK's own `gtk::CheckMenuItem` flips `is_active`
                    //              before firing `activate` (which is what muda
                    //              forwards as `MenuEvent`).
                    //
                    // So by the time we reach this handler, `is_checked()` already
                    // reflects the user's intended NEW value — applying `!cur`
                    // would silently reverse the click. Read it straight.
                    //
                    // The fallback for "handle missing" (shouldn't happen
                    // post-setup) reads disk for the OLD value and inverts; the
                    // tray hasn't auto-toggled anything we can read in that
                    // fallback because the handle isn't there to ask.
                    let new_value = match app
                        .try_state::<TrayMenuHandles>()
                        .and_then(|h| h.force_wake_lock.is_checked().ok())
                    {
                        Some(post_toggle) => post_toggle,
                        None => !crate::wake_lock::should_force_wake_lock(),
                    };
                    ulog_info!("[Tray] Force wake-lock toggled to {}", new_value);
                    // `apply_force_wake_lock` does fs IO via `with_config_lock`
                    // (sync, blocking). The Tauri menu event runs on the main
                    // thread; offload to keep the menu loop responsive.
                    let app_for_apply = app.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        crate::wake_lock::apply_force_wake_lock(&app_for_apply, new_value);
                    });
                }
                MENU_EXIT => {
                    ulog_info!("[Tray] Exit menu clicked");
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // Left click on tray icon shows the window
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                ulog_info!("[Tray] Tray icon left-clicked");
                let app = tray.app_handle();
                show_main_window(app);
            }
        })
        .build(app)?;

    // Store tray/menu handles in app state so runtime mirrors can mutate them
    // from any thread. Tauri marshals the actual tray updates onto the main
    // thread internally.
    app.manage(TrayMenuHandles {
        tray,
        open: open_item,
        settings: settings_item,
        force_wake_lock: force_wake_lock_item,
        exit: exit_item,
    });

    ulog_info!("[Tray] System tray initialized successfully");
    Ok(())
}

pub fn apply_tray_locale<R: Runtime>(
    app: &tauri::AppHandle<R>,
    locale: crate::i18n::SupportedLocale,
) {
    let Some(handles) = app.try_state::<TrayMenuHandles>() else {
        ulog_debug!("[Tray] apply locale skipped; tray handles not registered");
        return;
    };
    if let Err(e) = handles.open.set_text(crate::i18n::t("tray.open", locale)) {
        ulog_error!("[Tray] Failed to update open label: {}", e);
    }
    if let Err(e) = handles
        .settings
        .set_text(crate::i18n::t("tray.settings", locale))
    {
        ulog_error!("[Tray] Failed to update settings label: {}", e);
    }
    if let Err(e) = handles
        .force_wake_lock
        .set_text(crate::i18n::t("tray.forceWakeLock", locale))
    {
        ulog_error!("[Tray] Failed to update force wake-lock label: {}", e);
    }
    if let Err(e) = handles.exit.set_text(crate::i18n::t("tray.exit", locale)) {
        ulog_error!("[Tray] Failed to update exit label: {}", e);
    }
}

/// Show the main window (and focus it).
///
/// Single canonical "bring to foreground" routine. Reused by:
/// - tray icon left-click / "Open" menu
/// - `single_instance` plugin's second-instance callback (lib.rs)
/// - `notification` module's click handler (Windows toast Activated event)
///
/// Pit-of-success: one helper, three callers; new entry points MUST call this
/// rather than re-deriving show + unminimize + set_focus.
pub fn show_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let before_visible = window.is_visible().unwrap_or(false);
        let before_focused = window.is_focused().unwrap_or(false);
        ulog_info!(
            "[Tray] show_main_window begin visible={} focused={}",
            before_visible,
            before_focused
        );
        let show_result = window.show();
        let unminimize_result = window.unminimize();
        let focus_result = window.set_focus();
        let surface_available =
            window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
        emit_main_window_presentation(&window, surface_available);
        ulog_info!(
            "[Tray] show_main_window end show_ok={} unminimize_ok={} focus_ok={} visible={} focused={}",
            show_result.is_ok(),
            unminimize_result.is_ok(),
            focus_result.is_ok(),
            window.is_visible().unwrap_or(false),
            window.is_focused().unwrap_or(false)
        );
    } else {
        ulog_warn!("[Tray] show_main_window requested but main window is missing");
    }
}

/// Hide the main window and synchronously publish the unavailable edge before
/// WebView delivery can be suspended. All Rust-owned hide entry points must use
/// this helper so a quick hide→show cannot collapse into one async JS sample.
pub fn hide_main_window<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window is missing".to_string())?;
    emit_main_window_presentation(&window, false);
    if let Err(error) = window.hide() {
        let surface_available =
            window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
        emit_main_window_presentation(&window, surface_available);
        return Err(error.to_string());
    }
    Ok(())
}

/// Hide the main window to tray (called when close button is clicked)
#[allow(dead_code)]
pub fn hide_to_tray<R: Runtime>(app: &tauri::AppHandle<R>) -> bool {
    ulog_info!("[Tray] Hiding window to tray");
    hide_main_window(app).is_ok()
}

/// Partial app config for reading minimize to tray setting
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PartialAppConfig {
    minimize_to_tray: Option<bool>,
}

/// Check if minimize to tray is enabled
/// Reads from ~/.myagents/config.json, defaults to false if not configured.
///
/// Uses the project-canonical `app_dirs::myagents_data_dir()` helper rather
/// than raw `dirs::home_dir()` — that way any future dev/prod data-dir
/// isolation flows through automatically.
#[allow(dead_code)]
pub fn should_minimize_to_tray() -> bool {
    if let Some(dir) = crate::app_dirs::myagents_data_dir() {
        let config_path = dir.join("config.json");

        if let Ok(content) = fs::read_to_string(&config_path) {
            if let Ok(config) = serde_json::from_str::<PartialAppConfig>(strip_bom(&content)) {
                if let Some(minimize) = config.minimize_to_tray {
                    ulog_debug!("[Tray] minimizeToTray from config: {}", minimize);
                    return minimize;
                }
            }
        }
    }

    // Default to false (close app instead of minimize to tray)
    ulog_debug!("[Tray] minimizeToTray not configured, using default: false");
    false
}
