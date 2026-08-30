import { useEffect, useRef, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { Tab } from '@/types/tab';
import { formatPerfLine, type PerfTraceDetail } from '../../shared/perfTrace';
import {
  horizontalGestureOwnerTag,
  resolveHorizontalGestureOwnership,
} from './tabSwipeGestureOwnership';

interface UseTabSwipeGestureOptions {
  contentRef: RefObject<HTMLDivElement | null>;
  getTabs: () => readonly Tab[];
  getActiveTabId: () => string;
  onSwitchTab: (tabId: string) => void;
}

interface VelocitySample {
  delta: number;  // px (positive = rightward)
  time: number;   // performance.now()
}

interface MergedPoint {
  deltaSum: number;
  time: number;
}

interface SwipeState {
  phase: 'idle' | 'tracking' | 'animating';
  direction: 'horizontal' | 'vertical' | 'inner-scroll' | null;
  offsetX: number;              // cumulative px; positive = shifted right (previous tab)
  velocitySamples: VelocitySample[];
  generation: number;           // incremented per animation — stale listeners check this
  idleTimer: ReturnType<typeof setTimeout> | null;
  dirResetTimer: ReturnType<typeof setTimeout> | null;
  snapTimer: ReturnType<typeof setTimeout> | null;
  currentEl: HTMLElement | null;
  adjacentEl: HTMLElement | null;
  adjacentIndex: number;
  activeOnEnd: ((e?: Event) => void) | null;
  activeOnEndEl: HTMLElement | null;
  cooldownUntil: number;
  // Momentum detection (acceleration factor analysis, adapted from wheel-gestures)
  mergeCount: number;
  mergeDeltaSum: number;
  mergeTimeSum: number;
  prevMergedPoint: MergedPoint | null;
  prevMergedVelocity: number;
  accFactors: number[];
  momentumFlag: boolean;
  traceGestureId: number;
  traceSampleCount: number;
  traceTrackingStartedAt: number;
  traceLastIdleKey: string | null;
  traceCooldownAbsorbCount: number;
  tracePostCommitTailAbsorbCount: number;
  suppressMomentumTail: boolean;
  suppressMomentumTailUntil: number;
  suppressMomentumTailDeltaSign: -1 | 0 | 1;
}

// --- Tuning constants ---
const DIR_LOCK_RATIO = 1.2;
const DIR_LOCK_MIN = 2;
const DIR_RESET_TIMEOUT = 150;         // ms — reset vertical direction lock

const VELOCITY_SAMPLES = 5;
const VELOCITY_SAMPLE_MAX_AGE = 100;   // ms — discard samples older than this
const COMMIT_VELOCITY = 300;           // px/s — velocity threshold for tab switch (both proactive & idle)
const POSITION_THRESHOLD = 0.25;       // 25% of container width → switch on release

const IDLE_SLOW = 500;                 // ms — finger barely moving or paused
const IDLE_FAST = 200;                 // ms — was recently moving fast → decide quickly after stop
const IDLE_INERTIA_TAIL = 150;         // ms — inertia ending (small deltas + momentum confirmed)
const INERTIA_TAIL_THRESHOLD = 3;      // px — delta below this = "tail" of inertia
const IDLE_BOUNDARY = 30;              // ms — snap back quickly at boundaries

// Momentum detection (adapted from wheel-gestures library)
const ACC_FACTOR_MIN = 0.6;            // min acceleration factor for momentum
const ACC_FACTOR_MAX = 0.96;           // max acceleration factor for momentum
const EVENTS_TO_MERGE = 2;             // merge every 2 events for noise smoothing
const ACC_FACTORS_NEEDED = 5;          // need 5 consecutive factors in range (~12 events total)

// WebKit (WKWebView) non-standard wheel event phases
const WEBKIT_PHASE_ENDED = 8;          // NSEventPhaseEnded — finger lifted
const WEBKIT_PHASE_CANCELLED = 16;     // NSEventPhaseCancelled

const SNAP_DURATION = 200;             // ms
const SNAP_EASING = 'cubic-bezier(0.2, 1, 0.3, 1)';
const SNAP_SAFETY_BUFFER = 50;         // ms — fallback timeout margin
const RUBBER_BAND_MAX = 80;            // px — max boundary stretch
const COMMIT_COOLDOWN = 250;           // ms — absorb immediate inertial tail after tab switch
const BOUNCE_COOLDOWN = 500;           // ms — absorb inertial events after bounce-back
const POST_COMMIT_TAIL_WINDOW = 650;   // ms — absorb small no-phase inertia after cooldown
const POST_COMMIT_TAIL_MAX_DELTA = 12; // px — real follow-up swipes exceed this and pass through

const TRACE_FULL_SAMPLE_COUNT = 6;
const TRACE_SAMPLE_INTERVAL = 4;
const COOLDOWN_TRACE_INTERVAL = 8;

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

type SnapDecisionSource = 'manual' | 'webkit-phase' | 'momentum-phase' | 'momentum-detector' | 'idle';

function roundPx(value: number): number {
  return Math.round(value * 10) / 10;
}

function roundPct(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function phaseValue(value: number | undefined): number {
  return typeof value === 'number' ? value : -1;
}

function directionValue(direction: SwipeState['direction']): string {
  return direction ?? 'none';
}

function targetKind(target: EventTarget | null): string {
  const el = target instanceof HTMLElement
    ? target
    : target instanceof Node ? target.parentElement : null;
  if (!el) return 'unknown';
  if (el instanceof HTMLTextAreaElement) return 'textarea';
  if (el instanceof HTMLInputElement) return 'input';
  if (el.isContentEditable) return 'contenteditable';
  return el.tagName.toLowerCase();
}

function traceTabSwipe(phase: string, detail?: PerfTraceDetail): void {
  let traceEnabled = false;
  try {
    traceEnabled = typeof localStorage !== 'undefined'
      && localStorage.getItem('myagents:tab-swipe-trace') === '1';
  } catch {
    // localStorage may be unavailable in tests or hardened WebViews; tracing
    // should remain best-effort and never affect gesture handling.
  }
  if (!traceEnabled) return;
  const perfPhase = `tab_swipe_${phase}`;
  try {
    console.debug(formatPerfLine({
      trace: 'renderer',
      phase: perfPhase,
      detail,
    }));
  } catch {
    // Ignore logging failures in the hot wheel path.
  }
}

function shouldTraceSample(sample: number): boolean {
  return sample <= TRACE_FULL_SAMPLE_COUNT || sample % TRACE_SAMPLE_INTERVAL === 0;
}

function shouldTraceCooldownAbsorb(count: number): boolean {
  return count <= 3 || count % COOLDOWN_TRACE_INTERVAL === 0;
}

function isHorizontalDominant(deltaX: number, deltaY: number): boolean {
  const ax = Math.abs(deltaX);
  const ay = Math.abs(deltaY);
  return ax >= DIR_LOCK_MIN && ax > ay * DIR_LOCK_RATIO;
}

function isActiveMomentumPhase(momentumPhase: number | undefined): boolean {
  return typeof momentumPhase === 'number' && momentumPhase > 0;
}

function isSmallPostCommitTail(deltaX: number, deltaY: number, expectedDeltaSign: -1 | 0 | 1): boolean {
  const ax = Math.abs(deltaX);
  const ay = Math.abs(deltaY);
  return ax > 0
    && ax <= POST_COMMIT_TAIL_MAX_DELTA
    && ay <= POST_COMMIT_TAIL_MAX_DELTA
    && ax >= ay
    && (expectedDeltaSign === 0 || Math.sign(deltaX) === expectedDeltaSign);
}

export function useTabSwipeGesture({
  contentRef,
  getTabs,
  getActiveTabId,
  onSwitchTab,
}: UseTabSwipeGestureOptions) {
  const stateRef = useRef<SwipeState>({
    phase: 'idle',
    direction: null,
    offsetX: 0,
    velocitySamples: [],
    generation: 0,
    idleTimer: null,
    dirResetTimer: null,
    snapTimer: null,
    currentEl: null,
    adjacentEl: null,
    adjacentIndex: -1,
    activeOnEnd: null,
    activeOnEndEl: null,
    cooldownUntil: 0,
    mergeCount: 0,
    mergeDeltaSum: 0,
    mergeTimeSum: 0,
    prevMergedPoint: null,
    prevMergedVelocity: 0,
    accFactors: [],
    momentumFlag: false,
    traceGestureId: 0,
    traceSampleCount: 0,
    traceTrackingStartedAt: 0,
    traceLastIdleKey: null,
    traceCooldownAbsorbCount: 0,
    tracePostCommitTailAbsorbCount: 0,
    suppressMomentumTail: false,
    suppressMomentumTailUntil: 0,
    suppressMomentumTailDeltaSign: 0,
  });

  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const state = stateRef.current;

    // ─── Helpers ───────────────────────────────────────────────

    function getActiveIndex(): number {
      return getTabs().findIndex(t => t.id === getActiveTabId());
    }

    function getTabEl(index: number): HTMLElement | null {
      return (contentRef.current?.children[index] as HTMLElement) ?? null;
    }

    function clearAllTimers() {
      if (state.idleTimer !== null) { clearTimeout(state.idleTimer); state.idleTimer = null; }
      if (state.dirResetTimer !== null) { clearTimeout(state.dirResetTimer); state.dirResetTimer = null; }
      if (state.snapTimer !== null) { clearTimeout(state.snapTimer); state.snapTimer = null; }
    }

    function detachOnEnd() {
      if (state.activeOnEnd && state.activeOnEndEl) {
        state.activeOnEndEl.removeEventListener('transitionend', state.activeOnEnd as EventListener);
      }
      state.activeOnEnd = null;
      state.activeOnEndEl = null;
    }

    function resetState() {
      clearAllTimers();
      detachOnEnd();
      state.phase = 'idle';
      state.direction = null;
      state.offsetX = 0;
      state.velocitySamples = [];
      state.currentEl = null;
      state.adjacentEl = null;
      state.adjacentIndex = -1;
      state.mergeCount = 0;
      state.mergeDeltaSum = 0;
      state.mergeTimeSum = 0;
      state.prevMergedPoint = null;
      state.prevMergedVelocity = 0;
      state.accFactors = [];
      state.momentumFlag = false;
      state.traceSampleCount = 0;
      state.traceTrackingStartedAt = 0;
      state.traceLastIdleKey = null;
      state.traceCooldownAbsorbCount = 0;
      state.tracePostCommitTailAbsorbCount = 0;
      state.suppressMomentumTail = false;
      state.suppressMomentumTailUntil = 0;
      state.suppressMomentumTailDeltaSign = 0;
    }

    function scheduleDirectionReset() {
      if (state.dirResetTimer !== null) clearTimeout(state.dirResetTimer);
      state.dirResetTimer = setTimeout(() => {
        state.direction = null;
        state.dirResetTimer = null;
      }, DIR_RESET_TIMEOUT);
    }

    function cleanupDOM() {
      const cont = contentRef.current;
      if (!cont) return;
      for (let i = 0; i < cont.children.length; i++) {
        const el = cont.children[i] as HTMLElement;
        el.style.transform = '';
        el.style.transition = '';
      }
      if (state.adjacentEl && state.adjacentIndex !== getActiveIndex()) {
        state.adjacentEl.classList.add('invisible', 'pointer-events-none');
        state.adjacentEl.style.contentVisibility = 'hidden';
      }
    }

    function showTab(el: HTMLElement) {
      el.classList.remove('invisible', 'pointer-events-none');
      el.style.contentVisibility = '';
    }

    function hideTab(el: HTMLElement) {
      el.style.transform = '';
      el.classList.add('invisible', 'pointer-events-none');
      el.style.contentVisibility = 'hidden';
    }

    // ─── Velocity (with sample expiry) ────────────────────────

    function addSample(delta: number) {
      const now = performance.now();
      state.velocitySamples.push({ delta, time: now });
      while (state.velocitySamples.length > VELOCITY_SAMPLES) {
        state.velocitySamples.shift();
      }
    }

    function getVelocity(): number {
      const s = state.velocitySamples;
      if (s.length < 2) return 0;
      const latest = s[s.length - 1].time;
      const recent = s.filter(v => latest - v.time <= VELOCITY_SAMPLE_MAX_AGE);
      if (recent.length < 2) return 0;
      const dt = recent[recent.length - 1].time - recent[0].time;
      if (dt < 1) return 0;
      const totalDelta = recent.reduce((sum, v) => sum + v.delta, 0);
      return (totalDelta / dt) * 1000;
    }

    // ─── Rubber band at boundaries ────────────────────────────

    function rubberBand(offset: number): number {
      const sign = Math.sign(offset);
      const abs = Math.abs(offset);
      return sign * RUBBER_BAND_MAX * (1 - Math.exp(-abs / (RUBBER_BAND_MAX * 2)));
    }

    // ─── Momentum detection (acceleration factor analysis) ────
    // Adapted from the wheel-gestures library.
    // Merges every 2 events into one data point, computes velocity between
    // consecutive points, then checks if the velocity ratio (acceleration factor)
    // is consistently in [0.6, 0.96] — the fingerprint of system-generated inertia.
    // Human finger movement produces erratic ratios outside this range.

    function feedMomentumDetector(delta: number): boolean {
      state.mergeCount++;
      state.mergeDeltaSum += delta;
      state.mergeTimeSum += performance.now();

      if (state.mergeCount < EVENTS_TO_MERGE) return false;

      // Merge complete — create a data point
      const point: MergedPoint = {
        deltaSum: state.mergeDeltaSum,
        time: state.mergeTimeSum / EVENTS_TO_MERGE,
      };
      state.mergeCount = 0;
      state.mergeDeltaSum = 0;
      state.mergeTimeSum = 0;

      if (state.prevMergedPoint) {
        const dt = point.time - state.prevMergedPoint.time;
        if (dt > 0) {
          const velocity = point.deltaSum / dt;

          if (Math.abs(state.prevMergedVelocity) > 0.001) {
            const factor = velocity / state.prevMergedVelocity;
            state.accFactors.push(factor);
            if (state.accFactors.length > ACC_FACTORS_NEEDED) {
              state.accFactors.shift();
            }
          }

          state.prevMergedVelocity = velocity;
        }
      }

      state.prevMergedPoint = point;

      // Check if we have enough factors and they're all in the momentum range
      if (state.accFactors.length >= ACC_FACTORS_NEEDED) {
        const isMomentum = state.accFactors.every(f => f >= ACC_FACTOR_MIN && f <= ACC_FACTOR_MAX);
        state.momentumFlag = isMomentum;
        return isMomentum;
      }
      return false;
    }

    // ─── Snap animation ───────────────────────────────────────
    // ALL animations are non-cancellable. Once a decision is made, it's final.

    function animateSnap(commit: boolean, swipeDir: -1 | 1) {
      const cont = contentRef.current;
      const cw = cont?.clientWidth ?? 0;
      const durationBaseDetail: PerfTraceDetail = {
        gestureId: state.traceGestureId,
        commit,
        swipeDir,
        offsetX: roundPx(state.offsetX),
        offsetPct: cw > 0 ? roundPct(Math.abs(state.offsetX) / cw) : 0,
        adjacentIndex: state.adjacentIndex,
        sampleCount: state.traceSampleCount,
      };
      traceTabSwipe('snap_start', durationBaseDetail);
      state.phase = 'animating';
      state.generation++;
      const gen = state.generation;

      if (!cont) { resetState(); return; }

      const curEl = state.currentEl;
      const adjEl = state.adjacentEl;
      if (!curEl) { cleanupDOM(); resetState(); return; }

      // If offset is negligible, skip animation entirely (transitionend won't fire)
      if (!commit && Math.abs(state.offsetX) < 1 && !adjEl) {
        cleanupDOM();
        resetState();
        return;
      }

      detachOnEnd();

      if (commit && adjEl) {
        const curTarget = swipeDir * cw;
        const newTabId = getTabs()[state.adjacentIndex]?.id;
        const oldEl = curEl;

        // 1) Update tab bar IMMEDIATELY.
        if (newTabId) {
          flushSync(() => onSwitchTab(newTabId));
          oldEl.style.visibility = 'visible';
          oldEl.style.contentVisibility = 'visible';
        }

        // 2) Scale animation duration with remaining distance for a natural feel.
        const remainingPct = 1 - Math.abs(state.offsetX) / cw;
        const duration = Math.max(SNAP_DURATION, Math.round(remainingPct * 500));

        // 3) Set transition property NOW (tells browser "animate transform changes").
        curEl.style.transition = `transform ${duration}ms ${SNAP_EASING}`;
        adjEl.style.transition = `transform ${duration}ms ${SNAP_EASING}`;

        // 4) Defer the TARGET transform to the next frame.
        //    This guarantees the browser has painted the current tracking position
        //    as the "from" state. Setting transition + target in the same frame
        //    causes WKWebView to skip the animation entirely.
        const capturedCurEl = curEl;
        const capturedAdjEl = adjEl;
        requestAnimationFrame(() => {
          if (state.generation !== gen) return;
          capturedCurEl.style.transform = `translateX(${curTarget}px)`;
          capturedAdjEl.style.transform = 'translateX(0)';
        });

        const onEnd = (e?: Event) => {
          if (e instanceof TransitionEvent && e.propertyName !== 'transform') return;
          if (state.generation !== gen) return;
          traceTabSwipe('snap_end', {
            ...durationBaseDetail,
            result: 'commit',
            durationMs: duration,
          });
          state.generation++;
          clearAllTimers();
          detachOnEnd();
          oldEl.style.visibility = '';
          oldEl.style.contentVisibility = 'hidden';
          for (let i = 0; i < cont.children.length; i++) {
            const el = cont.children[i] as HTMLElement;
            el.style.transform = '';
            el.style.transition = '';
          }
          resetState();
          state.cooldownUntil = performance.now() + COMMIT_COOLDOWN;
          state.suppressMomentumTail = true;
          state.suppressMomentumTailUntil = performance.now() + POST_COMMIT_TAIL_WINDOW;
          state.suppressMomentumTailDeltaSign = swipeDir === 1 ? -1 : 1;
        };
        adjEl.addEventListener('transitionend', onEnd as EventListener, { once: true });
        state.activeOnEnd = onEnd;
        state.activeOnEndEl = adjEl;
        // +32ms accounts for rAF delay before transition starts
        state.snapTimer = setTimeout(onEnd, duration + SNAP_SAFETY_BUFFER + 32);
      } else {
        // Bounce back — defer target to next frame for reliable transition
        curEl.style.transition = `transform ${SNAP_DURATION}ms ${SNAP_EASING}`;
        if (adjEl) {
          adjEl.style.transition = `transform ${SNAP_DURATION}ms ${SNAP_EASING}`;
        }

        const capturedCurEl = curEl;
        const capturedAdjEl = adjEl;
        const bounceAdjBase = swipeDir > 0 ? -cw : cw;
        requestAnimationFrame(() => {
          if (state.generation !== gen) return;
          capturedCurEl.style.transform = 'translateX(0)';
          if (capturedAdjEl) {
            capturedAdjEl.style.transform = `translateX(${bounceAdjBase}px)`;
          }
        });

        const listenEl = adjEl ?? curEl;
        const onEnd = (e?: Event) => {
          if (e instanceof TransitionEvent && e.propertyName !== 'transform') return;
          if (state.generation !== gen) return;
          traceTabSwipe('snap_end', {
            ...durationBaseDetail,
            result: 'bounce',
            durationMs: SNAP_DURATION,
          });
          state.generation++;
          clearAllTimers();
          detachOnEnd();
          cleanupDOM();
          resetState();
          state.cooldownUntil = performance.now() + BOUNCE_COOLDOWN;
          state.suppressMomentumTail = true;
          state.suppressMomentumTailUntil = 0;
          state.suppressMomentumTailDeltaSign = 0;
        };
        listenEl.addEventListener('transitionend', onEnd as EventListener, { once: true });
        state.activeOnEnd = onEnd;
        state.activeOnEndEl = listenEl;
        state.snapTimer = setTimeout(onEnd, SNAP_DURATION + SNAP_SAFETY_BUFFER + 32);
      }
    }

    // ─── Snap decision ────────────────────────────────────────

    function makeSnapDecision(source: SnapDecisionSource = 'manual') {
      if (state.phase !== 'tracking') return;
      const cont = contentRef.current;
      if (!cont) { resetState(); return; }

      const cw = cont.clientWidth;
      const v = getVelocity();
      const offsetDir: -1 | 1 = state.offsetX > 0 ? 1 : -1;

      const positionTriggered = Math.abs(state.offsetX) > cw * POSITION_THRESHOLD;
      const velocityTriggered = Math.abs(v) > COMMIT_VELOCITY;

      let shouldCommit = state.adjacentEl !== null && (positionTriggered || velocityTriggered);
      if (shouldCommit && velocityTriggered && !positionTriggered) {
        const velDir = v > 0 ? 1 : -1;
        if (velDir !== offsetDir) shouldCommit = false;
      }

      traceTabSwipe('decision', {
        gestureId: state.traceGestureId,
        source,
        shouldCommit,
        positionTriggered,
        velocityTriggered,
        offsetX: roundPx(state.offsetX),
        offsetPct: roundPct(Math.abs(state.offsetX) / cw),
        velocity: Math.round(v),
        offsetDir,
        adjacentIndex: state.adjacentIndex,
        sampleCount: state.traceSampleCount,
        elapsedMs: state.traceTrackingStartedAt > 0 ? Math.round(performance.now() - state.traceTrackingStartedAt) : 0,
      });
      animateSnap(shouldCommit, offsetDir);
    }

    function ensureTraceGestureId() {
      if (state.phase === 'idle' && state.direction === null && state.traceSampleCount === 0) {
        state.traceGestureId++;
      }
    }

    function traceIdleScheduled(detail: PerfTraceDetail & { reason: string; timeoutMs: number }) {
      const key = `${detail.reason}:${detail.timeoutMs}`;
      if (key === state.traceLastIdleKey && !shouldTraceSample(state.traceSampleCount)) return;
      state.traceLastIdleKey = key;
      traceTabSwipe('idle_scheduled', detail);
    }

    // ─── Main wheel handler ───────────────────────────────────

    function handleWheel(e: WheelEvent) {
      // Absorb events during cooldown (post-animation inertial events)
      if (state.cooldownUntil > 0 && performance.now() < state.cooldownUntil) {
        state.traceCooldownAbsorbCount++;
        if (shouldTraceCooldownAbsorb(state.traceCooldownAbsorbCount)) {
          traceTabSwipe('cooldown_absorb', {
            gestureId: state.traceGestureId,
            remainingMs: Math.max(0, Math.round(state.cooldownUntil - performance.now())),
            deltaX: roundPx(e.deltaX),
            deltaY: roundPx(e.deltaY),
          });
        }
        e.preventDefault();
        return;
      }
      state.cooldownUntil = 0;
      state.traceCooldownAbsorbCount = 0;

      const tabs = getTabs();
      if (tabs.length <= 1) {
        if (state.phase !== 'idle') {
          cleanupDOM();
          resetState();
        }
        return;
      }

      const cont = contentRef.current;
      if (!cont) return;

      const { deltaX, deltaY } = e;
      // WebKit (Tauri WKWebView on macOS) may expose gesture phase.
      // Note: these are non-standard and may not be available in all browsers.
      const wheelPhase = (e as unknown as { phase?: number }).phase;
      const momentumPhase = (e as unknown as { momentumPhase?: number }).momentumPhase;
      const zeroDelta = deltaX === 0 && deltaY === 0;

      if (state.suppressMomentumTail) {
        const now = performance.now();
        const activeMomentumTail = isActiveMomentumPhase(momentumPhase);
        const hasExplicitPhase = typeof wheelPhase === 'number' || typeof momentumPhase === 'number';
        const smallNoPhaseTail = !activeMomentumTail
          && !hasExplicitPhase
          && now < state.suppressMomentumTailUntil
          && isSmallPostCommitTail(deltaX, deltaY, state.suppressMomentumTailDeltaSign);

        if (activeMomentumTail || smallNoPhaseTail) {
          state.tracePostCommitTailAbsorbCount++;
          if (shouldTraceCooldownAbsorb(state.tracePostCommitTailAbsorbCount)) {
            traceTabSwipe(activeMomentumTail ? 'post_commit_momentum_absorb' : 'post_commit_tail_absorb', {
              gestureId: state.traceGestureId,
              deltaX: roundPx(deltaX),
              deltaY: roundPx(deltaY),
              wheelPhase: phaseValue(wheelPhase),
              momentumPhase: phaseValue(momentumPhase),
              remainingMs: Math.max(0, Math.round(state.suppressMomentumTailUntil - now)),
            });
          }
          e.preventDefault();
          return;
        }
        state.suppressMomentumTail = false;
        state.suppressMomentumTailUntil = 0;
        state.suppressMomentumTailDeltaSign = 0;
        state.tracePostCommitTailAbsorbCount = 0;
      }

      if (
        state.phase === 'idle'
        && state.direction === null
        && (Math.abs(deltaX) >= DIR_LOCK_MIN || typeof wheelPhase === 'number' || typeof momentumPhase === 'number')
      ) {
        ensureTraceGestureId();
      }

      const nextSample = state.phase === 'tracking' ? state.traceSampleCount + 1 : state.traceSampleCount;
      if (
        (state.phase !== 'idle' && shouldTraceSample(nextSample))
        || Math.abs(deltaX) >= DIR_LOCK_MIN
        || typeof wheelPhase === 'number'
        || typeof momentumPhase === 'number'
      ) {
        traceTabSwipe('sample', {
          gestureId: state.traceGestureId,
          sample: nextSample,
          state: state.phase,
          direction: directionValue(state.direction),
          deltaX: roundPx(deltaX),
          deltaY: roundPx(deltaY),
          wheelPhase: phaseValue(wheelPhase),
          momentumPhase: phaseValue(momentumPhase),
          zeroDelta,
          target: targetKind(e.target),
        });
      }

      if (zeroDelta) {
        if (typeof wheelPhase === 'number' || typeof momentumPhase === 'number') {
          traceTabSwipe('zero_delta_phase', {
            gestureId: state.traceGestureId,
            state: state.phase,
            direction: directionValue(state.direction),
            wheelPhase: phaseValue(wheelPhase),
            momentumPhase: phaseValue(momentumPhase),
          });
        }
        if (
          state.phase === 'tracking'
          && (wheelPhase === WEBKIT_PHASE_ENDED || wheelPhase === WEBKIT_PHASE_CANCELLED)
        ) {
          if (state.idleTimer !== null) { clearTimeout(state.idleTimer); state.idleTimer = null; }
          traceTabSwipe('release', {
            gestureId: state.traceGestureId,
            source: 'webkit-phase',
            wheelPhase: phaseValue(wheelPhase),
            momentumPhase: phaseValue(momentumPhase),
            zeroDelta: true,
          });
          makeSnapDecision('webkit-phase');
        }
        return;
      }

      // ── Direction lock ──
      if (state.direction === null && state.phase !== 'animating') {
        const ax = Math.abs(deltaX);
        const ay = Math.abs(deltaY);
        if (ax < DIR_LOCK_MIN && ay < DIR_LOCK_MIN) return;
        if (ax > ay * DIR_LOCK_RATIO) {
          // Horizontal gesture — but nested horizontal interaction islands own
          // the gesture before the app-level tab switcher does.
          const ownership = resolveHorizontalGestureOwnership(e, cont);
          if (ownership.owner === 'inner-horizontal') {
            state.direction = 'inner-scroll';
          } else {
            state.direction = 'horizontal';
          }
          traceTabSwipe('direction_lock', {
            gestureId: state.traceGestureId,
            direction: directionValue(state.direction),
            absX: roundPx(ax),
            absY: roundPx(ay),
            ratio: ay > 0 ? roundPct(ax / ay) : 99,
            innerScroll: ownership.owner === 'inner-horizontal',
            ownerReason: ownership.reason,
            ownerElement: horizontalGestureOwnerTag(ownership.element),
            target: targetKind(e.target),
          });
        } else {
          state.direction = 'vertical';
          scheduleDirectionReset();
          traceTabSwipe('direction_lock', {
            gestureId: state.traceGestureId,
            direction: 'vertical',
            absX: roundPx(ax),
            absY: roundPx(ay),
            ratio: ay > 0 ? roundPct(ax / ay) : 99,
            innerScroll: false,
            target: targetKind(e.target),
          });
        }
        if (state.direction === 'vertical') return;
      }

      if (state.direction === 'vertical' || state.direction === 'inner-scroll') {
        const previousDirection = state.direction;
        const horizontalDominant = isHorizontalDominant(deltaX, deltaY);
        if (previousDirection === 'inner-scroll' && horizontalDominant) {
          const ownership = resolveHorizontalGestureOwnership(e, cont);
          if (ownership.owner === 'inner-horizontal') {
            scheduleDirectionReset();
            traceTabSwipe('direction_defer', {
              gestureId: state.traceGestureId,
              direction: directionValue(state.direction),
              resetMs: DIR_RESET_TIMEOUT,
              ownerReason: ownership.reason,
              ownerElement: horizontalGestureOwnerTag(ownership.element),
            });
            return;
          }
          if (state.dirResetTimer !== null) {
            clearTimeout(state.dirResetTimer);
            state.dirResetTimer = null;
          }
          state.direction = 'horizontal';
          traceTabSwipe('direction_relock', {
            gestureId: state.traceGestureId,
            from: previousDirection,
            to: directionValue(state.direction),
            absX: roundPx(Math.abs(deltaX)),
            absY: roundPx(Math.abs(deltaY)),
            innerScroll: false,
            ownerReason: ownership.reason,
            ownerElement: horizontalGestureOwnerTag(ownership.element),
            target: targetKind(e.target),
          });
        } else {
          if (!horizontalDominant) {
            scheduleDirectionReset();
          }
          traceTabSwipe('direction_defer', {
            gestureId: state.traceGestureId,
            direction: directionValue(state.direction),
            resetMs: DIR_RESET_TIMEOUT,
          });
          return;
        }
      }

      e.preventDefault();

      // ── All animations are final — absorb events until completion + cooldown ──
      if (state.phase === 'animating') {
        return;
      }

      // ── Init tracking ──
      const activeIndex = getActiveIndex();
      if (activeIndex === -1) {
        // Tab was removed mid-gesture — clean up stale tracking state
        if (state.phase === 'tracking') { cleanupDOM(); resetState(); }
        return;
      }
      const cw = cont.clientWidth;
      if (cw === 0) return; // container hidden or not laid out yet

      if (state.phase === 'idle') {
        state.phase = 'tracking';
        state.offsetX = 0;
        state.velocitySamples = [];
        state.currentEl = getTabEl(activeIndex);
        state.adjacentEl = null;
        state.adjacentIndex = -1;
        state.mergeCount = 0;
        state.mergeDeltaSum = 0;
        state.mergeTimeSum = 0;
        state.prevMergedPoint = null;
        state.prevMergedVelocity = 0;
        state.accFactors = [];
        state.momentumFlag = false;
        state.traceSampleCount = 0;
        state.traceTrackingStartedAt = performance.now();
        state.traceLastIdleKey = null;
        traceTabSwipe('begin', {
          gestureId: state.traceGestureId,
          activeIndex,
          tabCount: tabs.length,
          width: cw,
          currentReady: state.currentEl !== null,
        });
      }

      // ── Accumulate offset (CLAMPED to ±containerWidth) ──
      state.traceSampleCount++;
      state.offsetX = clamp(state.offsetX - deltaX, -cw, cw);
      addSample(-deltaX);

      // ── Feed momentum detector (side-effect: updates state.momentumFlag) ──
      feedMomentumDetector(-deltaX);

      // ── Resolve adjacent tab ──
      const wantIdx = state.offsetX > 0
        ? activeIndex - 1
        : activeIndex + 1;
      const atBoundary = wantIdx < 0 || wantIdx >= tabs.length;

      if (!atBoundary && state.adjacentIndex !== wantIdx) {
        if (state.adjacentEl && state.adjacentIndex !== activeIndex) hideTab(state.adjacentEl);
        state.adjacentIndex = wantIdx;
        state.adjacentEl = getTabEl(wantIdx);
        if (state.adjacentEl) {
          const wasInvisible = state.adjacentEl.classList.contains('invisible');
          const contentVisibility = state.adjacentEl.style.contentVisibility || 'css';
          const adjOff = state.offsetX > 0 ? -cw + state.offsetX : cw + state.offsetX;
          state.adjacentEl.style.transform = `translateX(${adjOff}px)`;
          showTab(state.adjacentEl);
          traceTabSwipe('neighbor_prepare', {
            gestureId: state.traceGestureId,
            activeIndex,
            adjacentIndex: state.adjacentIndex,
            wasInvisible,
            contentVisibility,
            offsetX: roundPx(state.offsetX),
          });
        }
      }

      // ── Apply transforms ──
      let visOffset = state.offsetX;
      if (atBoundary) {
        visOffset = rubberBand(state.offsetX);
        if (state.adjacentEl && state.adjacentIndex !== activeIndex) {
          hideTab(state.adjacentEl);
          state.adjacentEl = null;
          state.adjacentIndex = -1;
        }
      }

      if (state.currentEl) {
        state.currentEl.style.transform = `translateX(${visOffset}px)`;
      }
      if (state.adjacentEl && !atBoundary) {
        const adjOff = state.offsetX > 0
          ? -cw + visOffset
          : cw + visOffset;
        state.adjacentEl.style.transform = `translateX(${adjOff}px)`;
      }
      if (shouldTraceSample(state.traceSampleCount)) {
        traceTabSwipe('update', {
          gestureId: state.traceGestureId,
          sample: state.traceSampleCount,
          offsetX: roundPx(state.offsetX),
          visualOffsetX: roundPx(visOffset),
          offsetPct: roundPct(Math.abs(state.offsetX) / cw),
          velocity: Math.round(getVelocity()),
          atBoundary,
          adjacentIndex: state.adjacentIndex,
          momentum: state.momentumFlag,
        });
      }

      // ── Inferred momentum release ──
      // Some WebViews do not expose WebKit phase/momentumPhase, but still emit
      // a long decaying wheel tail after the fingers leave the trackpad. Once
      // the acceleration-factor detector confirms that tail, treat it as the
      // missing release signal so the active tab and visual page stay in sync.
      if (state.momentumFlag) {
        if (state.idleTimer !== null) { clearTimeout(state.idleTimer); state.idleTimer = null; }
        traceTabSwipe('release', {
          gestureId: state.traceGestureId,
          source: 'momentum-detector',
          wheelPhase: phaseValue(wheelPhase),
          momentumPhase: phaseValue(momentumPhase),
        });
        makeSnapDecision('momentum-detector');
        return;
      }

      // ── WebKit phase-based gesture end (if available) ──
      if (wheelPhase === WEBKIT_PHASE_ENDED || wheelPhase === WEBKIT_PHASE_CANCELLED) {
        if (state.idleTimer !== null) { clearTimeout(state.idleTimer); state.idleTimer = null; }
        traceTabSwipe('release', {
          gestureId: state.traceGestureId,
          source: 'webkit-phase',
          wheelPhase: phaseValue(wheelPhase),
          momentumPhase: phaseValue(momentumPhase),
        });
        makeSnapDecision('webkit-phase');
        return;
      }

      // ── WebKit momentum phase: finger already lifted ──
      if (typeof momentumPhase === 'number' && momentumPhase > 0) {
        if (state.idleTimer !== null) { clearTimeout(state.idleTimer); state.idleTimer = null; }
        traceTabSwipe('release', {
          gestureId: state.traceGestureId,
          source: 'momentum-phase',
          wheelPhase: phaseValue(wheelPhase),
          momentumPhase: phaseValue(momentumPhase),
        });
        makeSnapDecision('momentum-phase');
        return;
      }

      // ── Idle timer (velocity-aware) ──
      // Timer resets on every event; only fires when events STOP.
      // Timeout scales with recent velocity:
      //   - Inertia tail (momentum + tiny delta) → 150ms (inertia ending)
      //   - Fast movement (v > COMMIT_VELOCITY)  → 200ms (quick flick → decide fast)
      //   - Slow / paused                        → 500ms (finger might still be on pad)
      if (atBoundary) {
        if (state.idleTimer !== null) clearTimeout(state.idleTimer);
        state.idleTimer = setTimeout(() => {
          traceTabSwipe('release', {
            gestureId: state.traceGestureId,
            source: 'idle-boundary',
            timeoutMs: IDLE_BOUNDARY,
          });
          makeSnapDecision('idle');
        }, IDLE_BOUNDARY);
        traceIdleScheduled({
          gestureId: state.traceGestureId,
          reason: 'boundary',
          timeoutMs: IDLE_BOUNDARY,
        });
      } else {
        if (state.idleTimer !== null) clearTimeout(state.idleTimer);
        const absDelta = Math.abs(deltaX);
        const isInertiaTail = state.momentumFlag && absDelta < INERTIA_TAIL_THRESHOLD;
        const recentV = Math.abs(getVelocity());
        const timeout = isInertiaTail ? IDLE_INERTIA_TAIL
          : recentV > COMMIT_VELOCITY ? IDLE_FAST
          : IDLE_SLOW;
        state.idleTimer = setTimeout(() => {
          traceTabSwipe('release', {
            gestureId: state.traceGestureId,
            source: 'idle',
            timeoutMs: timeout,
            reason: isInertiaTail ? 'inertia-tail' : recentV > COMMIT_VELOCITY ? 'fast' : 'slow',
          });
          makeSnapDecision('idle');
        }, timeout);
        traceIdleScheduled({
          gestureId: state.traceGestureId,
          reason: isInertiaTail ? 'inertia-tail' : recentV > COMMIT_VELOCITY ? 'fast' : 'slow',
          timeoutMs: timeout,
          recentVelocity: Math.round(recentV),
          absDelta: roundPx(absDelta),
        });
      }
    }

    container.addEventListener('wheel', handleWheel, { passive: false });
    traceTabSwipe('listener_attached');

    return () => {
      container.removeEventListener('wheel', handleWheel);
      traceTabSwipe('listener_detached');
      cleanupDOM();
      resetState();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- command getters are stable
  }, []);
}
