import { describe, expect, it, vi } from 'vitest';

import type { ChatTab } from '@/types/tab';
import { createChatTabLifecycle } from './tabLifecycle';

const tab = (overrides: Partial<ChatTab> = {}): ChatTab => ({
  id: 'tab-1',
  view: 'chat',
  title: 'Chat',
  agentDir: '/workspace',
  sessionId: 'session-1',
  sidecarConfigDisposition: 'push',
  ...overrides,
});

describe('Chat tab close lifecycle', () => {
  it('runs background handoff, SSE stop and exact owner release in order', async () => {
    const calls: string[] = [];
    const lifecycle = createChatTabLifecycle({
      startBackgroundCompletion: vi.fn(async () => {
        calls.push('background');
        return { started: true };
      }),
      stopSseProxy: vi.fn(async () => {
        calls.push('sse');
      }),
      releaseTabSession: vi.fn(async (sessionId, tabId) => {
        calls.push(`release:${sessionId}:${tabId}`);
      }),
      stopLegacyTabSidecar: vi.fn(async () => {
        calls.push('legacy');
      }),
      notifyBackgroundContinuation: vi.fn(() => calls.push('notice')),
      log: vi.fn(),
    });
    await lifecycle.afterDetach?.(tab({ isGenerating: true }), 'user');
    expect(calls).toEqual(['notice', 'background', 'sse', 'release:session-1:tab-1']);
  });

  it.each([
    { isGenerating: true, started: false, notices: 1 },
    { isGenerating: false, started: true, notices: 0 },
  ])(
    'uses captured generation state for the continuation notice ($isGenerating, $started)',
    async ({ isGenerating, started, notices }) => {
      const notifyBackgroundContinuation = vi.fn();
      const lifecycle = createChatTabLifecycle({
        startBackgroundCompletion: vi.fn(async () => ({ started })),
        stopSseProxy: vi.fn(async () => {}),
        releaseTabSession: vi.fn(async () => {}),
        stopLegacyTabSidecar: vi.fn(async () => {}),
        notifyBackgroundContinuation,
        log: vi.fn(),
      });

      await lifecycle.afterDetach?.(tab({ isGenerating }), 'user');

      expect(notifyBackgroundContinuation).toHaveBeenCalledTimes(notices);
    },
  );

  it('uses legacy fallback only when exact release fails', async () => {
    const legacy = vi.fn(async () => {});
    const lifecycle = createChatTabLifecycle({
      startBackgroundCompletion: vi.fn(async () => ({ started: false })),
      stopSseProxy: vi.fn(async () => {}),
      releaseTabSession: vi.fn(async () => {
        throw new Error('release failed');
      }),
      stopLegacyTabSidecar: legacy,
      notifyBackgroundContinuation: vi.fn(),
      log: vi.fn(),
    });
    await lifecycle.afterDetach?.(tab(), 'user');
    expect(legacy).toHaveBeenCalledWith('tab-1');
  });

  it('keeps the legacy no-session agent path after stopping SSE', async () => {
    const calls: string[] = [];
    const lifecycle = createChatTabLifecycle({
      startBackgroundCompletion: vi.fn(async () => ({ started: false })),
      stopSseProxy: vi.fn(async () => calls.push('sse')),
      releaseTabSession: vi.fn(async () => calls.push('release')),
      stopLegacyTabSidecar: vi.fn(async () => calls.push('legacy')),
      notifyBackgroundContinuation: vi.fn(),
      log: vi.fn(),
    });
    await lifecycle.afterDetach?.(tab({ sessionId: null }), 'user');
    expect(calls).toEqual(['sse', 'legacy']);
  });
});
