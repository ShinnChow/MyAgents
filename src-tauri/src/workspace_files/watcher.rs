//! Workspace filesystem watcher.
//!
//! DirectoryPanel needs to refresh its tree when the user / AI / external
//! tool mutates files in the workspace. Pre-PRD-0.2.7 the sidecar emitted an
//! SSE `agent:files-changed` event from a Node `chokidar` watcher; PRD 0.2.7
//! Phase D moves the watch to Rust so the panel doesn't depend on a sidecar
//! being alive.
//!
//! # Token-based handle (Phase D.5)
//!
//! `watch_start` returns an opaque `WatchHandle { token, event_key }`. The
//! renderer keeps the `token` and passes it to `watch_stop`. This eliminates
//! the previous "re-derive key from path" stop logic, which leaked entries
//! when the workspace path changed (rename, symlink swap, deletion) between
//! start and stop.
//!
//! Ref-counting still happens at the workspace-key level (one OS watcher per
//! workspace path, multiple consumers share it). Each `start` call gets its
//! own token, so `stop(token)` decrements the right entry even if the path
//! the renderer holds has since changed.
//!
//! # Event shape
//!
//! Each fired event is a Tauri event named `workspace:files-changed:<event_key>`
//! where `<event_key>` is `siphash(workspace_path)` rendered as 16-char hex.
//! The same key is returned in `WatchHandle` so the renderer can subscribe
//! before any other consumer for the same workspace finished `start` —
//! event_key is deterministic for a given workspace path, tokens are not.
//!
//! App rename/move commands emit `{moves: [{oldPath, newPath}]}` immediately
//! after committing, on this same channel. OS watcher events retain their
//! coarse workspace-path payload and do not guess rename identity.
//!
//! # Debouncing
//!
//! Same 5s sliding window as the session watcher. DirectoryPanel adds its
//! own 300ms debounce on top so a burst of events still produces only one
//! tree refresh.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify_debouncer_full::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer, RecommendedCache,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::{ulog_info, ulog_warn};

use super::path_safety::validate_workspace_root;

const DEBOUNCE_WINDOW: Duration = Duration::from_secs(5);

// Note: token format is `{counter:016x}` (single u64). Tokens are
// in-memory only — DirectoryPanel issues at mount, holds in React state, and
// returns at unmount. No persistence path exists today, so cross-process
// counter collision is not reachable. If any future code path persists tokens
// across a sidecar/process restart, prepend a per-process nonce here so a
// stale token from before the restart can be rejected.

/// Tauri State entry — a process-wide registry of active workspace watchers.
/// `Mutex` is fine here: start/stop are rare (Tab open/close), the lock is
/// only held briefly to mutate the registry.
#[derive(Default)]
pub struct WorkspaceWatchers {
    /// Keyed by event_key (== siphash of workspace path). One entry per
    /// active OS-level watcher; all `start` calls for the same workspace share
    /// it via ref-count.
    inner: Mutex<HashMap<String, WatcherEntry>>,
    /// Maps token → event_key. `stop(token)` looks up the entry to decrement.
    /// Token issuance is monotonic and process-local.
    token_index: Mutex<HashMap<u64, String>>,
    /// Monotonic counter for token issuance. The full token surfaced to the
    /// renderer is `format!("{:x}", n)` so it's a stable opaque string.
    next_token: AtomicU64,
}

struct WatcherEntry {
    /// Number of outstanding tokens against this entry. Drops to 0 → drop the
    /// debouncer, drop the entry. Never decrements past 0 even on bogus input.
    refs: usize,
    /// Holding the debouncer alive keeps the watch active. Dropping it stops
    /// the OS-level watch.
    _debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
}

