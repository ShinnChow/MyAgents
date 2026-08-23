import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { useVirtuosoScroll } from '@/hooks/useVirtuosoScroll';
import type { RowLayoutChangeReason } from '@/context/ChatRowLayoutContext';
import type { Message as MessageType } from '@/types/chat';
import type { MainWindowPresentation } from '@/utils/mainWindowPresentation';

export interface ScrollAnchorSnapshot {
  messageId: string;
  offsetFromViewportTop: number;
  label: string;
}

export interface ScrollToMessageOptions {
  align?: 'start' | 'center' | 'end';
  behavior?: 'smooth' | 'auto';
  pauseMs?: number;
}

export interface RestoreAnchorOptions {
  behavior?: 'auto' | 'smooth';
}

export interface ChatScrollController {
  virtuosoRef: ReturnType<typeof useVirtuosoScroll>['virtuosoRef'];
  scrollerRef: ReturnType<typeof useVirtuosoScroll>['scrollerRef'];
  followEnabledRef: ReturnType<typeof useVirtuosoScroll>['followEnabledRef'];
  attachScroller: ReturnType<typeof useVirtuosoScroll>['attachScroller'];
  scrollToBottom: ReturnType<typeof useVirtuosoScroll>['scrollToBottom'];
  pauseAutoScroll: ReturnType<typeof useVirtuosoScroll>['pauseAutoScroll'];
  handleAtBottomChange: ReturnType<typeof useVirtuosoScroll>['handleAtBottomChange'];
  onViewportAdmissionChanged: (admitted: boolean, presentationGeneration: number) => void;
  onItemsRendered: () => void;
  isViewportRecoveryFenced: boolean;
  scrollToMessage: (messageId: string, options?: ScrollToMessageOptions) => void;
  scrollToTool: (toolId: string, hostMessageId?: string) => void;
  captureAnchor: (label: string) => ScrollAnchorSnapshot | null;
  restoreAnchorAfterNextCommit: (anchor: ScrollAnchorSnapshot, options?: RestoreAnchorOptions) => void;
  onRowLayoutChanged: (messageId: string, reason: RowLayoutChangeReason) => void;
}

export interface UseChatScrollControllerOptions {
  messages: readonly MessageType[];
  isActive: boolean;
  windowPresentation?: MainWindowPresentation;
  sessionId?: string | null;
  rootRef?: RefObject<HTMLElement | null>;
}

interface ViewportContinuitySnapshot {
  id: number;
  sessionId: string | null;
  follow: boolean;
  anchor: ScrollAnchorSnapshot | null;
  presentationGeneration: number;
}

interface PendingAnchorRestore {
  id: number;
  anchor: ScrollAnchorSnapshot;
  options?: RestoreAnchorOptions;
  pending: boolean;
  source: 'layout' | 'continuity';
  mountRequested: boolean;
  presentationGeneration: number;
}

interface TrustedViewportAnchor {
  sessionId: string | null;
  anchor: ScrollAnchorSnapshot;
}

const MESSAGE_SCOPE_SELECTOR = '[data-chat-search-scope][data-message-id]';
const DEFAULT_JUMP_PAUSE_MS = 2000;
const DEFAULT_WINDOW_PRESENTATION: MainWindowPresentation = {
  surfaceAvailable: true,
  generation: 0,
};

function shouldPinBottomAfterNextCommit(reason: RowLayoutChangeReason): boolean {
  return reason === 'attachment-settle' || reason === 'widget-resize';
}

function isDirectRowToggle(reason: RowLayoutChangeReason): boolean {
  return reason === 'process-row-expand'
    || reason === 'process-row-collapse'
    || reason === 'user-message-expand'
    || reason === 'block-group-expand'
    || reason === 'expandable-container-expand';
}

function escapeCssIdentifier(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/"/g, '\\"');
}

