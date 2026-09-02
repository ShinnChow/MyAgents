/**
 * BrowserPanel — Embedded browser preview panel for the split view.
 *
 * Renders a navigation toolbar + a placeholder container. The actual
 * web content is rendered by a native Tauri child Webview positioned
 * over the placeholder using absolute coordinates (OS-level overlay).
 *
 * The toolbar always includes a close button (×), so the separate
 * single-view header in Chat.tsx is not needed — one row handles
 * both navigation and panel control.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listenWithCleanup } from '@/utils/tauriListen';
import { ChevronLeft, ChevronRight, Code2, RotateCw, ExternalLink, Loader2, Globe, X } from 'lucide-react';
import { openExternal } from '@/utils/openExternal';
import {
  BROWSER_BLANK_URL,
  shouldSyncBrowserBounds,
  toUsableBrowserBounds,
  type BrowserBounds,
} from '@/components/browserConstants';
import { useBrowserOverlayGuard } from '@/hooks/useBrowserOverlayGuard';
import { useToast } from '@/components/Toast';
import Tip from '@/components/Tip';

interface BrowserPanelProps {
  tabId: string;
  url: string | null;
  /** Whether this panel should be visible (includes isActive + splitActiveView + splitPanelVisible) */
  isVisible: boolean;
  isDraggingSplit: boolean;
  isSplitTransitioning?: boolean;
  browserAlive: boolean;
  /** Parent-owned reload intent; BrowserPanel applies it to its exact generation. */
  reloadSignal?: number;
  /** When previewing a local file, stores its metadata for editor toggle */
  sourceFile?: { name: string; content: string; size: number; path: string } | null;
  /**
   * Active chat workspace path. Forwarded to `openExternal()` when the user
   * clicks "open in external browser" so Rust can accept workspace files
   * outside home/tmp (e.g. Windows `D:\workspace\foo.html`). Issue #125
   * follow-up — without this the path validator rejects every non-system-
   * drive workspace.
   */
  workspace?: string | null;
  onBrowserCreated: () => void;
  onCreateFailed: () => void;
  onClose: () => void;
  /** Switch to code editor view (only available when sourceFile is set) */
  onSwitchToEditor?: () => void;
  /**
   * Notify parent when the visible URL changes (Rust emits `browser:url-changed`
   * after navigation / page-load). Lets the parent keep its own UI bits — like
   * the split-view tab label — in sync with what the user actually sees.
   */
  onUrlChange?: (url: string) => void;
}

