/**
 * useVirtuosoScroll — thin wrapper around react-virtuoso's scroll API.
 *
 * Three-state follow model:
 *  - `'force'`: programmatic scroll-to-bottom in progress; catch-up autoscroll is allowed
 *               even if we're briefly not at bottom during the animation.
 *  - `true`:    normal follow (at bottom; autoscroll allowed).
 *  - `false`:   disabled (user scrolled up, or paused for rewind/retry/search).
 *
 * Transitions:
 *  scrollToBottom()                     → 'force' (+ auto-degrade timer)
 *  atBottomStateChange(true)            → true    (covers force→true success AND
 *                                                  false→true when the user manually
 *                                                  scrolls back to bottom. Skipped while
 *                                                  pauseAutoScroll is active so rewind /
 *                                                  search / retry don't get hijacked.)
 *  atBottomStateChange(false) + true    → false   (user scrolled up during normal follow)
 *  upward wheel / PageUp / ArrowUp /    → false   (escape hatch for `'force'` — without
 *  Home                                            this, force persists forever when
 *                                                  content grows faster than the
 *                                                  programmatic scroll can reach bottom,
 *                                                  trapping the user in a bounce-back
 *                                                  loop during streaming.)
 *  `'force'` auto-degrade (1500ms)      → true    (fallback: if neither atBottom(true)
 *                                                  nor a user-intent event has fired by
 *                                                  then, degrade so subsequent
 *                                                  atBottom(false) can take effect.)
 *  pauseAutoScroll(d)                   → false  (temporary; restores prior value after d)
 */

import { useCallback, useEffect, useRef } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';

export interface VirtuosoScrollControls {
    virtuosoRef: React.RefObject<VirtuosoHandle | null>;
    scrollerRef: React.MutableRefObject<HTMLElement | null>;
    followEnabledRef: React.MutableRefObject<boolean | 'force'>;
    scrollToBottom: (behavior?: 'smooth' | 'auto') => void;
    pauseAutoScroll: (duration?: number) => void;
    handleAtBottomChange: (atBottom: boolean) => void;
    /**
     * Callback-ref for Virtuoso's `scrollerRef` prop. Stores the element for external
     * consumers (chatSearch, etc.) AND manages the user-intent listener lifecycle.
     */
    attachScroller: (el: HTMLElement | Window | null) => void;
}

export interface UseVirtuosoScrollOptions {
    /** Fires only for direct viewport input, before follow-state policy is applied. */
    onUserScrollIntent?: () => void;
}

// Fallback: degrade 'force' → true after this long even if atBottom(true) never fires.
// Without this, a session where streaming content grows faster than the smooth scroll
// can reach bottom (and no wheel/key events arrive — e.g., trackpad-only / scrollbar
// drag / unusual inputs) leaks force indefinitely into future content changes.
const FORCE_AUTO_DEGRADE_MS = 1500;

