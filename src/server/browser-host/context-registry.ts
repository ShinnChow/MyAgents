import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Page,
} from 'playwright';

import type { VerifiedBrowserCapability } from './capability-client';
import {
  checkpointBrowserIdentity,
  readBrowserIdentity,
  type BrowserIdentitySnapshot,
  type BrowserIdentityState,
} from './identity-client';
import { compileBrowserRuntimeSettings } from './runtime-settings';
import { waitForBrowserResource, type BrowserResourceResolution } from './resource-client';

type BrowserCookie = Parameters<BrowserContext['addCookies']>[0][number];

const CHECKPOINT_DEBOUNCE_MS = 750;
const CONTEXT_REATTACH_GRACE_MS = 15_000;
const CONTEXT_CLOSE_TIMEOUT_MS = 4_000;

interface ContextEntry {
  context: BrowserContext;
  identity: BrowserIdentitySnapshot;
  observedIdentityState: BrowserIdentityState;
  selection: { page: Page | null };
  backendPageOrder: Page[];
  checkpointPromise: Promise<void> | null;
  checkpointTimer: ReturnType<typeof setTimeout> | null;
  closePromise: Promise<void> | null;
  finalizePromise: Promise<void> | null;
}

/**
 * Playwright MCP owns its backend and calls `close()` when an HTTP connection
 * ends. The underlying Context is instead leased to the Product Session so a
 * replacement Runtime can reattach during the bounded grace window. All
 * operations remain bound to the real Context; only close stays registry-owned.
 */
type Listener = (...args: unknown[]) => unknown;
type Emitter = {
  on?: (event: string | symbol, listener: Listener) => unknown;
  once?: (event: string | symbol, listener: Listener) => unknown;
  addListener?: (event: string | symbol, listener: Listener) => unknown;
  off?: (event: string | symbol, listener: Listener) => unknown;
  removeListener?: (event: string | symbol, listener: Listener) => unknown;
};

