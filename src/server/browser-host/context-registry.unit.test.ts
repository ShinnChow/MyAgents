import { describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, BrowserType } from 'playwright';

import { BrowserContextRegistry } from './context-registry';
import type { BrowserProfileLease } from './profile-lease-client';
import type { VerifiedBrowserCapability } from './capability-client';

function binding(session: string): VerifiedBrowserCapability {
  return {
    productSessionId: session,
    workspacePath: `/workspace/${session}`,
    hostGeneration: 9,
  };
}

function fakeContext(): BrowserContext {
  const closeListeners: Array<() => void> = [];
  return {
    once: vi.fn((event: string, listener: () => void) => {
      if (event === 'close') closeListeners.push(listener);
      return undefined;
    }),
    close: vi.fn(async () => {
      for (const listener of closeListeners.splice(0)) listener();
    }),
    pages: vi.fn(() => []),
    storageState: vi.fn(async () => ({ cookies: [], origins: [] })),
  } as unknown as BrowserContext;
}

describe('BrowserContextRegistry', () => {
  it('coalesces one Browser generation and creates one isolated Context per Product Session', async () => {
    const contexts = [fakeContext(), fakeContext(), fakeContext()];
    const browser = {
      isConnected: vi.fn(() => true),
      newContext: vi.fn(async () => contexts.shift()!),
      once: vi.fn(),
      close: vi.fn(async () => {}),
    } as unknown as Browser;
    const launch = vi.fn(async () => browser);
    const registry = new BrowserContextRegistry({
      loadSettings: () => ({
        schemaVersion: 1,
        mode: 'isolated',
        headless: true,
        capabilities: ['storage'],
        extraArgs: [],
      }),
      readIdentity: vi.fn(async () => ({ revision: 1, state: { cookies: [], origins: [] } })),
      checkpointIdentity: vi.fn(async (_session, _base, _observed, state) => ({ revision: 2, state, conflictCount: 0 })),
      browserTypes: {
        chromium: { launch } as unknown as BrowserType,
        firefox: {} as BrowserType,
        webkit: {} as BrowserType,
      },
      acquireProfileLease: vi.fn(),
      releaseProfileLease: vi.fn(),
    });

    const [a, sameA, b, c] = await Promise.all([
      registry.getContext(binding('a'), 'token-a'),
      registry.getContext(binding('a'), 'token-a'),
      registry.getContext(binding('b'), 'token-b'),
      registry.getContext(binding('c'), 'token-c'),
    ]);
    // Each MCP backend gets its own cleanup scope even when it borrows the
    // same Product Session Context.
    expect(a).not.toBe(sameA);
    expect(new Set([a, sameA, b, c]).size).toBe(4);
    expect(launch).toHaveBeenCalledTimes(1);
    expect((browser.newContext as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);
  });

  it('does not launch a second persistent Context until the Rust-owned lease is granted', async () => {
    const firstContext = fakeContext();
    const secondContext = fakeContext();
    const launchPersistentContext = vi.fn()
      .mockResolvedValueOnce(firstContext)
      .mockResolvedValueOnce(secondContext);
    let grantSecond!: (lease: BrowserProfileLease) => void;
    const secondLease = new Promise<BrowserProfileLease>(resolve => { grantSecond = resolve; });
    const acquireProfileLease = vi.fn()
      .mockResolvedValueOnce({ requestId: 'a', leaseEpoch: 1, token: 'token-a' })
      .mockReturnValueOnce(secondLease);
    const releaseProfileLease = vi.fn(async (lease: BrowserProfileLease) => {
      if (lease.requestId === 'a') grantSecond({ requestId: 'b', leaseEpoch: 2, token: 'token-b' });
      return true;
    });
    const registry = new BrowserContextRegistry({
      loadSettings: () => ({
        schemaVersion: 1,
        mode: 'persistent',
        headless: true,
        userDataDir: '/profile',
        capabilities: [],
        extraArgs: [],
      }),
      browserTypes: {
        chromium: { launchPersistentContext } as unknown as BrowserType,
        firefox: {} as BrowserType,
        webkit: {} as BrowserType,
      },
      acquireProfileLease,
      releaseProfileLease,
      readIdentity: vi.fn(),
      checkpointIdentity: vi.fn(),
    });

    await registry.getContext(binding('a'), 'token-a');
    const pendingB = registry.getContext(binding('b'), 'token-b');
    await Promise.resolve();
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
    await registry.closeSessionContext('a');
    await expect(pendingB).resolves.toBeDefined();
    expect(launchPersistentContext).toHaveBeenCalledTimes(2);
    expect(releaseProfileLease).toHaveBeenCalledWith(expect.objectContaining({ leaseEpoch: 1 }));
  });

  it('cancels only the pending persistent lease wait and permits a later retry', async () => {
    const context = fakeContext();
    const launchPersistentContext = vi.fn(async () => context);
    const acquireProfileLease = vi.fn()
      .mockImplementationOnce((_token: string, signal?: AbortSignal) => new Promise<BrowserProfileLease>(
        (_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('BROWSER_WAIT_CANCELLED')), { once: true }),
      ))
      .mockResolvedValueOnce({ requestId: 'a-retry', leaseEpoch: 2, token: 'token-a' });
    const registry = new BrowserContextRegistry({
      loadSettings: () => ({
        schemaVersion: 1,
        mode: 'persistent',
        headless: true,
        userDataDir: '/profile',
        capabilities: [],
        extraArgs: [],
      }),
      browserTypes: {
        chromium: { launchPersistentContext } as unknown as BrowserType,
        firefox: {} as BrowserType,
        webkit: {} as BrowserType,
      },
      acquireProfileLease,
      releaseProfileLease: vi.fn(async () => true),
      readIdentity: vi.fn(),
      checkpointIdentity: vi.fn(),
    });

    const waiting = registry.getContext(binding('a'), 'token-a');
    await vi.waitFor(() => expect(acquireProfileLease).toHaveBeenCalledTimes(1));
    registry.cancelPendingContext('a');
    await expect(waiting).rejects.toThrow('BROWSER_WAIT_CANCELLED');
    await expect(registry.getContext(binding('a'), 'token-a')).resolves.toBeDefined();
    expect(launchPersistentContext).toHaveBeenCalledTimes(1);
  });

  it('keeps a disconnected Context for bounded reattach, then checkpoints and closes it', async () => {
    vi.useFakeTimers();
    try {
      const context = fakeContext();
      const browser = {
        isConnected: vi.fn(() => true),
        newContext: vi.fn(async () => context),
        once: vi.fn(),
        close: vi.fn(async () => {}),
      } as unknown as Browser;
      const checkpointIdentity = vi.fn(async (_session, _base, _observed, state) => ({
        revision: 2,
        state,
        conflictCount: 0,
      }));
      const registry = new BrowserContextRegistry({
        loadSettings: () => ({
          schemaVersion: 1,
          mode: 'isolated',
          headless: true,
          capabilities: ['storage'],
          extraArgs: [],
        }),
        readIdentity: vi.fn(async () => ({ revision: 1, state: { cookies: [], origins: [] } })),
        checkpointIdentity,
        browserTypes: {
          chromium: { launch: vi.fn(async () => browser) } as unknown as BrowserType,
          firefox: {} as BrowserType,
          webkit: {} as BrowserType,
        },
        acquireProfileLease: vi.fn(),
        releaseProfileLease: vi.fn(),
      });

      registry.retainConnection('a');
      const borrowed = await registry.getContext(binding('a'), 'token-a');
      await borrowed.close();
      expect(context.close).not.toHaveBeenCalled();
      registry.releaseConnection('a');
      await vi.advanceTimersByTimeAsync(14_000);
      registry.retainConnection('a');
      expect(context.close).not.toHaveBeenCalled();
      registry.releaseConnection('a');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(checkpointIdentity).toHaveBeenCalledTimes(1);
      expect(context.close).toHaveBeenCalledTimes(1);
      expect(browser.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces external persistent-profile occupation as PROFILE_IN_USE', async () => {
    const registry = new BrowserContextRegistry({
      loadSettings: () => ({
        schemaVersion: 1,
        mode: 'persistent',
        headless: true,
        userDataDir: '/profile',
        capabilities: [],
        extraArgs: [],
      }),
      browserTypes: {
        chromium: {
          launchPersistentContext: vi.fn(async () => {
            throw new Error('Failed to create a ProcessSingleton for your profile directory. SingletonLock');
          }),
        } as unknown as BrowserType,
        firefox: {} as BrowserType,
        webkit: {} as BrowserType,
      },
      acquireProfileLease: vi.fn(async () => ({
        requestId: 'a', leaseEpoch: 1, token: 'token-a',
      })),
      releaseProfileLease: vi.fn(async () => true),
      readIdentity: vi.fn(),
      checkpointIdentity: vi.fn(),
    });

    await expect(registry.getContext(binding('a'), 'token-a')).rejects.toMatchObject({
      name: 'PROFILE_IN_USE',
    });
  });

  it('does not release a persistent lease when the Profile close fails', async () => {
    const context = fakeContext();
    vi.mocked(context.close).mockRejectedValue(new Error('close failed'));
    const releaseProfileLease = vi.fn(async () => true);
    const registry = new BrowserContextRegistry({
      loadSettings: () => ({
        schemaVersion: 1,
        mode: 'persistent',
        headless: true,
        userDataDir: '/profile',
        capabilities: [],
        extraArgs: [],
      }),
      browserTypes: {
        chromium: { launchPersistentContext: vi.fn(async () => context) } as unknown as BrowserType,
        firefox: {} as BrowserType,
        webkit: {} as BrowserType,
      },
      acquireProfileLease: vi.fn(async () => ({
        requestId: 'a', leaseEpoch: 1, token: 'token-a',
      })),
      releaseProfileLease,
      readIdentity: vi.fn(),
      checkpointIdentity: vi.fn(),
    });

    await registry.getContext(binding('a'), 'token-a');
    await expect(registry.closeSessionContext('a')).rejects.toMatchObject({
      name: 'PROFILE_CLOSE_FAILED',
    });
    expect(releaseProfileLease).not.toHaveBeenCalled();
  });

  it('bounds a hung persistent Profile close without releasing its lease', async () => {
    vi.useFakeTimers();
    try {
      const context = fakeContext();
      vi.mocked(context.close).mockReturnValue(new Promise<void>(() => {}));
      const releaseProfileLease = vi.fn(async () => true);
      const registry = new BrowserContextRegistry({
        loadSettings: () => ({
          schemaVersion: 1,
          mode: 'persistent',
          headless: true,
          userDataDir: '/profile',
          capabilities: [],
          extraArgs: [],
        }),
        browserTypes: {
          chromium: {
            launchPersistentContext: vi.fn(async () => context),
          } as unknown as BrowserType,
          firefox: {} as BrowserType,
          webkit: {} as BrowserType,
        },
        acquireProfileLease: vi.fn(async () => ({
          requestId: 'a', leaseEpoch: 1, token: 'token-a',
        })),
        releaseProfileLease,
        readIdentity: vi.fn(),
        checkpointIdentity: vi.fn(),
      });

      await registry.getContext(binding('a'), 'token-a');
      const close = registry.closeSessionContext('a');
      const rejection = close.catch(error => error);
      await vi.advanceTimersByTimeAsync(4_000);

      await expect(rejection).resolves.toMatchObject({ name: 'PROFILE_CLOSE_FAILED' });
      expect(releaseProfileLease).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a disconnected Profile close before releasing its lease', async () => {
    vi.useFakeTimers();
    try {
      const context = fakeContext();
      vi.mocked(context.close)
        .mockRejectedValueOnce(new Error('transient close failure'))
        .mockResolvedValueOnce(undefined);
      const releaseProfileLease = vi.fn(async () => true);
      const registry = new BrowserContextRegistry({
        loadSettings: () => ({
          schemaVersion: 1,
          mode: 'persistent',
          headless: true,
          userDataDir: '/profile',
          capabilities: [],
          extraArgs: [],
        }),
        browserTypes: {
          chromium: {
            launchPersistentContext: vi.fn(async () => context),
          } as unknown as BrowserType,
          firefox: {} as BrowserType,
          webkit: {} as BrowserType,
        },
        acquireProfileLease: vi.fn(async () => ({
          requestId: 'a', leaseEpoch: 1, token: 'token-a',
        })),
        releaseProfileLease,
        readIdentity: vi.fn(),
        checkpointIdentity: vi.fn(),
      });

      registry.retainConnection('a');
      await registry.getContext(binding('a'), 'token-a');
      registry.releaseConnection('a');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(context.close).toHaveBeenCalledTimes(1);
      expect(releaseProfileLease).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(15_000);
      expect(context.close).toHaveBeenCalledTimes(2);
      expect(releaseProfileLease).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles one unknown checkpoint result before destructive close', async () => {
    const context = fakeContext();
    const browser = {
      isConnected: vi.fn(() => true),
      newContext: vi.fn(async () => context),
      once: vi.fn(),
      close: vi.fn(async () => {}),
    } as unknown as Browser;
    const checkpointIdentity = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({
        revision: 2,
        state: { cookies: [], origins: [] },
        conflictCount: 0,
      });
    const registry = new BrowserContextRegistry({
      loadSettings: () => ({
        schemaVersion: 1,
        mode: 'isolated',
        headless: true,
        capabilities: ['storage'],
        extraArgs: [],
      }),
      readIdentity: vi.fn(async () => ({ revision: 1, state: { cookies: [], origins: [] } })),
      checkpointIdentity,
      browserTypes: {
        chromium: { launch: vi.fn(async () => browser) } as unknown as BrowserType,
        firefox: {} as BrowserType,
        webkit: {} as BrowserType,
      },
      acquireProfileLease: vi.fn(),
      releaseProfileLease: vi.fn(),
    });

    await registry.getContext(binding('a'), 'token-a');
    await expect(registry.closeSessionContext('a')).resolves.toBeUndefined();
    expect(checkpointIdentity).toHaveBeenCalledTimes(2);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it('notifies the Host when the underlying Context disconnects without a page', async () => {
    const context = fakeContext();
    const browser = {
      isConnected: vi.fn(() => true),
      newContext: vi.fn(async () => context),
      once: vi.fn(),
      close: vi.fn(async () => {}),
    } as unknown as Browser;
    const onContextClosed = vi.fn();
    const registry = new BrowserContextRegistry({
      loadSettings: () => ({
        schemaVersion: 1,
        mode: 'isolated',
        headless: true,
        capabilities: ['storage'],
        extraArgs: [],
      }),
      readIdentity: vi.fn(async () => ({ revision: 1, state: { cookies: [], origins: [] } })),
      checkpointIdentity: vi.fn(async (_session, _base, _observed, state) => ({
        revision: 2,
        state,
        conflictCount: 0,
      })),
      browserTypes: {
        chromium: { launch: vi.fn(async () => browser) } as unknown as BrowserType,
        firefox: {} as BrowserType,
        webkit: {} as BrowserType,
      },
      acquireProfileLease: vi.fn(),
      releaseProfileLease: vi.fn(),
      onContextClosed,
    });

    await registry.getContext(binding('a'), 'token-a');
    await context.close();
    await vi.waitFor(() => expect(onContextClosed).toHaveBeenCalledWith('a'));
  });

  it('does not replay a CAS-rejected identity value at the next unchanged checkpoint', async () => {
    const staleState = {
      cookies: [{ name: 'session', value: 'stale', domain: 'example.com', path: '/' }],
      origins: [],
    };
    const winningState = {
      cookies: [{ name: 'session', value: 'newer', domain: 'example.com', path: '/' }],
      origins: [],
    };
    const context = fakeContext();
    vi.mocked(context.storageState).mockResolvedValue(staleState as never);
    const browser = {
      isConnected: vi.fn(() => true),
      newContext: vi.fn(async () => context),
      once: vi.fn(),
      close: vi.fn(async () => {}),
    } as unknown as Browser;
    const checkpointIdentity = vi.fn()
      .mockResolvedValueOnce({ revision: 2, state: winningState, conflictCount: 1 })
      .mockResolvedValueOnce({ revision: 2, state: winningState, conflictCount: 0 });
    const registry = new BrowserContextRegistry({
      loadSettings: () => ({
        schemaVersion: 1,
        mode: 'isolated',
        headless: true,
        capabilities: ['storage'],
        extraArgs: [],
      }),
      readIdentity: vi.fn(async () => ({ revision: 1, state: { cookies: [], origins: [] } })),
      checkpointIdentity,
      browserTypes: {
        chromium: { launch: vi.fn(async () => browser) } as unknown as BrowserType,
        firefox: {} as BrowserType,
        webkit: {} as BrowserType,
      },
      acquireProfileLease: vi.fn(),
      releaseProfileLease: vi.fn(),
    });

    await registry.getContext(binding('a'), 'token-a');
    await registry.checkpoint('a');
    await registry.checkpoint('a');

    expect(checkpointIdentity).toHaveBeenNthCalledWith(
      2,
      'a',
      { revision: 2, state: winningState },
      staleState,
      staleState,
    );
  });

  it('replaces the Browser generation on desired settings change without losing connection ownership', async () => {
    vi.useFakeTimers();
    try {
      const firstContext = fakeContext();
      const secondContext = fakeContext();
      const firstBrowser = {
        isConnected: vi.fn(() => true),
        newContext: vi.fn(async () => firstContext),
        once: vi.fn(),
        close: vi.fn(async () => {}),
      } as unknown as Browser;
      const secondBrowser = {
        isConnected: vi.fn(() => true),
        newContext: vi.fn(async () => secondContext),
        once: vi.fn(),
        close: vi.fn(async () => {}),
      } as unknown as Browser;
      let headless = false;
      const launch = vi.fn()
        .mockResolvedValueOnce(firstBrowser)
        .mockResolvedValueOnce(secondBrowser);
      const registry = new BrowserContextRegistry({
        loadSettings: () => ({
          schemaVersion: 1,
          mode: 'isolated',
          headless,
          capabilities: ['storage'],
          extraArgs: [],
        }),
        readIdentity: vi.fn(async () => ({ revision: 1, state: { cookies: [], origins: [] } })),
        checkpointIdentity: vi.fn(async (_session, _base, _observed, state) => ({
          revision: 2,
          state,
          conflictCount: 0,
        })),
        browserTypes: {
          chromium: { launch } as unknown as BrowserType,
          firefox: {} as BrowserType,
          webkit: {} as BrowserType,
        },
        acquireProfileLease: vi.fn(),
        releaseProfileLease: vi.fn(),
      });

      registry.retainConnection('a');
      expect(await registry.getContext(binding('a'), 'token-a')).toBeDefined();
      headless = true;
      expect(await registry.getContext(binding('a'), 'token-a')).toBeDefined();
      expect(firstContext.close).toHaveBeenCalledTimes(1);
      expect(firstBrowser.close).toHaveBeenCalledTimes(1);

      registry.releaseConnection('a');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(secondContext.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves the selected tab and close-successor order across MCP reattach', async () => {
    const page = (name: string) => ({
      url: vi.fn(() => name),
      on: vi.fn(),
      once: vi.fn(),
      addListener: vi.fn(),
      off: vi.fn(),
      removeListener: vi.fn(),
    }) as unknown as import('playwright').Page;
    const a = page('a');
    const b = page('b');
    const c = page('c');
    let pages = [a, b, c];
    const context = fakeContext();
    vi.mocked(context.pages).mockImplementation(() => pages);
    const browser = {
      isConnected: vi.fn(() => true),
      newContext: vi.fn(async () => context),
      once: vi.fn(),
      close: vi.fn(async () => {}),
    } as unknown as Browser;
    const registry = new BrowserContextRegistry({
      loadSettings: () => ({
        schemaVersion: 1,
        mode: 'isolated',
        headless: true,
        capabilities: ['storage'],
        extraArgs: [],
      }),
      readIdentity: vi.fn(async () => ({ revision: 1, state: { cookies: [], origins: [] } })),
      checkpointIdentity: vi.fn(async (_session, _base, _observed, state) => ({
        revision: 2,
        state,
        conflictCount: 0,
      })),
      browserTypes: {
        chromium: { launch: vi.fn(async () => browser) } as unknown as BrowserType,
        firefox: {} as BrowserType,
        webkit: {} as BrowserType,
      },
      acquireProfileLease: vi.fn(),
      releaseProfileLease: vi.fn(),
    });

    const firstBackend = await registry.getContext(binding('a'), 'token-a');
    expect(firstBackend.pages().map(candidate => candidate.url())).toEqual(['a', 'b', 'c']);
    registry.reconcileTabAction('a', 'select', 1);
    pages = [a, c];
    registry.reconcileTabAction('a', 'close', undefined);

    const afterClose = await registry.getContext(binding('a'), 'token-a');
    expect(afterClose.pages().map(candidate => candidate.url())).toEqual(['c', 'a']);
  });

  it('moves a provisional Context and its connection lease to the canonical Session id', async () => {
    vi.useFakeTimers();
    try {
      const context = fakeContext();
      const browser = {
        isConnected: vi.fn(() => true),
        newContext: vi.fn(async () => context),
        once: vi.fn(),
        close: vi.fn(async () => {}),
      } as unknown as Browser;
      const registry = new BrowserContextRegistry({
        loadSettings: () => ({
          schemaVersion: 1,
          mode: 'isolated',
          headless: true,
          capabilities: ['storage'],
          extraArgs: [],
        }),
        readIdentity: vi.fn(async () => ({ revision: 1, state: { cookies: [], origins: [] } })),
        checkpointIdentity: vi.fn(async (_session, _base, _observed, state) => ({
          revision: 2,
          state,
          conflictCount: 0,
        })),
        browserTypes: {
          chromium: { launch: vi.fn(async () => browser) } as unknown as BrowserType,
          firefox: {} as BrowserType,
          webkit: {} as BrowserType,
        },
        acquireProfileLease: vi.fn(),
        releaseProfileLease: vi.fn(),
      });

      registry.retainConnection('pending-a');
      await registry.getContext(binding('pending-a'), 'token-a');
      expect(registry.rekeyProductSession('pending-a', 'real-a')).toBe(true);
      await registry.getContext(binding('real-a'), 'token-a');
      expect(browser.newContext).toHaveBeenCalledTimes(1);

      registry.releaseConnection('real-a');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(context.close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
