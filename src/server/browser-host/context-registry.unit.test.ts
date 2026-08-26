import { describe, expect, it, vi } from 'vitest';
import type { Browser, BrowserContext, BrowserType, Page } from 'playwright';

import type { VerifiedBrowserCapability } from './capability-client';
import {
  BrowserContextRegistry,
  type BrowserContextRegistryDependencies,
} from './context-registry';

const EMPTY_STATE = { cookies: [], origins: [] };

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
    newPage: vi.fn(),
    route: vi.fn(),
    unroute: vi.fn(),
    addCookies: vi.fn(async () => {}),
    cookies: vi.fn(async () => []),
    storageState: vi.fn(async () => EMPTY_STATE),
  } as unknown as BrowserContext;
}

function harness(
  contexts: BrowserContext[],
  overrides: Partial<BrowserContextRegistryDependencies> = {},
) {
  const queue = [...contexts];
  const browser = {
    isConnected: vi.fn(() => true),
    newContext: vi.fn(async () => queue.shift()!),
    once: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as Browser;
  const launch = vi.fn(async () => browser);
  const checkpointIdentity = vi.fn(async (
    _session: string,
    _base: unknown,
    _observed: unknown,
    state: typeof EMPTY_STATE,
  ) => ({ revision: 2, state, conflictCount: 0 }));
  const registry = new BrowserContextRegistry({
    readIdentity: vi.fn(async () => ({ revision: 1, state: EMPTY_STATE })),
    checkpointIdentity,
    loadBrowserType: vi.fn(async () => ({ launch } as unknown as BrowserType)),
    resolveResource: vi.fn(async () => ({
      revision: 'chromium-1212',
      executablePath: '/managed/chromium',
    })),
    ...overrides,
  });
  return { registry, browser, launch, checkpointIdentity };
}

function fakePage(name: string): Page {
  return {
    url: vi.fn(() => name),
    on: vi.fn(),
    once: vi.fn(),
    addListener: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as Page;
}

describe('BrowserContextRegistry', () => {
  it('shares one managed Chromium process and isolates one Context per Product Session', async () => {
    const { registry, browser, launch } = harness([
      fakeContext(),
      fakeContext(),
      fakeContext(),
    ]);

    const [a, sameA, b, c] = await Promise.all([
      registry.getContext(binding('a')),
      registry.getContext(binding('a')),
      registry.getContext(binding('b')),
      registry.getContext(binding('c')),
    ]);

    // Each MCP backend has an independent cleanup proxy while both proxies
    // borrow the same Product Session-owned Context.
    expect(a).not.toBe(sameA);
    expect(new Set([a, sameA, b, c]).size).toBe(4);
    expect(launch).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      headless: false,
      executablePath: '/managed/chromium',
    }));
    expect(browser.newContext).toHaveBeenCalledTimes(3);
  });

  it('hydrates and checkpoints only cookies without Playwright storage pages', async () => {
    const cookie = {
      name: 'session',
      value: 'cookie-value',
      domain: '.example.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    };
    const identityState = {
      cookies: [cookie],
      origins: [{
        origin: 'https://www.sina.com.cn',
        localStorage: [{ name: 'historical', value: 'state' }],
        indexedDB: [],
      }],
    };
    const context = fakeContext();
    vi.mocked(context.cookies).mockResolvedValue([cookie] as never);
    const { registry, browser, checkpointIdentity } = harness([context], {
      readIdentity: vi.fn(async () => ({ revision: 1, state: identityState })),
    });

    await registry.getContext(binding('a'));
    await registry.checkpoint('a');

    expect(vi.mocked(browser.newContext).mock.calls[0]?.[0]).not.toHaveProperty('storageState');
    expect(context.addCookies).toHaveBeenCalledWith([cookie]);
    expect(context.storageState).not.toHaveBeenCalled();
    expect(context.cookies).toHaveBeenCalledOnce();
    expect(checkpointIdentity).toHaveBeenCalledWith(
      'a',
      { revision: 1, state: identityState },
      identityState,
      { cookies: [cookie], origins: [] },
    );
  });

  it('cancels only an in-flight resource wait and permits a later retry', async () => {
    const context = fakeContext();
    const browser = {
      isConnected: vi.fn(() => true),
      newContext: vi.fn(async () => context),
      once: vi.fn(),
      close: vi.fn(async () => {}),
    } as unknown as Browser;
    const resolveResource = vi.fn()
      .mockImplementationOnce((signal?: AbortSignal) => new Promise(
        (_resolve, reject) => signal?.addEventListener(
          'abort',
          () => reject(new Error('BROWSER_RESOURCE_WAIT_CANCELLED')),
          { once: true },
        ),
      ))
      .mockResolvedValueOnce({ revision: 'chromium-1212', executablePath: '/managed/chromium' });
    const launch = vi.fn(async () => browser);
    const registry = new BrowserContextRegistry({
      readIdentity: vi.fn(async () => ({ revision: 1, state: EMPTY_STATE })),
      checkpointIdentity: vi.fn(async (_session, _base, _observed, state) => ({
        revision: 2,
        state,
        conflictCount: 0,
      })),
      loadBrowserType: vi.fn(async () => ({ launch } as unknown as BrowserType)),
      resolveResource,
    });

    const waiting = registry.getContext(binding('a'));
    await vi.waitFor(() => expect(resolveResource).toHaveBeenCalledOnce());
    registry.cancelPendingContext('a');
    await expect(waiting).rejects.toThrow('BROWSER_RESOURCE_WAIT_CANCELLED');
    await expect(registry.getContext(binding('a'))).resolves.toBeDefined();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('keeps a disconnected MCP borrow for bounded reattach, then checkpoints and closes it', async () => {
    vi.useFakeTimers();
    try {
      const context = fakeContext();
      const { registry, browser, checkpointIdentity } = harness([context]);

      registry.retainConnection('a');
      const borrowed = await registry.getContext(binding('a'));
      await borrowed.close();
      expect(context.close).not.toHaveBeenCalled();

      registry.releaseConnection('a');
      await vi.advanceTimersByTimeAsync(14_000);
      registry.retainConnection('a');
      expect(context.close).not.toHaveBeenCalled();

      registry.releaseConnection('a');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(checkpointIdentity).toHaveBeenCalledOnce();
      expect(context.close).toHaveBeenCalledOnce();
      expect(browser.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles one unknown checkpoint result before destructive close', async () => {
    const context = fakeContext();
    const checkpointIdentity = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ revision: 2, state: EMPTY_STATE, conflictCount: 0 });
    const { registry } = harness([context], { checkpointIdentity });

    await registry.getContext(binding('a'));
    await expect(registry.closeSessionContext('a')).resolves.toBeUndefined();
    expect(checkpointIdentity).toHaveBeenCalledTimes(2);
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('does not replay a CAS-rejected local identity value at the next unchanged checkpoint', async () => {
    const staleState = {
      cookies: [{ name: 'session', value: 'stale', domain: 'example.com', path: '/' }],
      origins: [],
    };
    const winningState = {
      cookies: [{ name: 'session', value: 'newer', domain: 'example.com', path: '/' }],
      origins: [],
    };
    const context = fakeContext();
    vi.mocked(context.cookies).mockResolvedValue(staleState.cookies as never);
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
      readIdentity: vi.fn(async () => ({ revision: 1, state: EMPTY_STATE })),
      checkpointIdentity,
      loadBrowserType: vi.fn(async () => ({
        launch: vi.fn(async () => browser),
      } as unknown as BrowserType)),
      resolveResource: vi.fn(async () => ({
        revision: 'chromium-1212',
        executablePath: '/managed/chromium',
      })),
    });

    await registry.getContext(binding('a'));
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

  it('retires a storage-only backend when the underlying Context disconnects', async () => {
    const context = fakeContext();
    const onContextClosed = vi.fn();
    const { registry } = harness([context], { onContextClosed });

    await registry.getContext(binding('a'));
    await context.close();
    await vi.waitFor(() => expect(onContextClosed).toHaveBeenCalledWith('a'));
  });

  it('preserves the selected tab and close-successor order across MCP reattach', async () => {
    const a = fakePage('a');
    const b = fakePage('b');
    const c = fakePage('c');
    let pages = [a, b, c];
    const context = fakeContext();
    vi.mocked(context.pages).mockImplementation(() => pages);
    const { registry } = harness([context]);

    const firstBackend = await registry.getContext(binding('a'));
    expect(firstBackend.pages().map(candidate => candidate.url())).toEqual(['a', 'b', 'c']);
    registry.reconcileTabAction('a', 'select', 1);
    pages = [a, c];
    registry.reconcileTabAction('a', 'close', undefined);

    const afterClose = await registry.getContext(binding('a'));
    expect(afterClose.pages().map(candidate => candidate.url())).toEqual(['c', 'a']);
  });

  it('moves a provisional Context and connection ownership to the canonical Session id', async () => {
    vi.useFakeTimers();
    try {
      const context = fakeContext();
      const { registry, browser } = harness([context]);

      registry.retainConnection('pending-a');
      await registry.getContext(binding('pending-a'));
      expect(registry.rekeyProductSession('pending-a', 'real-a')).toBe(true);
      await registry.getContext(binding('real-a'));
      expect(browser.newContext).toHaveBeenCalledOnce();

      registry.releaseConnection('real-a');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(context.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces Context close failure without dropping the live owner', async () => {
    const context = fakeContext();
    vi.mocked(context.close).mockRejectedValue(new Error('close failed'));
    const { registry, browser } = harness([context]);

    await registry.getContext(binding('a'));
    await expect(registry.closeSessionContext('a')).rejects.toMatchObject({
      name: 'BROWSER_CONTEXT_CLOSE_FAILED',
    });
    expect(browser.close).not.toHaveBeenCalled();
    await expect(registry.getContext(binding('a'))).resolves.toBeDefined();
  });
});
