import { act, render } from '@testing-library/react';
import React, { useMemo } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Message as MessageType } from '@/types/chat';

const virtuoso = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  scrollBy: vi.fn(),
  atBottomStateChange: undefined as ((atBottom: boolean) => void) | undefined,
}));

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  return {
    Virtuoso: ReactModule.forwardRef(function MockVirtuoso(
      props: { atBottomStateChange?: (atBottom: boolean) => void },
      ref,
    ) {
      virtuoso.atBottomStateChange = props.atBottomStateChange;
      ReactModule.useImperativeHandle(ref, () => ({
        scrollToIndex: virtuoso.scrollToIndex,
        scrollBy: virtuoso.scrollBy,
      }), []);
      return <div data-testid="virtuoso" />;
    }),
  };
});

vi.mock('@/components/Message', () => ({ default: () => <div /> }));
vi.mock('@/components/PermissionPrompt', () => ({ PermissionPrompt: () => null }));
vi.mock('@/components/AskUserQuestionPrompt', () => ({ AskUserQuestionPrompt: () => null }));
vi.mock('@/components/ExitPlanModePrompt', () => ({ ExitPlanModePrompt: () => null }));

import MessageList from './MessageList';
import { useChatScrollController } from '@/hooks/useChatScrollController';

function msg(id: string, content: string, role: 'user' | 'assistant' = 'assistant'): MessageType {
  return { id, role, content, timestamp: new Date('2026-08-01T00:00:00Z') } as MessageType;
}

const WINDOW_PRESENTATION = { surfaceAvailable: true, generation: 0 } as const;
const SUSPENDED_PRESENTATION = { surfaceAvailable: false, generation: 1 } as const;
const RESTORED_PRESENTATION = { surfaceAvailable: true, generation: 1 } as const;

function Harness({
  streamingContent,
  renderNonce,
  windowPresentation = WINDOW_PRESENTATION,
}: {
  streamingContent: string;
  renderNonce: number;
  windowPresentation?: { surfaceAvailable: boolean; generation: number };
}) {
  void renderNonce;
  const streamingMessage = useMemo(() => msg('stream', streamingContent), [streamingContent]);
  const messages = useMemo(
    () => [msg('user', 'query', 'user'), streamingMessage],
    [streamingMessage],
  );
  const controller = useChatScrollController({
    messages,
    isActive: true,
    windowPresentation,
    sessionId: 's1',
  });
  return (
    <MessageList
      messages={messages}
      streamingMessage={streamingMessage}
      isLoading
      sessionId="s1"
      isActive
      windowPresentation={windowPresentation}
      onViewportAdmissionChanged={controller.onViewportAdmissionChanged}
      onItemsRendered={controller.onItemsRendered}
      isViewportRecoveryFenced={controller.isViewportRecoveryFenced}
      firstItemIndex={1_000_000}
      virtuosoRef={controller.virtuosoRef}
      onScrollerRef={controller.attachScroller}
      followEnabledRef={controller.followEnabledRef}
      scrollToBottom={controller.scrollToBottom}
      handleAtBottomChange={controller.handleAtBottomChange}
      onRowLayoutChanged={controller.onRowLayoutChanged}
    />
  );
}

describe('Chat window focus scroll composition', () => {
  it('keeps a visible followed stream live while blurred without issuing a focus restore', () => {
    const view = render(<Harness streamingContent="a" renderNonce={0} />);
    virtuoso.scrollToIndex.mockClear();

    view.rerender(<Harness streamingContent="background output" renderNonce={1} />);
    expect(virtuoso.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuoso.scrollToIndex).toHaveBeenLastCalledWith({
      index: 'LAST',
      align: 'end',
      behavior: 'auto',
    });

    // Visible unfocused viewport input remains admitted and updates follow.
    act(() => virtuoso.atBottomStateChange?.(false));
    virtuoso.scrollToIndex.mockClear();

    // App no longer projects native focus into Chat. A focus sample that keeps
    // the same presentation therefore cannot manufacture a restore command.
    view.rerender(<Harness streamingContent="background output" renderNonce={2} />);

    expect(virtuoso.scrollToIndex).not.toHaveBeenCalled();
  });

  it('issues only the controller recovery pin when a followed stream becomes renderable', () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    }
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    const view = render(<Harness streamingContent="a" renderNonce={0} />);

    view.rerender(
      <Harness
        streamingContent="output while minimized"
        renderNonce={1}
        windowPresentation={SUSPENDED_PRESENTATION}
      />,
    );
    virtuoso.scrollToIndex.mockClear();
    view.rerender(
      <Harness
        streamingContent="output while minimized"
        renderNonce={2}
        windowPresentation={RESTORED_PRESENTATION}
      />,
    );

    act(() => resizeCallback?.([
      { contentRect: { width: 800, height: 600 } as DOMRectReadOnly } as ResizeObserverEntry,
    ], {} as ResizeObserver));

    expect(virtuoso.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtuoso.scrollToIndex).toHaveBeenCalledWith({
      index: 'LAST',
      align: 'end',
      behavior: 'auto',
    });
    vi.unstubAllGlobals();
  });
});