function findMessageScope(root: HTMLElement, messageId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    `[data-chat-search-scope][data-message-id="${escapeCssIdentifier(messageId)}"]`,
  );
}

function getScrollerRect(scroller: HTMLElement): DOMRect {
  return scroller.getBoundingClientRect();
}

function getVisibleMessageScopes(scroller: HTMLElement): HTMLElement[] {
  const scrollerRect = getScrollerRect(scroller);
  return Array.from(scroller.querySelectorAll<HTMLElement>(MESSAGE_SCOPE_SELECTOR))
    .filter((el) => {
      const rect = el.getBoundingClientRect();
      return rect.bottom > scrollerRect.top + 1 && rect.top < scrollerRect.bottom - 1;
    })
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
}

function getToolHostMessageId(messages: readonly MessageType[], toolId: string): string | null {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    const found = message.content.some(block =>
      (block.type === 'tool_use' || block.type === 'server_tool_use') && block.tool?.id === toolId
    );
    if (found) return message.id;
  }
  return null;
}

export function useChatScrollController({
  messages,
  isActive,
  windowPresentation = DEFAULT_WINDOW_PRESENTATION,
  sessionId,
  rootRef,
}: UseChatScrollControllerOptions): ChatScrollController {
  const userScrollIntentRef = useRef<() => void>(() => {});
  const forwardUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current();
  }, []);
  const {
    virtuosoRef,
    scrollerRef,
    followEnabledRef,
    attachScroller: attachVirtuosoScroller,
    scrollToBottom: performScrollToBottom,
    pauseAutoScroll,
    handleAtBottomChange,
  } = useVirtuosoScroll({ onUserScrollIntent: forwardUserScrollIntent });
  const messagesRef = useRef(messages);
  // Ref mirror for stable imperative callbacks; handlers read this after commit.
  // eslint-disable-next-line react-hooks/refs
  messagesRef.current = messages;
  const isActiveRef = useRef(isActive);
  // eslint-disable-next-line react-hooks/refs
  isActiveRef.current = isActive;
  const sessionIdRef = useRef(sessionId ?? null);
  // eslint-disable-next-line react-hooks/refs
  sessionIdRef.current = sessionId ?? null;
  const rootRefRef = useRef(rootRef);
  // eslint-disable-next-line react-hooks/refs
  rootRefRef.current = rootRef;
  const pendingAnchorRef = useRef<PendingAnchorRestore | null>(null);
  const [anchorRestoreTick, setAnchorRestoreTick] = useState(0);
  const pendingBottomPinRef = useRef(false);
  const [bottomPinTick, setBottomPinTick] = useState(0);
  // Admission is an epoch token, not a boolean. App may commit a newer native
  // generation before MessageList's layout effect publishes its false edge;
  // callbacks from the previously admitted generation must already fail closed
  // during that parent/child effect gap.
  const admittedPresentationGenerationRef = useRef<number | null>(null);
  const hasEverAdmittedRef = useRef(false);
  const presentationGenerationRef = useRef(windowPresentation.generation);
  // eslint-disable-next-line react-hooks/refs
  presentationGenerationRef.current = windowPresentation.generation;
  const continuitySequenceRef = useRef(0);
  const continuitySnapshotRef = useRef<ViewportContinuitySnapshot | null>(null);
  const lastTrustedAnchorRef = useRef<TrustedViewportAnchor | null>(null);
  const [recoveryFenceId, setRecoveryFenceId] = useState<number | null>(null);
  const isCurrentViewportAdmitted = useCallback(() => (
    admittedPresentationGenerationRef.current === presentationGenerationRef.current
  ), []);

  const cancelContinuity = useCallback(() => {
    const continuity = continuitySnapshotRef.current;
    const pending = pendingAnchorRef.current?.source === 'continuity'
      ? pendingAnchorRef.current
      : null;
    const continuityId = continuity?.id ?? pending?.id ?? null;
    continuitySnapshotRef.current = null;
    if (pending) pendingAnchorRef.current = null;
    if (continuityId !== null) {
      setRecoveryFenceId(current => current === continuityId ? null : current);
    }
  }, []);
  // eslint-disable-next-line react-hooks/refs
  userScrollIntentRef.current = cancelContinuity;
  const scrollToBottom = useCallback((behavior?: 'smooth' | 'auto') => {
    cancelContinuity();
    performScrollToBottom(behavior);
  }, [cancelContinuity, performScrollToBottom]);

  const messageIndexById = useMemo(() => {
    const map = new Map<string, number>();
    messages.forEach((message, index) => map.set(message.id, index));
    return map;
  }, [messages]);
  const messageIndexByIdRef = useRef(messageIndexById);
  // eslint-disable-next-line react-hooks/refs
  messageIndexByIdRef.current = messageIndexById;

  const readAnchor = useCallback((label: string): ScrollAnchorSnapshot | null => {
    const scroller = scrollerRef.current;
    if (!scroller) return null;
    const scopes = getVisibleMessageScopes(scroller);
    if (scopes.length === 0) return null;
    const scrollerTop = getScrollerRect(scroller).top;
    const anchorEl = scopes.find(el => el.getBoundingClientRect().top >= scrollerTop - 1) ?? scopes[0];
    const messageId = anchorEl.getAttribute('data-message-id');
    if (!messageId) return null;
    return {
      messageId,
      offsetFromViewportTop: anchorEl.getBoundingClientRect().top - scrollerTop,
      label,
    };
  }, [scrollerRef]);

  const captureAnchor = useCallback((label: string): ScrollAnchorSnapshot | null => {
    if (!isActiveRef.current || !isCurrentViewportAdmitted()) return null;
    return readAnchor(label);
  }, [isCurrentViewportAdmitted, readAnchor]);

  const rememberTrustedAnchor = useCallback((label: string) => {
    if (!isCurrentViewportAdmitted() || followEnabledRef.current !== false) return;
    const anchor = readAnchor(label);
    if (!anchor) return;
    lastTrustedAnchorRef.current = {
      sessionId: sessionIdRef.current,
      anchor,
    };
  }, [followEnabledRef, isCurrentViewportAdmitted, readAnchor]);

  const completePendingAnchor = useCallback((restoreIntent: PendingAnchorRestore) => {
    if (pendingAnchorRef.current === restoreIntent) {
      pendingAnchorRef.current = null;
    }
    if (restoreIntent.source === 'continuity') {
      continuitySnapshotRef.current = null;
      setRecoveryFenceId(current => current === restoreIntent.id ? null : current);
    }
  }, []);

  const restoreAnchor = useCallback((
    anchor: ScrollAnchorSnapshot,
    options: RestoreAnchorOptions | undefined,
    restoreIntent: PendingAnchorRestore,
  ) => {
    if (
      restoreIntent.presentationGeneration !== presentationGenerationRef.current
      || admittedPresentationGenerationRef.current !== restoreIntent.presentationGeneration
    ) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const restoreSessionId = sessionIdRef.current;
    const index = messageIndexByIdRef.current.get(anchor.messageId);
    if (index === undefined) {
      if (import.meta.env.DEV) {
        console.debug('[chat-scroll] Skipping deleted anchor', {
          sessionId: restoreSessionId,
          messageId: anchor.messageId,
          label: anchor.label,
        });
      }
      completePendingAnchor(restoreIntent);
      return;
    }

    const adjustOffset = () => {
      if (
        !isActiveRef.current
        || restoreIntent.presentationGeneration !== presentationGenerationRef.current
        || admittedPresentationGenerationRef.current !== restoreIntent.presentationGeneration
        || sessionIdRef.current !== restoreSessionId
        || pendingAnchorRef.current !== restoreIntent
      ) return;
      const scope = findMessageScope(scroller, anchor.messageId);
      if (!scope) return false;
      const scrollerTop = getScrollerRect(scroller).top;
      const nextOffset = scope.getBoundingClientRect().top - scrollerTop;
      const delta = nextOffset - anchor.offsetFromViewportTop;
      if (Math.abs(delta) >= 1) {
        virtuosoRef.current?.scrollBy({ top: delta, behavior: options?.behavior ?? 'auto' });
      }
      return true;
    };

    const mountedScope = findMessageScope(scroller, anchor.messageId);
    if (mountedScope) {
      if (adjustOffset()) {
        lastTrustedAnchorRef.current = { sessionId: restoreSessionId, anchor };
        completePendingAnchor(restoreIntent);
      }
      return;
    }

    // Normal row-layout compensation only targets a currently visible row. If
    // it vanished, fail closed instead of exposing a start-aligned jump.
    if (restoreIntent.source === 'layout') {
      completePendingAnchor(restoreIntent);
      return;
    }

    // Continuity recovery is presentation-fenced. Ask Virtuoso to mount the
    // exact item once, then finish from its itemsRendered callback; no RAF or
    // timer guesses when WebView geometry becomes trustworthy.
    if (!restoreIntent.mountRequested) {
      restoreIntent.mountRequested = true;
      virtuosoRef.current?.scrollToIndex({
        index,
        align: 'start',
        behavior: options?.behavior ?? 'auto',
      });
    }
  }, [completePendingAnchor, scrollerRef, virtuosoRef]);

  const restoreAnchorAfterNextCommit = useCallback((anchor: ScrollAnchorSnapshot, options?: RestoreAnchorOptions) => {
    if (!isCurrentViewportAdmitted()) return;
    if (pendingAnchorRef.current?.source === 'continuity') return;
    pendingAnchorRef.current = {
      id: ++continuitySequenceRef.current,
      anchor,
      options,
      pending: true,
      source: 'layout',
      mountRequested: false,
      presentationGeneration: presentationGenerationRef.current,
    };
    setAnchorRestoreTick(tick => tick + 1);
  }, [isCurrentViewportAdmitted]);

  const onViewportAdmissionChanged = useCallback((
    admitted: boolean,
    presentationGeneration: number,
  ) => {
    // A layout effect from an older presentation must not open or settle a
    // transaction after App has already advanced the native surface epoch.
    if (presentationGeneration !== presentationGenerationRef.current) return;

    if (!admitted) {
      if (admittedPresentationGenerationRef.current === null) {
        // A second suspension reason (for example inactive Tab followed by a
        // native minimize) keeps the original user intent but advances the
        // generation that must admit its eventual recovery.
        const existing = continuitySnapshotRef.current;
        if (existing && existing.presentationGeneration !== presentationGeneration) {
          continuitySnapshotRef.current = {
            ...existing,
            presentationGeneration,
          };
        }
        return;
      }
      admittedPresentationGenerationRef.current = null;
      if (!hasEverAdmittedRef.current) return;
      pendingAnchorRef.current = null;
      pendingBottomPinRef.current = false;
      const follow = followEnabledRef.current !== false;
      const trusted = lastTrustedAnchorRef.current;
      const id = ++continuitySequenceRef.current;
      continuitySnapshotRef.current = {
        id,
        sessionId: sessionIdRef.current,
        follow,
        anchor: follow || trusted?.sessionId !== sessionIdRef.current ? null : trusted.anchor,
        presentationGeneration,
      };
      setRecoveryFenceId(id);
      return;
    }

    if (admittedPresentationGenerationRef.current === presentationGeneration) return;
    admittedPresentationGenerationRef.current = presentationGeneration;
    hasEverAdmittedRef.current = true;
    const snapshot = continuitySnapshotRef.current;
    if (!snapshot) {
      rememberTrustedAnchor('viewport-admitted');
      return;
    }
    if (
      snapshot.sessionId !== sessionIdRef.current
      || snapshot.presentationGeneration !== presentationGeneration
    ) {
      continuitySnapshotRef.current = null;
      setRecoveryFenceId(current => current === snapshot.id ? null : current);
      return;
    }

    if (snapshot.follow) {
      followEnabledRef.current = true;
      continuitySnapshotRef.current = null;
      if (messagesRef.current.length > 0) performScrollToBottom('auto');
      setRecoveryFenceId(current => current === snapshot.id ? null : current);
      return;
    }

    followEnabledRef.current = false;
    if (!snapshot.anchor) {
      continuitySnapshotRef.current = null;
      setRecoveryFenceId(current => current === snapshot.id ? null : current);
      return;
    }

    pendingAnchorRef.current = {
      id: snapshot.id,
      anchor: snapshot.anchor,
      options: { behavior: 'auto' },
      pending: true,
      source: 'continuity',
      mountRequested: false,
      presentationGeneration: snapshot.presentationGeneration,
    };
    setAnchorRestoreTick(tick => tick + 1);
  }, [followEnabledRef, performScrollToBottom, rememberTrustedAnchor]);

  const committedSessionIdRef = useRef(sessionId ?? null);
  useLayoutEffect(() => {
    const nextSessionId = sessionId ?? null;
    if (committedSessionIdRef.current === nextSessionId) return;
    committedSessionIdRef.current = nextSessionId;
    lastTrustedAnchorRef.current = null;
    const continuity = continuitySnapshotRef.current;
    continuitySnapshotRef.current = null;
    pendingAnchorRef.current = null;
    pendingBottomPinRef.current = false;
    if (continuity) {
      setRecoveryFenceId(current => current === continuity.id ? null : current);
    }
  }, [sessionId]);

  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    if (!pending?.pending) return;
    if (
      !isActiveRef.current
      || !isCurrentViewportAdmitted()
      || pending.presentationGeneration !== presentationGenerationRef.current
    ) return;
    pending.pending = false;
    restoreAnchor(pending.anchor, pending.options, pending);
  }, [anchorRestoreTick, isCurrentViewportAdmitted, restoreAnchor]);

  const onItemsRendered = useCallback(() => {
    const pending = pendingAnchorRef.current;
    if (!pending || pending.source !== 'continuity' || !pending.mountRequested) return;
    if (
      !isCurrentViewportAdmitted()
      || pending.presentationGeneration !== presentationGenerationRef.current
    ) return;
    restoreAnchor(pending.anchor, pending.options, pending);
  }, [isCurrentViewportAdmitted, restoreAnchor]);

  const pinBottomAfterNextCommit = useCallback(() => {
    pendingBottomPinRef.current = true;
    setBottomPinTick(tick => tick + 1);
  }, []);

  useLayoutEffect(() => {
    if (!pendingBottomPinRef.current) return;
    pendingBottomPinRef.current = false;
    if (!isActiveRef.current || !isCurrentViewportAdmitted() || !followEnabledRef.current) return;
    scrollToBottom('auto');
  }, [bottomPinTick, followEnabledRef, isCurrentViewportAdmitted, scrollToBottom]);

  const scrollToMessage = useCallback((messageId: string, options: ScrollToMessageOptions = {}) => {
    cancelContinuity();
    const index = messageIndexByIdRef.current.get(messageId);
    if (index === undefined) return;
    pauseAutoScroll(options.pauseMs ?? DEFAULT_JUMP_PAUSE_MS);
    virtuosoRef.current?.scrollToIndex({
      index,
      behavior: options.behavior ?? 'smooth',
      align: options.align ?? 'start',
    });
  }, [cancelContinuity, pauseAutoScroll, virtuosoRef]);

  const scrollToTool = useCallback((toolId: string, hostMessageId?: string) => {
    const messageId = hostMessageId ?? getToolHostMessageId(messagesRef.current, toolId);
    if (!messageId) return;
    const navigationGeneration = presentationGenerationRef.current;
    scrollToMessage(messageId, { align: 'center', behavior: 'smooth', pauseMs: DEFAULT_JUMP_PAUSE_MS });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (
          presentationGenerationRef.current !== navigationGeneration
          || !isCurrentViewportAdmitted()
        ) return;
        const root = rootRefRef.current?.current ?? scrollerRef.current;
        if (!root) return;
        const el = root.querySelector<HTMLElement>(`[data-tool-id="${escapeCssIdentifier(toolId)}"]`);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('agent-status-flash');
        window.setTimeout(() => el.classList.remove('agent-status-flash'), 1500);
      });
    });
  }, [isCurrentViewportAdmitted, scrollerRef, scrollToMessage]);

  const onRowLayoutChanged = useCallback((messageId: string, reason: RowLayoutChangeReason) => {
    if (!isActiveRef.current || !isCurrentViewportAdmitted()) return;
    // A click-driven disclosure must grow or shrink from the clicked row in normal
    // document flow. Restoring the first fully visible *message* is the wrong owner:
    // when the clicked row belongs to a message whose top is already above the
    // viewport, that anchor is a later message below the click. Preserving it makes
    // the disclosure expand upward and can leave WebKit's paint and hit-test geometry
    // on different scroll offsets. Virtuoso owns the row-size update; do not add a
    // second scroll correction for direct toggles.
    if (isDirectRowToggle(reason)) return;
    if (reason === 'tool-complete' && followEnabledRef.current) {
      scrollToBottom('auto');
      return;
    }
    if (shouldPinBottomAfterNextCommit(reason) && followEnabledRef.current) {
      pinBottomAfterNextCommit();
      return;
    }
    if (!messageIndexByIdRef.current.has(messageId)) return;
    const anchor = captureAnchor(reason);
    if (!anchor) return;
    restoreAnchorAfterNextCommit(anchor, { behavior: 'auto' });
  }, [captureAnchor, followEnabledRef, isCurrentViewportAdmitted, pinBottomAfterNextCommit, restoreAnchorAfterNextCommit, scrollToBottom]);

  const onViewportScroll = useCallback(() => {
    rememberTrustedAnchor('viewport-scroll');
  }, [rememberTrustedAnchor]);

  const handleViewportAtBottomChange = useCallback((atBottom: boolean) => {
    if (!isCurrentViewportAdmitted()) return;
    handleAtBottomChange(atBottom);
    if (!atBottom) rememberTrustedAnchor('at-bottom-change');
  }, [handleAtBottomChange, isCurrentViewportAdmitted, rememberTrustedAnchor]);

  const attachedScrollerRef = useRef<HTMLElement | null>(null);
  const attachScroller = useCallback((el: HTMLElement | Window | null) => {
    attachedScrollerRef.current?.removeEventListener('scroll', onViewportScroll);
    attachVirtuosoScroller(el);
    const next = el instanceof HTMLElement ? el : null;
    attachedScrollerRef.current = next;
    next?.addEventListener('scroll', onViewportScroll, { passive: true });
  }, [attachVirtuosoScroller, onViewportScroll]);

  useLayoutEffect(() => () => {
    attachedScrollerRef.current?.removeEventListener('scroll', onViewportScroll);
  }, [onViewportScroll]);

  return {
    virtuosoRef,
    scrollerRef,
    followEnabledRef,
    attachScroller,
    scrollToBottom,
    pauseAutoScroll,
    handleAtBottomChange: handleViewportAtBottomChange,
    onViewportAdmissionChanged,
    onItemsRendered,
    isViewportRecoveryFenced: recoveryFenceId !== null,
    scrollToMessage,
    scrollToTool,
    captureAnchor,
    restoreAnchorAfterNextCommit,
    onRowLayoutChanged,
  };
}