function borrowBrowserContext(
  context: BrowserContext,
  selectedPage: () => Page | null,
  observePageOrder: (pages: Page[]) => void,
): BrowserContext {
  const listeners: Array<{
    emitter: Emitter;
    event: string | symbol;
    original: Listener;
    installed: Listener;
  }> = [];
  const routes: Array<{ pattern: unknown; handler: unknown }> = [];
  const pageProxies = new WeakMap<Page, Page>();
  let cleaned = false;

  const removeTrackedListener = (
    emitter: Emitter,
    event: string | symbol,
    original: Listener,
  ): void => {
    for (let index = listeners.length - 1; index >= 0; index -= 1) {
      const tracked = listeners[index];
      if (tracked.emitter !== emitter || tracked.event !== event || tracked.original !== original) {
        continue;
      }
      emitter.removeListener?.(event, tracked.installed);
      listeners.splice(index, 1);
    }
  };

  const wrapEmitter = <T extends Emitter>(
    emitter: T,
    transformArgs?: (event: string | symbol, args: unknown[]) => unknown[],
  ): T => new Proxy(emitter, {
    get(target, property, receiver) {
      if (property === 'on' || property === 'once' || property === 'addListener') {
        return (event: string | symbol, listener: Listener) => {
          const installed: Listener = (...args) => listener(...(
            transformArgs?.(event, args) ?? args
          ));
          listeners.push({ emitter: target, event, original: listener, installed });
          const method = target[property];
          method?.call(target, event, installed);
          return receiver;
        };
      }
      if (property === 'off' || property === 'removeListener') {
        return (event: string | symbol, listener: Listener) => {
          removeTrackedListener(target, event, listener);
          return receiver;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const wrapPage = (page: Page): Page => {
    const existing = pageProxies.get(page);
    if (existing) return existing;
    const proxy = wrapEmitter(page as unknown as Emitter) as unknown as Page;
    pageProxies.set(page, proxy);
    return proxy;
  };

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    for (const tracked of listeners.splice(0)) {
      tracked.emitter.removeListener?.(tracked.event, tracked.installed);
    }
    for (const route of routes.splice(0)) {
      await Promise.resolve(
        Reflect.apply(context.unroute, context, [route.pattern, route.handler]),
      ).catch(() => {});
    }
  };

  const borrowed = wrapEmitter(
    context as unknown as Emitter,
    (event, args) => event === 'page' && args[0]
      ? [wrapPage(args[0] as Page), ...args.slice(1)]
      : args,
  ) as unknown as BrowserContext;
  return new Proxy(borrowed, {
    get(target, property) {
      if (property === 'close') return cleanup;
      if (property === 'pages') {
        return () => {
          const pages = context.pages();
          const selected = selectedPage();
          const ordered = !selected || !pages.includes(selected)
            ? pages
            : [selected, ...pages.filter(page => page !== selected)];
          observePageOrder(ordered);
          return ordered.map(wrapPage);
        };
      }
      if (property === 'newPage') {
        return async (...args: unknown[]) => wrapPage(
          await Reflect.apply(context.newPage, context, args) as Page,
        );
      }
      if (property === 'route') {
        return async (pattern: unknown, handler: unknown, options?: unknown) => {
          routes.push({ pattern, handler });
          return Reflect.apply(context.route, context, [pattern, handler, options]);
        };
      }
      if (property === 'unroute') {
        return async (pattern: unknown, handler?: unknown) => {
          for (let index = routes.length - 1; index >= 0; index -= 1) {
            if (routes[index].pattern === pattern
              && (handler === undefined || routes[index].handler === handler)) {
              routes.splice(index, 1);
            }
          }
          return Reflect.apply(context.unroute, context, [pattern, handler]);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

interface ConnectionOwner {
  count: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

export interface BrowserContextRegistryDependencies {
  readIdentity(signal?: AbortSignal): Promise<BrowserIdentitySnapshot>;
  checkpointIdentity(
    productSessionId: string,
    base: BrowserIdentitySnapshot,
    observedBaseState: BrowserIdentityState,
    state: BrowserIdentityState,
    signal?: AbortSignal,
  ): Promise<BrowserIdentitySnapshot & { conflictCount: number }>;
  browserType: BrowserType;
  resolveResource(signal?: AbortSignal): Promise<BrowserResourceResolution>;
  onContextClosed(productSessionId: string): void;
}

const DEFAULT_DEPENDENCIES: BrowserContextRegistryDependencies = {
  readIdentity: readBrowserIdentity,
  checkpointIdentity: checkpointBrowserIdentity,
  browserType: chromium,
  resolveResource: waitForBrowserResource,
  onContextClosed: () => {},
};

export class BrowserContextRegistry {
  private readonly dependencies: BrowserContextRegistryDependencies;
  private readonly entries = new Map<string, ContextEntry>();
  private readonly contextPromises = new Map<string, Promise<BrowserContext>>();
  private readonly contextAbortControllers = new Map<string, AbortController>();
  private readonly connectionOwners = new Map<string, ConnectionOwner>();
  private browser: Browser | null = null;
  private browserPromise: Promise<Browser> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(dependencies: Partial<BrowserContextRegistryDependencies> = {}) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  }

  retainConnection(productSessionId: string): void {
    const owner = this.connectionOwners.get(productSessionId) ?? { count: 0, releaseTimer: null };
    if (owner.releaseTimer) {
      clearTimeout(owner.releaseTimer);
      owner.releaseTimer = null;
    }
    owner.count += 1;
    this.connectionOwners.set(productSessionId, owner);
  }

  releaseConnection(productSessionId: string): void {
    const owner = this.connectionOwners.get(productSessionId);
    if (!owner) return;
    owner.count = Math.max(0, owner.count - 1);
    this.scheduleContextRelease(productSessionId, owner);
  }

  private scheduleContextRelease(productSessionId: string, owner: ConnectionOwner): void {
    if (owner.count > 0 || owner.releaseTimer) return;
    owner.releaseTimer = setTimeout(() => {
      const current = this.connectionOwners.get(productSessionId);
      if (current !== owner || current.count > 0) return;
      this.connectionOwners.delete(productSessionId);
      void this.closeSessionContext(productSessionId).catch(error => {
        console.warn(
          `[browser-host] context=release-failed error=${error instanceof Error ? error.name : 'unknown'}`,
        );
        if (!this.entries.has(productSessionId) || this.connectionOwners.has(productSessionId)) {
          return;
        }
        const retryOwner: ConnectionOwner = { count: 0, releaseTimer: null };
        this.connectionOwners.set(productSessionId, retryOwner);
        this.scheduleContextRelease(productSessionId, retryOwner);
      });
    }, CONTEXT_REATTACH_GRACE_MS);
    owner.releaseTimer.unref?.();
  }

  /** Cancel only an in-flight Context/lease acquisition for this Session. */
  cancelPendingContext(productSessionId: string): void {
    this.contextAbortControllers.get(productSessionId)?.abort();
  }

  /**
   * Move one live MCP connection, and any Context it already owns, from the
   * provisional Session id to Rust's canonical id. A collision is rejected so
   * two independently-created Contexts are never guessed into one owner.
   */
  rekeyProductSession(previousId: string, nextId: string): boolean {
    if (previousId === nextId) return true;
    if (this.contextPromises.has(previousId) || this.contextPromises.has(nextId)) return false;
    const previousEntry = this.entries.get(previousId);
    if (previousEntry && this.entries.has(nextId)) return false;

    const previousOwner = this.connectionOwners.get(previousId);
    if (!previousOwner || previousOwner.count < 1) return false;
    if (previousOwner.releaseTimer) {
      clearTimeout(previousOwner.releaseTimer);
      previousOwner.releaseTimer = null;
    }
    previousOwner.count -= 1;
    if (previousOwner.count === 0) this.connectionOwners.delete(previousId);

    const nextOwner = this.connectionOwners.get(nextId) ?? { count: 0, releaseTimer: null };
    if (nextOwner.releaseTimer) {
      clearTimeout(nextOwner.releaseTimer);
      nextOwner.releaseTimer = null;
    }
    nextOwner.count += 1;
    this.connectionOwners.set(nextId, nextOwner);

    if (previousEntry) {
      this.entries.delete(previousId);
      this.entries.set(nextId, previousEntry);
    }
    return true;
  }

  reconcileTabAction(
    productSessionId: string,
    action: unknown,
    index: unknown,
  ): void {
    const entry = this.entries.get(productSessionId);
    if (!entry || typeof action !== 'string') return;
    const pages = entry.context.pages();
    const selectedPage = entry.selection.page;
    const previousOrder = entry.backendPageOrder.length > 0
      ? entry.backendPageOrder
      : pages;
    const ordered = [
      ...previousOrder.filter(page => pages.includes(page)),
      ...pages.filter(page => !previousOrder.includes(page)),
    ];
    if (action === 'select' && typeof index === 'number' && Number.isInteger(index)) {
      entry.selection.page = ordered[index] ?? selectedPage;
    } else if (action === 'new') {
      entry.selection.page = ordered.at(-1) ?? selectedPage;
    } else if (action === 'close' && selectedPage && !pages.includes(selectedPage)) {
      const closedIndex = typeof index === 'number' && Number.isInteger(index)
        ? index
        : previousOrder.indexOf(selectedPage);
      entry.selection.page = ordered[Math.min(Math.max(closedIndex, 0), ordered.length - 1)] ?? null;
    }
    entry.backendPageOrder = ordered;
  }

  async getContext(
    binding: VerifiedBrowserCapability,
    signal?: AbortSignal,
  ): Promise<BrowserContext> {
    if (signal?.aborted) throw new Error('BROWSER_CONTEXT_CANCELLED');
    const existing = this.entries.get(binding.productSessionId);
    if (existing) {
      return borrowBrowserContext(
        existing.context,
        () => existing.selection.page,
        pages => { existing.backendPageOrder = pages; },
      );
    }
    const pending = this.contextPromises.get(binding.productSessionId);
    if (pending) {
      const context = await pending;
      const entry = this.entries.get(binding.productSessionId);
      return entry
        ? borrowBrowserContext(
          entry.context,
          () => entry.selection.page,
          pages => { entry.backendPageOrder = pages; },
        )
        : context;
    }

    const abortController = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, abortController.signal])
      : abortController.signal;
    this.contextAbortControllers.set(binding.productSessionId, abortController);
    const promise = this.createContext(
      binding,
      combinedSignal,
    );
    this.contextPromises.set(binding.productSessionId, promise);
    try {
      const context = await promise;
      const entry = this.entries.get(binding.productSessionId);
      return entry
        ? borrowBrowserContext(
          entry.context,
          () => entry.selection.page,
          pages => { entry.backendPageOrder = pages; },
        )
        : context;
    } finally {
      if (this.contextPromises.get(binding.productSessionId) === promise) {
        this.contextPromises.delete(binding.productSessionId);
      }
      if (this.contextAbortControllers.get(binding.productSessionId) === abortController) {
        this.contextAbortControllers.delete(binding.productSessionId);
      }
      if (!this.entries.has(binding.productSessionId)) {
        await this.closeSharedBrowserIfIdle();
      }
    }
  }

  private async createContext(
    binding: VerifiedBrowserCapability,
    signal?: AbortSignal,
  ): Promise<BrowserContext> {
    if (signal?.aborted) throw new Error('BROWSER_CONTEXT_CANCELLED');
    const compiled = compileBrowserRuntimeSettings(
      binding.productSessionId,
      binding.workspacePath,
    );

    const identity = await this.dependencies.readIdentity(signal);
    const resource = await this.dependencies.resolveResource(signal);
    const browser = await this.getBrowser({
      ...compiled.launchOptions,
      executablePath: resource.executablePath,
    });
    const context = await browser.newContext(compiled.contextOptions);
    try {
      if (identity.state.cookies.length > 0) {
        await context.addCookies(identity.state.cookies as BrowserCookie[]);
      }
    } catch (error) {
      await context.close().catch(() => {});
      throw error;
    }

    if (signal?.aborted) {
      await context.close();
      const cancelled = new Error('Browser Context creation was cancelled');
      cancelled.name = 'BROWSER_CONTEXT_CANCELLED';
      throw cancelled;
    }

    const selection = { page: null as Page | null };
    const entry: ContextEntry = {
      context,
      identity,
      observedIdentityState: identity.state,
      selection,
      backendPageOrder: [],
      checkpointPromise: null,
      checkpointTimer: null,
      closePromise: null,
      finalizePromise: null,
    };
    this.entries.set(binding.productSessionId, entry);
    context.once('close', () => {
      const owner = [...this.entries].find(([, candidate]) => candidate.context === context)?.[0]
        ?? binding.productSessionId;
      void this.finalizeClosedEntry(owner, entry).catch(error => {
        console.warn(
          `[browser-host] context=finalize-failed error=${error instanceof Error ? error.name : 'unknown'}`,
        );
      });
    });
    console.info(
      `[browser-host] context=ready mode=managed-isolated hostGeneration=${binding.hostGeneration}`,
    );
    return context;
  }

  private async getBrowser(
    launchOptions: Parameters<BrowserType['launch']>[0],
  ): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.browserPromise) {
      this.browserPromise = this.dependencies.browserType
        .launch(launchOptions)
        .then(browser => {
          this.browser = browser;
          browser.once('disconnected', () => {
            if (this.browser === browser) {
              this.browser = null;
              this.browserPromise = null;
            }
          });
          return browser;
        })
        .catch(error => {
          this.browserPromise = null;
          throw error;
        });
    }
    return this.browserPromise;
  }

  scheduleCheckpoint(productSessionId: string): void {
    const entry = this.entries.get(productSessionId);
    if (!entry) return;
    if (entry.checkpointTimer) clearTimeout(entry.checkpointTimer);
    entry.checkpointTimer = setTimeout(() => {
      entry.checkpointTimer = null;
      void this.checkpoint(productSessionId).catch(error => {
        console.warn(
          `[browser-host] checkpoint=failed code=BROWSER_IDENTITY_CHECKPOINT_FAILED error=${error instanceof Error ? error.name : 'unknown'}`,
        );
      });
    }, CHECKPOINT_DEBOUNCE_MS);
    entry.checkpointTimer.unref?.();
  }

  async checkpoint(productSessionId: string): Promise<void> {
    const entry = this.entries.get(productSessionId);
    if (!entry) return;
    if (entry.checkpointTimer) {
      clearTimeout(entry.checkpointTimer);
      entry.checkpointTimer = null;
    }
    if (entry.checkpointPromise) return entry.checkpointPromise;

    entry.checkpointPromise = (async () => {
      // `storageState()` materializes every non-visible Web Storage origin in
      // a real Playwright page. In headed Chromium that leaks as a temporary
      // tab cycling through historical sites. Managed Browser identity is
      // therefore deliberately cookie-only and uses page-free cookie APIs.
      const state: BrowserIdentityState = {
        cookies: await entry.context.cookies() as unknown as Array<Record<string, unknown>>,
        origins: [],
      };
      const result = await this.dependencies.checkpointIdentity(
        productSessionId,
        entry.identity,
        entry.observedIdentityState,
        state,
      );
      entry.identity = { revision: result.revision, state: result.state };
      // Diff future checkpoints against what this Context actually held, not
      // against a conflicting value another Session committed to the Store.
      entry.observedIdentityState = state;
      console.info(
        `[browser-host] checkpoint=committed revision=${result.revision} conflictCount=${result.conflictCount}`,
      );
    })().finally(() => {
      entry.checkpointPromise = null;
    });
    return entry.checkpointPromise;
  }

  private async checkpointBeforeDestructiveClose(productSessionId: string): Promise<void> {
    try {
      await this.checkpoint(productSessionId);
    } catch {
      try {
        // A retry safely reconciles both transport outcomes: if the first
        // commit reached Rust, CAS returns the authoritative state; if it did
        // not, the same Context state is committed now.
        await this.checkpoint(productSessionId);
      } catch {
        const error = new Error('Browser identity checkpoint could not be confirmed');
        error.name = 'BROWSER_IDENTITY_CHECKPOINT_FAILED';
        throw error;
      }
    }
  }

  private finalizeClosedEntry(productSessionId: string, entry: ContextEntry): Promise<void> {
    if (entry.finalizePromise) return entry.finalizePromise;
    entry.finalizePromise = (async () => {
      if (this.entries.get(productSessionId) === entry) {
        this.entries.delete(productSessionId);
      } else {
        for (const [owner, candidate] of this.entries) {
          if (candidate === entry) {
            this.entries.delete(owner);
            break;
          }
        }
      }
      if (entry.checkpointTimer) {
        clearTimeout(entry.checkpointTimer);
        entry.checkpointTimer = null;
      }
      this.dependencies.onContextClosed(productSessionId);
      await this.closeSharedBrowserIfIdle();
    })();
    return entry.finalizePromise;
  }

  async closeSessionContext(productSessionId: string): Promise<void> {
    const entry = this.entries.get(productSessionId);
    if (!entry) return;
    if (entry.closePromise) return entry.closePromise;
    entry.closePromise = (async () => {
      await this.checkpointBeforeDestructiveClose(productSessionId);
      let closeTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entry.context.close(),
          new Promise<never>((_resolve, reject) => {
            closeTimeout = setTimeout(
              () => reject(new Error('Browser Context close timed out')),
              CONTEXT_CLOSE_TIMEOUT_MS,
            );
            closeTimeout.unref?.();
          }),
        ]);
      } catch {
        const error = new Error('The browser context could not be closed');
        error.name = 'BROWSER_CONTEXT_CLOSE_FAILED';
        throw error;
      } finally {
        if (closeTimeout) clearTimeout(closeTimeout);
      }
      await this.finalizeClosedEntry(productSessionId, entry);
    })().finally(() => {
      entry.closePromise = null;
    });
    return entry.closePromise;
  }

  private async closeSharedBrowserIfIdle(): Promise<void> {
    if (
      !this.browser
      || this.contextPromises.size > 0
      || this.entries.size > 0
    ) return;
    const browser = this.browser;
    this.browser = null;
    this.browserPromise = null;
    await browser.close().catch(() => {});
  }

  private async resetRuntime(options: {
    preserveConnectionOwners: boolean;
  }): Promise<void> {
    const pendingContexts = [...this.contextPromises.values()];
    for (const controller of this.contextAbortControllers.values()) controller.abort();
    await Promise.allSettled(pendingContexts);
    const closeResults = await Promise.allSettled(
      [...this.entries.keys()].map(sessionId => this.closeSessionContext(sessionId)),
    );
    const closeFailure = closeResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (closeFailure) throw closeFailure.reason;
    if (!options.preserveConnectionOwners) {
      for (const owner of this.connectionOwners.values()) {
        if (owner.releaseTimer) clearTimeout(owner.releaseTimer);
      }
      this.connectionOwners.clear();
    }
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.browserPromise = null;
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.resetRuntime({
      preserveConnectionOwners: false,
    });
    return this.shutdownPromise;
  }
}