export default function BrowserPanel({
  tabId,
  url,
  isVisible,
  isDraggingSplit,
  isSplitTransitioning = false,
  browserAlive,
  reloadSignal = 0,
  sourceFile,
  workspace,
  onBrowserCreated,
  onCreateFailed,
  onClose,
  onSwitchToEditor,
  onUrlChange,
}: BrowserPanelProps) {
  const { t } = useTranslation('app');
  const urlPlaceholder = t('browserPanel.urlPlaceholder');
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentUrl, setCurrentUrl] = useState(url ?? '');
  const [isLoading, setIsLoading] = useState(false);
  const lifecycleTokenRef = useRef<string | null>(null);
  const creatingTokenRef = useRef<string | null>(null);

  // Toast accessed via ref so the create effect doesn't list it as a dep
  // (project convention — see CLAUDE.md react_stability_rules). Ref is
  // updated in a post-commit effect rather than during render to satisfy
  // react-hooks/refs.
  const toast = useToast();
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  // onUrlChange via ref — same reason as toastRef. Lets the url-changed
  // listener effect stay stable across parent re-renders.
  const onUrlChangeRef = useRef(onUrlChange);
  useEffect(() => { onUrlChangeRef.current = onUrlChange; }, [onUrlChange]);

  // Mount-tracking ref to gate post-resolve setState in async chains, guarding
  // the close→reopen race where an unmounted instance's create promise still
  // resolves and would otherwise mutate parent state for the new instance's
  // tabId. Must be declared BEFORE any effect that depends on it.
  const isMountedRef = useRef(false);

  // Whether this webview has ever navigated to a real (non-blank) URL. Once
  // true, subsequent visits to the blank page (e.g. via browser back-button)
  // are shown by the native webview rather than overridden by our React empty
  // state — letting the user see the actual history page instead of the
  // "new tab" UI on every back-press.
  const [hasNavigated, setHasNavigated] = useState(false);

  // ── Editable URL bar state ──
  const [urlEditing, setUrlEditing] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const urlInputRef = useRef<HTMLInputElement>(null);

  // Overlay detection
  const overlayDetected = useBrowserOverlayGuard(browserAlive);

  // Track the last URL we told the webview to load
  const lastRequestedUrlRef = useRef<string | null>(null);
  const lastSyncedBoundsRef = useRef<BrowserBounds | null>(null);
  // Resize-invoke serialization marker. A ref (not effect-local state) so it
  // survives reconciler effect restarts: if visibility toggles while a resize
  // is pending, the restarted loop must keep deferring until that invoke
  // settles — two in-flight resizes have no ordering guarantee on the Rust
  // side, and the older one landing last would park the webview on stale
  // bounds that the ref-bookkeeping believes are current.
  const resizeInFlightTokenRef = useRef<string | null>(null);
  const createIssuedTokenRef = useRef<string | null>(null);

  // One token per effect lifetime, not per tab. React's setup-cleanup-setup
  // probe and a real close→reopen may reuse the same tabId, but neither may
  // address the other's native child WebView generation.
  useEffect(() => {
    const lifecycleToken = crypto.randomUUID();
    lifecycleTokenRef.current = lifecycleToken;
    isMountedRef.current = true;
    lastRequestedUrlRef.current = null;
    lastSyncedBoundsRef.current = null;
    resizeInFlightTokenRef.current = null;
    createIssuedTokenRef.current = null;

    return () => {
      const createWasIssued = createIssuedTokenRef.current === lifecycleToken;
      if (lifecycleTokenRef.current === lifecycleToken) {
        lifecycleTokenRef.current = null;
        isMountedRef.current = false;
        createIssuedTokenRef.current = null;
      }
      if (createWasIssued) {
        invoke('cmd_browser_close', { tabId, lifecycleToken }).catch(() => {});
      }
    };
  }, [tabId]);

  const readUsableBounds = useCallback((): BrowserBounds | null => {
    const el = containerRef.current;
    if (!el) return null;
    return toUsableBrowserBounds(el.getBoundingClientRect());
  }, []);

  // ── Create or navigate webview when url prop changes ──
  useEffect(() => {
    const lifecycleToken = lifecycleTokenRef.current;
    if (!url || !lifecycleToken) return;
    // While the split panel is in its Windows transition-suspension window,
    // the native webview is hidden specifically because the DOM rect is still
    // moving. If no webview exists yet, wait instead of seeding Rust's SHOW
    // cache with that transitional rect. Once alive, the reconciler below keeps
    // syncing even during suspension so existing webviews still converge.
    if (!browserAlive && isSplitTransitioning) return;
    let cancelled = false;
    let rafId = 0;

    const createWithBounds = (bounds: BrowserBounds) => {
      createIssuedTokenRef.current = lifecycleToken;
      creatingTokenRef.current = lifecycleToken;
      lastRequestedUrlRef.current = url;
      lastSyncedBoundsRef.current = bounds;

      invoke('cmd_browser_create', {
        tabId, lifecycleToken, url,
        bounds,
      })
        .then(() => {
          // Cross-instance race: this resolution may belong to an unmounted
          // BrowserPanel whose `tabId` has been reused by a fresh instance
          // (close → reopen). Calling cmd_browser_close here would kill the
          // new instance's webview. The unmount-cleanup effect already handles
          // teardown for unmounted instances; bail without touching state.
          if (!isMountedRef.current || lifecycleTokenRef.current !== lifecycleToken) return;
          if (cancelled) {
            // Same instance, but deps changed mid-create (e.g. url updated).
            // Sync browserAlive=true so the navigate branch on the next effect
            // run can target the new URL via cmd_browser_navigate.
            onBrowserCreated();
            return;
          }
          onBrowserCreated();
        })
        .catch((err) => {
          if (!isMountedRef.current || lifecycleTokenRef.current !== lifecycleToken) return;
          // Rust has definitively settled this birth as failed and removed its
          // reservation. Do not let a later React cleanup manufacture a
          // close-before-admit tombstone for a create that cannot arrive.
          if (createIssuedTokenRef.current === lifecycleToken) {
            createIssuedTokenRef.current = null;
          }
          console.error('[browser] Create failed:', err);
          if (!cancelled) {
            const msg = typeof err === 'string' ? err : (err?.message ?? String(err));
            toastRef.current.error(t('browserPanel.openFailed', { message: msg }));
            onCreateFailed();
          }
        })
        .finally(() => {
          if (creatingTokenRef.current === lifecycleToken) creatingTokenRef.current = null;
        });
    };

    const waitForUsableBounds = () => {
      if (cancelled || creatingTokenRef.current === lifecycleToken) return;
      const bounds = readUsableBounds();
      if (bounds) {
        createWithBounds(bounds);
        return;
      }
      rafId = requestAnimationFrame(waitForUsableBounds);
    };

    if (!browserAlive && creatingTokenRef.current !== lifecycleToken && isVisible) {
      // Create at the first usable rect after any known split-transition
      // suspension (#290 degenerate-bounds floor). The previous "wait for the
      // rect to hold still across N frames" dance (a8cd4f47) is still gone: a
      // momentarily-stable sample says nothing about whether the layout will
      // move again (#339), so create-time precision cannot be the only owner.
      // After creation, the reconciler below owns convergence.
      waitForUsableBounds();
    } else if (browserAlive && url !== lastRequestedUrlRef.current) {
      lastRequestedUrlRef.current = url;
      invoke('cmd_browser_navigate', { tabId, lifecycleToken, url }).catch(() => {});
    }

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [url, browserAlive, isVisible, isSplitTransitioning, tabId, onBrowserCreated, onCreateFailed, readUsableBounds, t]);

  // ── Listen for URL/loading events from Rust ──
  useEffect(() => {
    const lifecycleToken = lifecycleTokenRef.current;
    if (!browserAlive || !lifecycleToken) return;
    const ac = new AbortController();

    void listenWithCleanup<string>(`browser:url-changed:${tabId}:${lifecycleToken}`, (event) => {
      const next = event.payload;
      setCurrentUrl(next);
      // Latch hasNavigated on first real navigation — lets the React empty
      // state release control over the panel for the rest of this webview's
      // lifetime. Anchored to the scheme (anything but `data:`) rather than
      // string equality with BROWSER_BLANK_URL: WebKit reports the data: URL
      // back with Tauri's CSP `<meta>` injection appended, so equality check
      // breaks and the latch would fire on the very first blank-page load.
      if (next && !next.startsWith('data:')) {
        setHasNavigated((prev) => (prev ? prev : true));
      }
      onUrlChangeRef.current?.(next);
    }, ac.signal);

    void listenWithCleanup<boolean>(`browser:loading:${tabId}:${lifecycleToken}`, (event) => {
      setIsLoading(event.payload);
    }, ac.signal);

    return () => ac.abort();
  }, [browserAlive, tabId]);

  // ── Geometry reconciler (issue #339) ──
  //
  // Single always-on loop owning the invariant: while the webview is alive
  // and this panel's tab is visible, the native webview bounds converge onto
  // the container's DOM rect — no matter what moved it, or when.
  //
  // This replaces the previous one-shot mechanisms (create-time stable-frame
  // wait, ResizeObserver, layoutSignature-keyed track-until-stable pump, show
  // force-sync). Each of those stopped sampling once it believed the layout
  // had settled, but the set of motion sources is open-ended — workspace
  // overlay flips move x without resizing, %-widths re-resolve after window
  // resizes, the 300ms width transition outlives timer-based gates — so the
  // last delivered sample could be a mid-flight rect with nothing scheduled
  // to ever run again (#290 → #329 → #339 are all instances of this class).
  // A frame-paced reconciler has no "settled" heuristic to get wrong: one
  // getBoundingClientRect per frame (≈μs, read-after-layout), an invoke only
  // when the rect actually changed, serialized so native updates stay
  // ordered. Same strategy as floating-ui's autoUpdate({animationFrame}).
  //
  // Runs even while the webview is suspension-hidden (drag / transition):
  // cmd_browser_resize updates Rust's cached geometry on hidden webviews, so
  // the next SHOW restores the current rect, not a stale one.
  useEffect(() => {
    const lifecycleToken = lifecycleTokenRef.current;
    if (!browserAlive || !isVisible || !lifecycleToken) return;
    let rafId = 0;
    let disposed = false;
    const tick = () => {
      if (disposed) return;
      const bounds = readUsableBounds();
      if (shouldSyncBrowserBounds(
        lastSyncedBoundsRef.current,
        bounds,
        resizeInFlightTokenRef.current === lifecycleToken,
      )) {
        resizeInFlightTokenRef.current = lifecycleToken;
        lastSyncedBoundsRef.current = bounds;
        invoke('cmd_browser_resize', {
          tabId,
          lifecycleToken,
          bounds,
        })
          .catch(() => {
            // Failed delivery must not be remembered as synced — clear so the
            // next frame retries (invoke latency naturally paces retries).
            // Rust propagates native set_position/set_size failures as Err,
            // so this also covers "IPC succeeded but geometry didn't apply".
            lastSyncedBoundsRef.current = null;
          })
          .finally(() => {
            if (resizeInFlightTokenRef.current === lifecycleToken) {
              resizeInFlightTokenRef.current = null;
            }
          });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [browserAlive, isVisible, readUsableBounds, tabId]);

  // Blank-state detection.
  //
  // Anchored to the `url` prop (the URL the parent asked us to load) and a
  // one-way `hasNavigated` latch — NOT to the moving `currentUrl`. This means:
  //   - Toolbar-opened browser (parent passes BROWSER_BLANK_URL) → blank state
  //     until the user types a URL and navigates away.
  //   - User opens a chat link (parent passes 'https://…') → never blank.
  //   - User navigates from blank → site → presses Back to the blank page →
  //     hasNavigated stays true, so the native webview keeps control instead
  //     of our React empty state hijacking the back button.
  //
  // Avoiding `currentUrl` here also sidesteps the race where create resolves
  // a frame before the first `browser:url-changed` event arrives (an empty
  // `currentUrl` would otherwise hide the just-alive webview).
  const isBlankPage = url === BROWSER_BLANK_URL && !hasNavigated;

  // ── Consolidated show/hide ──
  useEffect(() => {
    const lifecycleToken = lifecycleTokenRef.current;
    if (!browserAlive || !lifecycleToken) return;
    const nativeViewSuspended = isDraggingSplit || isSplitTransitioning;
    const shouldShow = isVisible && !nativeViewSuspended && !overlayDetected && !isBlankPage;
    if (shouldShow) {
      // SHOW restores Rust's cached geometry; the reconciler keeps that cache
      // current (it syncs even while hidden), and corrects any residue within
      // a frame — no force-sync needed here.
      invoke('cmd_browser_show', { tabId, lifecycleToken }).catch(() => {});
    } else {
      invoke('cmd_browser_hide', { tabId, lifecycleToken }).catch(() => {});
    }
  }, [isVisible, isDraggingSplit, isSplitTransitioning, overlayDetected, browserAlive, isBlankPage, tabId]);

  // Parent reload intents stay generation-local; Chat never owns the native
  // token and therefore cannot accidentally reload a reopened BrowserPanel.
  useEffect(() => {
    const lifecycleToken = lifecycleTokenRef.current;
    if (!browserAlive || reloadSignal <= 0 || !lifecycleToken) return;
    invoke('cmd_browser_reload', { tabId, lifecycleToken }).catch(() => {});
  }, [browserAlive, reloadSignal, tabId]);

  // ── Navigation handlers ──
  const handleGoBack = useCallback(() => {
    const lifecycleToken = lifecycleTokenRef.current;
    if (lifecycleToken) invoke('cmd_browser_go_back', { tabId, lifecycleToken }).catch(() => {});
  }, [tabId]);

  const handleGoForward = useCallback(() => {
    const lifecycleToken = lifecycleTokenRef.current;
    if (lifecycleToken) invoke('cmd_browser_go_forward', { tabId, lifecycleToken }).catch(() => {});
  }, [tabId]);

  const handleReload = useCallback(() => {
    const lifecycleToken = lifecycleTokenRef.current;
    if (lifecycleToken) invoke('cmd_browser_reload', { tabId, lifecycleToken }).catch(() => {});
  }, [tabId]);

  const handleOpenExternal = useCallback(() => {
    // openExternal auto-routes file:// URLs through Rust (see openExternal.ts);
    // web URLs go through Tauri shell.open. Forwarding `workspace` lets Rust
    // accept paths under non-system-drive workspaces (issue #125 follow-up);
    // it's a no-op for web URLs.
    if (currentUrl) openExternal(currentUrl, { workspace });
  }, [currentUrl, workspace]);

  // ── URL bar editing ──
  const handleUrlClick = useCallback(() => {
    // On blank state, start with empty draft so user can type immediately.
    setUrlDraft(isBlankPage ? '' : currentUrl);
    setUrlEditing(true);
    // Focus will happen after render via autoFocus
  }, [currentUrl, isBlankPage]);

  const handleUrlSubmit = useCallback(() => {
    setUrlEditing(false);
    let trimmed = urlDraft.trim();
    if (!trimmed) return;
    // Add https:// only when the input has no scheme at all. Detecting any
    // RFC-3986 scheme prefix (not just http/https) preserves `about:blank`,
    // `file://`, `data:`, etc. unchanged. Tauri's on_navigation already blocks
    // dangerous schemes (e.g. `javascript:`), so we don't sanitize here.
    if (!/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) {
      trimmed = 'https://' + trimmed;
    }
    if (trimmed !== currentUrl) {
      const lifecycleToken = lifecycleTokenRef.current;
      if (!lifecycleToken) return;
      invoke('cmd_browser_navigate', { tabId, lifecycleToken, url: trimmed }).catch(() => {});
      lastRequestedUrlRef.current = trimmed;
    }
  }, [urlDraft, currentUrl, tabId]);

  const handleUrlKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleUrlSubmit();
    } else if (e.key === 'Escape') {
      setUrlEditing(false);
    }
  }, [handleUrlSubmit]);

  // Extract display hostname (suppressed for blank state so we don't show the raw sentinel URL)
  const displayUrl = currentUrl && !isBlankPage
    ? (() => { try { return new URL(currentUrl).hostname || currentUrl; } catch { return currentUrl; } })()
    : '';

  // No `transition-colors` — let global `button { transition-property: ...transform... }` handle it,
  // so the unified active:scale(0.98) animates smoothly instead of snapping.
  const navBtn =
    'flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]';

  return (
    <div className="flex h-full flex-col">
      {/* Navigation toolbar — always includes close button (single row for all states) */}
      <div className="relative flex h-9 flex-shrink-0 items-center gap-0.5 border-b border-[var(--line)] bg-[var(--paper)] px-2">
        <Tip label={t('browserPanel.back')} position="bottom">
          <button type="button" className={navBtn} onClick={handleGoBack}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        </Tip>
        <Tip label={t('browserPanel.forward')} position="bottom">
          <button type="button" className={navBtn} onClick={handleGoForward}>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </Tip>
        <Tip label={isLoading ? t('browserPanel.stop') : t('browserPanel.reload')} position="bottom">
          <button type="button" className={navBtn} onClick={handleReload}>
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="h-3.5 w-3.5" />
            )}
          </button>
        </Tip>

        {/* Editable URL bar */}
        {urlEditing ? (
          <input
            ref={urlInputRef}
            autoFocus
            placeholder={urlPlaceholder}
            className="ml-1.5 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--line)] bg-transparent px-2 py-0.5 text-xs text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)]"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            onBlur={() => setUrlEditing(false)}
            spellCheck={false}
          />
        ) : (
          <button
            type="button"
            onClick={handleUrlClick}
            className="ml-1.5 min-w-0 flex-1 cursor-text truncate rounded-[var(--radius-sm)] px-2 py-0.5 text-left text-xs transition-colors hover:bg-[var(--paper-inset)]"
            title={isBlankPage ? urlPlaceholder : currentUrl}
          >
            {isBlankPage ? (
              <span className="text-[var(--ink-faint)]">{urlPlaceholder}</span>
            ) : (
              <span className="text-[var(--ink-muted)]">{currentUrl}</span>
            )}
          </button>
        )}

        {/* Edit Source — only for local file previews */}
        {sourceFile && onSwitchToEditor && (
          <Tip label={t('browserPanel.editSource')} position="bottom" align="end">
            <button type="button" className={navBtn} onClick={onSwitchToEditor}>
              <Code2 className="h-3.5 w-3.5" />
            </button>
          </Tip>
        )}

        <Tip label={t('browserPanel.openExternal')} position="bottom" align="end">
          <button
            type="button"
            className={navBtn}
            onClick={handleOpenExternal}
            disabled={!currentUrl || isBlankPage}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        </Tip>

        {/* Close button — always present */}
        <Tip label={t('browserPanel.close')} position="bottom" align="end">
          <button type="button" className={navBtn} onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </button>
        </Tip>

        {/* Loading progress indicator */}
        {isLoading && (
          <div className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden">
            <div className="animate-indeterminate h-full w-1/3 bg-[var(--accent-warm)]" />
          </div>
        )}
      </div>

      {/* Placeholder container — native Webview overlays this area */}
      <div ref={containerRef} className="relative min-h-0 flex-1 bg-[var(--paper)]">
        {!browserAlive && !isBlankPage && (
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-2 text-[var(--ink-subtle)]">
              <Globe className="h-6 w-6" />
              <span className="text-xs">{url ? t('common.loading') : ''}</span>
            </div>
          </div>
        )}

        {/* Blank state — shown for the blank-page sentinel or alive-but-no-url. Click anywhere to focus URL bar. */}
        {isBlankPage && (
          <button
            type="button"
            onClick={handleUrlClick}
            className="group absolute inset-0 flex cursor-text select-none flex-col items-center justify-center bg-[var(--paper)] text-left outline-none"
          >
            {/* Soft radial wash for warmth */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  'radial-gradient(ellipse at 50% 38%, var(--accent-warm-subtle) 0%, var(--accent-warm-subtle-a0) 60%)',
              }}
            />
            <div className="relative flex flex-col items-center gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--paper-elevated)] shadow-md">
                <Globe
                  className="h-7 w-7 text-[var(--accent-warm)]"
                  strokeWidth={1.5}
                />
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <div className="text-base font-medium tracking-tight text-[var(--ink)]">
                  {t('browserPanel.newTab')}
                </div>
                <div className="text-xs text-[var(--ink-muted)]">
                  {t('browserPanel.blankHint')}
                </div>
              </div>
            </div>
          </button>
        )}

        {(isDraggingSplit || isSplitTransitioning) && browserAlive && !isBlankPage && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--paper)]/80 backdrop-blur-md">
            <div className="flex flex-col items-center gap-2 text-[var(--ink-subtle)]">
              <Globe className="h-5 w-5" />
              <span className="text-xs">{displayUrl}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
