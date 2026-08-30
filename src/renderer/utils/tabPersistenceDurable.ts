// Durable backstop for tab restore (Issue #232 hardening).
//
// localStorage (tabPersistence.ts) is the PRIMARY store: written on every
// structural change and flushed on a clean quit, and it survives app updates.
// But the update-restart path (handleRestartAndUpdate → NSIS `exit(0)` on
// Windows / `relaunch()` on macOS) terminates the process ABRUPTLY, and
// WebKit/WebView2 persist localStorage to disk ASYNCHRONOUSLY (a coalescing
// flush timer). So the last `setItem` before that exit can be lost — the tabs
// the user had open at the moment they clicked "重启更新" then fail to restore
// on the next launch. (Normal Cmd+Q gives the WebView a clean teardown that
// flushes, which is why only the update path was reported broken.)
//
// This module adds a fsync-durable snapshot at `~/.myagents/open-tabs.json`,
// written (and AWAITED) right before the update-restart, and CONSUMED (deleted)
// on the next boot. It reuses the same atomic tmp+fsync+rename helper as
// config.json (configStore.safeWriteJson / safeLoadJson), so durability does
// not depend on WebView flush timing. Best-effort throughout: any failure
// degrades to the localStorage path and never breaks restart or boot.
//
// SINGLE-WRITER ASSUMPTION: unlike config.json this file deliberately does NOT
// take `withConfigLock`. It is written by exactly one process (the renderer) and
// the only caller that could overlap the write — the aborted-restart cleanup —
// now AWAITs its clear (App.tsx handleRestartAndUpdate), so the three operations
// (persist-before-restart / clear-on-abort / load-and-clear-on-boot) never
// interleave. This holds only while MyAgents is single-window/single-renderer;
// if multi-window ever lands, move these ops behind a lock or into a Rust command
// with locked read-clear-write semantics.

import { join } from '@tauri-apps/api/path';
import { remove, exists } from '@tauri-apps/plugin-fs';
import { getConfigDir, safeWriteJson, safeLoadJson } from '@/config/services/configStore';
import { isBrowserDevMode } from '@/utils/browserMock';
import { serializeTabs, deserializeTabs, type PersistedTabState } from './tabPersistence';
import type { Tab } from '@/types/tab';

const DURABLE_FILE = 'open-tabs.json';

async function durablePath(): Promise<string> {
    return join(await getConfigDir(), DURABLE_FILE);
}

/** Remove the durable snapshot plus its `.bak`/`.tmp` siblings. safeLoadJson
 *  transparently recovers from those, so a leftover backup MUST be cleared too
 *  or it could resurrect tabs the user had since closed. */
async function clearDurable(path: string): Promise<void> {
    for (const p of [path, `${path}.bak`, `${path}.tmp`]) {
        try {
            if (await exists(p)) await remove(p);
        } catch {
            // best-effort — a stale sibling at worst gets cleared on a later boot
        }
    }
}

/** Durably persist the current open Chat / Record tabs right before an abrupt
 *  update-restart. AWAITED by handleRestartAndUpdate so the fsync completes
 *  before the process exits. Clears the snapshot when nothing is restorable
 *  (e.g. only a launcher tab is open) so the next boot won't resurrect tabs the
 *  user had closed. */
export async function persistOpenTabsDurable(tabs: Tab[], activeTabId: string | null): Promise<void> {
    if (isBrowserDevMode()) return;
    try {
        const path = await durablePath();
        const state = serializeTabs(tabs, activeTabId);
        if (!state) {
            await clearDurable(path);
            return;
        }
        await safeWriteJson(path, state);
    } catch (err) {
        console.warn('[tabs] durable persist failed (localStorage still covers normal quit):', err);
    }
}

/** Drop the durable snapshot without reading it. Called when an update-restart
 *  is ABORTED (network / version / install error) so the process stays alive:
 *  the handoff we wrote just before attempting the restart would otherwise
 *  linger and could resurrect a now-stale tab set on a later boot. The live
 *  localStorage remains the source of truth while the app keeps running. */
export async function clearOpenTabsDurable(): Promise<void> {
    if (isBrowserDevMode()) return;
    try {
        await clearDurable(await durablePath());
    } catch (err) {
        console.warn('[tabs] durable clear failed:', err);
    }
}

/** Read the durable snapshot and DELETE it (single-boot handoff — consuming it
 *  prevents a stale snapshot from resurrecting tabs on a later, unrelated boot).
 *  Returns the validated state, or null when absent/invalid. Reuses the pure
 *  deserializer so the same validation + dedup invariants apply as localStorage. */
export async function loadAndClearOpenTabsDurable(): Promise<PersistedTabState | null> {
    if (isBrowserDevMode()) return null;
    const path = await durablePath();
    try {
        const raw = await safeLoadJson<unknown>(path);
        if (raw == null) return null;
        return deserializeTabs(JSON.stringify(raw));
    } catch (err) {
        console.warn('[tabs] durable load failed:', err);
        return null;
    } finally {
        // Consume-once: clear in `finally` so a throw from safeLoadJson /
        // deserializeTabs still removes the snapshot + its .bak/.tmp siblings.
        // If they lingered, safeLoadJson's transparent .bak/.tmp recovery could
        // resurrect a stale tab set on a later, unrelated boot.
        await clearDurable(path);
    }
}