export function useVirtuosoScroll({ onUserScrollIntent }: UseVirtuosoScrollOptions = {}): VirtuosoScrollControls {
    const virtuosoRef = useRef<VirtuosoHandle>(null);
    const scrollerRef = useRef<HTMLElement | null>(null);
    const followEnabledRef = useRef<boolean | 'force'>(true);
    const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Track what followEnabled was before pause, so we can restore correctly
    const prePauseFollowRef = useRef<boolean | 'force'>(true);
    // `handleAtBottomChange(true)` must not re-enable follow while a pause is active —
    // otherwise rewind/search/retry silently lose their follow suppression when Virtuoso
    // re-fires atBottom for unrelated reasons (measurement shifts during streaming).
    const pauseActiveRef = useRef(false);
    // Auto-degrade force→true fallback timer (FORCE_AUTO_DEGRADE_MS).
    const forceDegradeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const onUserScrollIntentRef = useRef(onUserScrollIntent);
    // Ref mirror keeps native input listeners stable while observing the latest owner callback.
    // eslint-disable-next-line react-hooks/refs
    onUserScrollIntentRef.current = onUserScrollIntent;
    const notifyUserScrollIntent = useCallback(() => {
        onUserScrollIntentRef.current?.();
    }, []);

    const clearForceDegradeTimer = useCallback(() => {
        if (forceDegradeTimerRef.current) {
            clearTimeout(forceDegradeTimerRef.current);
            forceDegradeTimerRef.current = null;
        }
    }, []);

    // behavior='smooth' (default) for user-triggered bottom jumps; 'auto' for session-switch
    // pins where an instant, pre-paint jump is required (no visible scroll animation).
    //
    // align: 'end' is REQUIRED here. Virtuoso's `scrollToIndex` defaults to align:'start',
    // which puts the LAST item's TOP at the viewport TOP. For a tall streaming assistant
    // turn (multiple tool calls accumulated into one item), this lands the user partway
    // through the message — not at the scroll bottom. align:'end' aligns the last item's
    // BOTTOM to the viewport bottom, which (combined with the 280px footer spacer in
    // MessageList) is the actual scroll bottom. Cross-checked against react-virtuoso's
    // own internal followOutput path: it uses `{ align: 'end', index: 'LAST' }` — see the
    // bundled source's `function f(y) { _(i, { align: 'end', behavior: y, index: 'LAST' }) }`.
    const scrollToBottom = useCallback((behavior: 'smooth' | 'auto' = 'smooth') => {
        followEnabledRef.current = 'force';
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior });
        clearForceDegradeTimer();
        forceDegradeTimerRef.current = setTimeout(() => {
            forceDegradeTimerRef.current = null;
            if (followEnabledRef.current === 'force') {
                followEnabledRef.current = true;
            }
        }, FORCE_AUTO_DEGRADE_MS);
    }, [clearForceDegradeTimer]);

    const pauseAutoScroll = useCallback((duration = 500) => {
        // Save current state so we restore to the right value, not unconditionally true.
        // Force is a transient programmatic state — if we pause during a force scroll, the
        // attempt is effectively cancelled, so normalize 'force' → true so the restore
        // lands in a stable state (without this, the pause swallows the degrade timer and
        // later restores stale 'force' with no safety net, trapping the user).
        const prior = followEnabledRef.current;
        prePauseFollowRef.current = prior === 'force' ? true : prior;
        followEnabledRef.current = false;
        pauseActiveRef.current = true;
        // Clear any in-flight force-degrade timer — we've exited force intentionally.
        clearForceDegradeTimer();
        if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
        pauseTimerRef.current = setTimeout(() => {
            followEnabledRef.current = prePauseFollowRef.current;
            pauseActiveRef.current = false;
            pauseTimerRef.current = null;
        }, duration);
    }, [clearForceDegradeTimer]);

    const handleAtBottomChange = useCallback((atBottom: boolean) => {
        if (atBottom) {
            // Pause in progress (search/rewind/retry) — do NOT re-enable follow. The
            // restore happens when the pause timer fires.
            if (pauseActiveRef.current) return;
            // Reaching bottom resumes follow, regardless of prior mode:
            //   - force → true: programmatic scroll-to-bottom succeeded.
            //   - false → true: user manually scrolled back to bottom.
            if (followEnabledRef.current !== true) {
                followEnabledRef.current = true;
                clearForceDegradeTimer();
            }
            return;
        }
        // Leaving bottom disables follow ONLY if we were in normal-follow mode. 'force'
        // is preserved here because the programmatic scroll is still chasing; user-
        // initiated exit of force is handled by the user-intent listeners in
        // attachScroller below.
        if (followEnabledRef.current === true) {
            followEnabledRef.current = false;
        }
    }, [clearForceDegradeTimer]);

    // Direction-aware user-intent detection. Only UPWARD scroll intent breaks follow —
    // downward wheel while already at bottom is a no-op that mustn't silently disable
    // auto-follow for subsequent streaming content.
    const breakForceIfUserIntent = useCallback(() => {
        if (followEnabledRef.current === false) return;
        followEnabledRef.current = false;
        clearForceDegradeTimer();
    }, [clearForceDegradeTimer]);

    const onWheel = useCallback((e: WheelEvent) => {
        if (e.deltaY !== 0) notifyUserScrollIntent();
        // Only upward wheel indicates user wants to see earlier content. Downward wheel
        // or trackpad inertial decay past bottom shouldn't break follow.
        if (e.deltaY >= 0) return;
        breakForceIfUserIntent();
    }, [breakForceIfUserIntent, notifyUserScrollIntent]);

    const touchStartYRef = useRef(0);
    const onTouchStart = useCallback((e: TouchEvent) => {
        touchStartYRef.current = e.touches[0]?.clientY ?? 0;
    }, []);
    const onTouchMove = useCallback((e: TouchEvent) => {
        const y = e.touches[0]?.clientY ?? 0;
        if (Math.abs(y - touchStartYRef.current) > 4) notifyUserScrollIntent();
        // Finger moving DOWN on screen = content scrolling DOWN in viewport = user wants
        // to see content ABOVE (earlier messages). That's an upward-content intent.
        if (y > touchStartYRef.current + 4) {
            breakForceIfUserIntent();
        }
    }, [breakForceIfUserIntent, notifyUserScrollIntent]);

    // Pointer down covers native scrollbar dragging, which need not emit wheel
    // or touch events before changing the viewport.
    const onPointerDown = useCallback(() => {
        notifyUserScrollIntent();
    }, [notifyUserScrollIntent]);

    const onKeyDown = useCallback((e: KeyboardEvent) => {
        // Skip keys originating in editable targets — ArrowUp/Home are common cursor-nav
        // keys in textareas/inputs/contenteditable regions (chat input, code blocks) and
        // must not silently disable chat follow just because the user moved the caret.
        const target = e.target;
        if (target instanceof HTMLElement) {
            if (target.isContentEditable) return;
            const tag = target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        }
        if (
            e.key === 'PageUp'
            || e.key === 'PageDown'
            || e.key === 'ArrowUp'
            || e.key === 'ArrowDown'
            || e.key === 'Home'
            || e.key === 'End'
            || e.key === ' '
        ) {
            notifyUserScrollIntent();
        }
        // Keys that unambiguously move the view upward/away from the bottom.
        // PageDown/End/ArrowDown at bottom shouldn't break follow — those keep user at
        // bottom or move them toward it.
        if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home') {
            breakForceIfUserIntent();
        }
    }, [breakForceIfUserIntent, notifyUserScrollIntent]);

    // Callback-ref pattern: stores the scroller for external consumers AND manages the
    // listener lifecycle. Virtuoso passes the scroller element (or Window) via its
    // `scrollerRef` prop; we only listen on HTMLElement scrollers. Keyboard needs to
    // listen at window level (scroller rarely receives keydown).
    const attachScroller = useCallback((el: HTMLElement | Window | null) => {
        const prev = scrollerRef.current;
        if (prev) {
            prev.removeEventListener('wheel', onWheel);
            prev.removeEventListener('touchstart', onTouchStart);
            prev.removeEventListener('touchmove', onTouchMove);
            prev.removeEventListener('pointerdown', onPointerDown);
        }
        const next = el instanceof HTMLElement ? el : null;
        scrollerRef.current = next;
        if (next) {
            next.addEventListener('wheel', onWheel, { passive: true });
            next.addEventListener('touchstart', onTouchStart, { passive: true });
            next.addEventListener('touchmove', onTouchMove, { passive: true });
            next.addEventListener('pointerdown', onPointerDown, { passive: true });
        }
    }, [onWheel, onTouchStart, onTouchMove, onPointerDown]);

    useEffect(() => {
        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            if (pauseTimerRef.current) clearTimeout(pauseTimerRef.current);
            clearForceDegradeTimer();
            const el = scrollerRef.current;
            if (el) {
                el.removeEventListener('wheel', onWheel);
                el.removeEventListener('touchstart', onTouchStart);
                el.removeEventListener('touchmove', onTouchMove);
                el.removeEventListener('pointerdown', onPointerDown);
            }
        };
    }, [onWheel, onTouchStart, onTouchMove, onPointerDown, onKeyDown, clearForceDegradeTimer]);

    return {
        virtuosoRef,
        scrollerRef,
        followEnabledRef,
        scrollToBottom,
        pauseAutoScroll,
        handleAtBottomChange,
        attachScroller,
    };
}
