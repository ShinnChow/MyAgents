import { cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import BrowserPanel from './BrowserPanel';

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

vi.mock('@/utils/tauriListen', () => ({
  listenWithCleanup: vi.fn(async () => ({ unlisten: vi.fn(), isRegistered: () => true })),
}));

vi.mock('@/utils/openExternal', () => ({ openExternal: vi.fn() }));
vi.mock('@/hooks/useBrowserOverlayGuard', () => ({ useBrowserOverlayGuard: () => false }));
vi.mock('@/components/Toast', () => ({
  useToast: () => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));
vi.mock('@/components/Tip', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const TOKEN_A = '00000000-0000-4000-8000-000000000001';
const TOKEN_B = '00000000-0000-4000-8000-000000000002';

describe('BrowserPanel exact-generation lifecycle', () => {
  beforeEach(() => {
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(TOKEN_A)
      .mockReturnValueOnce(TOKEN_B);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 120,
      y: 80,
      width: 640,
      height: 480,
      top: 80,
      left: 120,
      right: 760,
      bottom: 560,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    invokeMock.mockReset();
  });

  it('uses a fresh token after setup-cleanup-setup and ignores the old create result', async () => {
    const createResolvers = new Map<string, () => void>();
    invokeMock.mockImplementation((cmd, args) => {
      if (cmd !== 'cmd_browser_create') return Promise.resolve(undefined);
      const token = (args as { lifecycleToken: string }).lifecycleToken;
      return new Promise(resolve => createResolvers.set(token, () => resolve(undefined)));
    });
    const onBrowserCreated = vi.fn();

    const view = render(
      <StrictMode>
        <BrowserPanel
          tabId="tab-1"
          url="https://example.com"
          isVisible
          isDraggingSplit={false}
          isSplitTransitioning={false}
          browserAlive={false}
          sourceFile={null}
          onBrowserCreated={onBrowserCreated}
          onCreateFailed={vi.fn()}
          onClose={vi.fn()}
        />
      </StrictMode>,
    );

    await act(async () => { await Promise.resolve(); });

    const createTokens = invokeMock.mock.calls
      .filter(([command]) => command === 'cmd_browser_create')
      .map(([, args]) => (args as { lifecycleToken: string }).lifecycleToken);
    expect(createTokens).toEqual([TOKEN_A, TOKEN_B]);
    expect(invokeMock).toHaveBeenCalledWith('cmd_browser_close', {
      tabId: 'tab-1',
      lifecycleToken: TOKEN_A,
    });

    await act(async () => {
      createResolvers.get(TOKEN_A)?.();
      await Promise.resolve();
    });
    expect(onBrowserCreated).not.toHaveBeenCalled();

    await act(async () => {
      createResolvers.get(TOKEN_B)?.();
      await Promise.resolve();
    });
    expect(onBrowserCreated).toHaveBeenCalledOnce();

    view.unmount();
    expect(invokeMock).toHaveBeenCalledWith('cmd_browser_close', {
      tabId: 'tab-1',
      lifecycleToken: TOKEN_B,
    });
  });

  it('does not create a Rust tombstone when unmounted before create is issued', () => {
    const view = render(
      <BrowserPanel
        tabId="tab-never-created"
        url=""
        isVisible
        isDraggingSplit={false}
        isSplitTransitioning={false}
        browserAlive={false}
        sourceFile={null}
        onBrowserCreated={vi.fn()}
        onCreateFailed={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    view.unmount();

    expect(invokeMock.mock.calls.some(([command]) => (
      command === 'cmd_browser_create' || command === 'cmd_browser_close'
    ))).toBe(false);
  });

  it('does not close an already-settled failed create during later cleanup', async () => {
    invokeMock.mockImplementation((command) => (
      command === 'cmd_browser_create'
        ? Promise.reject(new Error('native birth failed'))
        : Promise.resolve(undefined)
    ));
    const view = render(
      <BrowserPanel
        tabId="tab-failed-create"
        url="https://example.com"
        isVisible
        isDraggingSplit={false}
        isSplitTransitioning={false}
        browserAlive={false}
        sourceFile={null}
        onBrowserCreated={vi.fn()}
        onCreateFailed={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await act(async () => { await Promise.resolve(); });
    view.unmount();

    expect(invokeMock.mock.calls.some(([command]) => command === 'cmd_browser_create')).toBe(true);
    expect(invokeMock.mock.calls.some(([command]) => command === 'cmd_browser_close')).toBe(false);
  });
});