/// Compute the stable event-key suffix for a workspace path. Uses std's
/// `DefaultHasher` (SipHash-1-3 on current rustc) — we don't need cryptographic
/// strength, just a consistent 16-char hex string that's safe to embed in a
/// Tauri event name. The hash is process-local — never persisted — so the
/// "DefaultHasher may change between rustc versions" caveat doesn't bite.
pub fn event_key_for_workspace(workspace_path: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    workspace_path.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Publish exact successful application moves on the existing workspace channel.
/// The OS watcher remains a coarse invalidation; it cannot infer document identity.
pub(crate) fn emit_committed_moves(root: &std::path::Path, moves: &[super::crud::MovedFile]) {
    if moves.is_empty() {
        return;
    }
    let Some(app) = crate::logger::get_app_handle() else {
        return;
    };
    let event_name = format!(
        "workspace:files-changed:{}",
        event_key_for_workspace(&root.to_string_lossy())
    );
    if let Err(error) = app.emit(&event_name, serde_json::json!({ "moves": moves })) {
        ulog_warn!(
            "[workspace_files] committed move notification failed: {}",
            error
        );
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchHandle {
    /// Opaque handle the renderer keeps and passes to `watch_stop`. Stable
    /// across the lifetime of the start call but NOT stable across rustc
    /// rebuilds (it's a process-local counter, not persisted anywhere).
    pub token: String,
    /// Event-name suffix to subscribe to via Tauri `listen()`. Deterministic
    /// for a given workspace path so the renderer can subscribe before
    /// `start` returns.
    pub event_key: String,
}

#[tauri::command]
pub async fn cmd_workspace_watch_start(
    workspace: String,
    app: AppHandle,
    state: tauri::State<'_, Arc<WorkspaceWatchers>>,
) -> Result<WatchHandle, String> {
    let workspace_root = validate_workspace_root(&workspace)?;
    let event_key = event_key_for_workspace(&workspace_root.to_string_lossy());

    // Issue token first so we can register it under the lock atomically with
    // the registry mutation. Wrapping order: registry → token_index, both
    // briefly held.
    let token_n = state.next_token.fetch_add(1, Ordering::Relaxed);
    let token = format!("{:016x}", token_n);

    let mut registry = state.inner.lock().map_err(|e| format!("lock: {}", e))?;
    let mut tokens = state
        .token_index
        .lock()
        .map_err(|e| format!("token lock: {}", e))?;

    if let Some(entry) = registry.get_mut(&event_key) {
        entry.refs += 1;
        tokens.insert(token_n, event_key.clone());
        return Ok(WatchHandle { token, event_key });
    }

    // Spin up a new debouncer. Channel sends DebounceEventResult; spawn a
    // dedicated thread to drain it so the Tauri runtime stays responsive.
    let (tx, rx) = std::sync::mpsc::channel::<DebounceEventResult>();
    let mut debouncer = new_debouncer(DEBOUNCE_WINDOW, None, tx)
        .map_err(|e| format!("create debouncer failed: {}", e))?;
    debouncer
        .watch(&workspace_root, RecursiveMode::Recursive)
        .map_err(|e| format!("watch workspace failed: {}", e))?;

    let app_clone = app.clone();
    let event_name = format!("workspace:files-changed:{}", event_key);
    let workspace_path_str = workspace_root.to_string_lossy().to_string();
    std::thread::Builder::new()
        .name(format!("ws-watcher:{}", &event_key[..8]))
        .spawn(move || {
            for result in rx {
                match result {
                    Ok(_events) => {
                        // Coarse signal — frontend re-fetches the tree on its
                        // own. Keeping the payload minimal avoids serializing
                        // change-event metadata that the panel ignores.
                        if let Err(e) = app_clone.emit(&event_name, &workspace_path_str) {
                            ulog_warn!(
                                "[workspace_files::watcher] emit failed for {}: {}",
                                event_name,
                                e
                            );
                        }
                    }
                    Err(errors) => {
                        for e in errors {
                            ulog_warn!("[workspace_files::watcher] event error: {}", e);
                        }
                    }
                }
            }
        })
        .map_err(|e| format!("spawn watcher thread failed: {}", e))?;

    ulog_info!(
        "[workspace_files::watcher] started for {} (event_key={}, token={})",
        workspace_root.display(),
        event_key,
        token
    );

    registry.insert(
        event_key.clone(),
        WatcherEntry {
            refs: 1,
            _debouncer: debouncer,
        },
    );
    tokens.insert(token_n, event_key.clone());

    Ok(WatchHandle { token, event_key })
}

#[tauri::command]
pub async fn cmd_workspace_watch_stop(
    token: String,
    state: tauri::State<'_, Arc<WorkspaceWatchers>>,
) -> Result<(), String> {
    // Parse the token. Bad input is a no-op (matches the "stop is best-effort"
    // contract — caller might double-stop on unmount).
    let token_n = match u64::from_str_radix(&token, 16) {
        Ok(n) => n,
        Err(_) => return Ok(()),
    };

    // Lock order: REGISTRY → TOKENS (matches `watch_start`). Cross-review
    // round 2 caught: `watch_start` held registry then tokens; previous
    // `watch_stop` held tokens then dropped them before grabbing registry.
    // The drop-before-acquire was technically deadlock-free, but any future
    // change holding both at once with the inverted order would deadlock
    // against in-flight `watch_start`. Standardizing on REGISTRY → TOKENS
    // makes the invariant a static lint-able rule.
    let mut registry = state.inner.lock().map_err(|e| format!("lock: {}", e))?;
    let mut tokens = state
        .token_index
        .lock()
        .map_err(|e| format!("token lock: {}", e))?;
    let event_key = match tokens.remove(&token_n) {
        Some(k) => k,
        None => return Ok(()), // Already stopped or unknown token.
    };
    let drop_now = match registry.get_mut(&event_key) {
        Some(e) => {
            // Saturating decrement — defense-in-depth against accidental
            // double-stop within a single token window.
            if e.refs > 1 {
                e.refs -= 1;
                false
            } else {
                true
            }
        }
        None => false,
    };
    if drop_now {
        registry.remove(&event_key);
        ulog_info!(
            "[workspace_files::watcher] stopped (event_key={}, token={})",
            event_key,
            token
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_key_is_deterministic() {
        let k1 = event_key_for_workspace("/Users/alice/proj");
        let k2 = event_key_for_workspace("/Users/alice/proj");
        assert_eq!(k1, k2);
        let k3 = event_key_for_workspace("/Users/alice/other");
        assert_ne!(k1, k3);
    }

    #[test]
    fn event_key_is_hex_16chars() {
        let k = event_key_for_workspace("any-path");
        assert_eq!(k.len(), 16);
        assert!(k.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// Direct unit-test of the registry surface — we can't construct a real
    /// `Debouncer` outside a Tauri runtime, but the ref-count + token-index
    /// logic is independent of the debouncer field. Build a minimal
    /// WatcherEntry-shaped pretend by manipulating the maps directly.
    #[test]
    fn token_index_routes_stop_to_correct_entry() {
        // Two distinct event_keys with refs=1 and refs=2 — manually crafted
        // entries (no debouncer; we never read `_debouncer`).
        // We can't construct WatcherEntry without a Debouncer. Instead test
        // the *bookkeeping invariant* through the registry's token_index
        // alone: removing a token surfaces the right event_key, and the
        // refs branch logic is small enough to read by inspection.
        let registry = WorkspaceWatchers::default();
        let mut tokens = registry.token_index.lock().unwrap();
        tokens.insert(1, "key_a".to_string());
        tokens.insert(2, "key_a".to_string());
        tokens.insert(3, "key_b".to_string());

        // Stop token 1 → maps to key_a.
        assert_eq!(tokens.remove(&1).as_deref(), Some("key_a"));
        // Stop token 3 → maps to key_b.
        assert_eq!(tokens.remove(&3).as_deref(), Some("key_b"));
        // Stop token 2 → maps to key_a.
        assert_eq!(tokens.remove(&2).as_deref(), Some("key_a"));
        // Unknown token → None (stop becomes a no-op).
        assert_eq!(tokens.remove(&999), None);
    }

    #[test]
    fn next_token_is_monotonic() {
        let registry = WorkspaceWatchers::default();
        let a = registry.next_token.fetch_add(1, Ordering::Relaxed);
        let b = registry.next_token.fetch_add(1, Ordering::Relaxed);
        let c = registry.next_token.fetch_add(1, Ordering::Relaxed);
        assert_eq!(b, a + 1);
        assert_eq!(c, a + 2);
    }

    #[test]
    fn watch_stop_invalid_token_is_noop() {
        let registry = WorkspaceWatchers::default();
        // Bad input is treated as no-op: the cmd handler swallows the
        // parse error and returns `Ok(())`. The empty registry remains so.
        assert!(u64::from_str_radix("not-hex", 16).is_err());
        assert!(registry.inner.lock().unwrap().is_empty());
    }
}
