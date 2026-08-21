import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import type { PlaywrightBrowserSettings } from '../../shared/config-types';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  bindAuthorizedWorkspaceRoot,
  PlaywrightBrowserHost,
  validateAuthorizedUploadPaths,
} from './browser-host';
import type { BrowserContextRegistry } from './context-registry';

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

function settings(): PlaywrightBrowserSettings {
  return {
    schemaVersion: 1,
    mode: 'isolated',
    headless: true,
    capabilities: ['storage'],
    extraArgs: [],
  };
}

function fakeRegistry() {
  return {
    retainConnection: vi.fn(),
    releaseConnection: vi.fn(),
    cancelPendingContext: vi.fn(),
    prepareConnection: vi.fn(async () => {}),
    rekeyProductSession: vi.fn(() => true),
    reconcileTabAction: vi.fn(),
    getContext: vi.fn(async () => {
      throw new Error('tool listing must not create a BrowserContext');
    }),
    checkpoint: vi.fn(async () => {}),
    closeSessionContext: vi.fn(async () => {}),
    scheduleCheckpoint: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
}

function request(body: unknown, token = TOKEN_A): Request {
  return new Request('http://127.0.0.1/mcp/playwright', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Host: '127.0.0.1',
    },
    body: JSON.stringify(body),
  });
}

function initializeRequest(token = TOKEN_A): Request {
  return request({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'browser-host-test', version: '1' },
    },
  }, token);
}

describe('PlaywrightBrowserHost', () => {
  afterEach(() => vi.useRealTimers());

  it('replaces MCP client-reported roots with the authorized workspace', async () => {
    const server = { listRoots: vi.fn() } as unknown as Server;
    bindAuthorizedWorkspaceRoot(server, '/workspace/authorized');
    await expect(server.listRoots()).resolves.toEqual({
      roots: [{ uri: 'file:///workspace/authorized', name: 'MyAgents workspace' }],
    });
  });

  it('canonicalizes upload paths and rejects a workspace symlink escape', () => {
    const root = mkdtempSync(join(tmpdir(), 'myagents-browser-root-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    const insideFile = join(workspace, 'inside.txt');
    const outsideFile = join(outside, 'secret.txt');
    writeFileSync(insideFile, 'inside');
    writeFileSync(outsideFile, 'outside');
    const escapedDirectory = join(workspace, 'linked');
    symlinkSync(outside, escapedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    const escaped = join(escapedDirectory, 'secret.txt');
    try {
      expect(() => validateAuthorizedUploadPaths(workspace, [insideFile])).not.toThrow();
      expect(() => validateAuthorizedUploadPaths(workspace, [escaped])).toThrowError(
        expect.objectContaining({ name: 'BROWSER_FILE_ACCESS_DENIED' }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds an initialized MCP connection to one capability and releases it exactly once', async () => {
    const registry = fakeRegistry();
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      loadBrowserConfig: () => ({ settings: settings(), source: 'typed' }),
      verifyCapability: vi.fn(async token => ({
        productSessionId: token === TOKEN_A ? 'session-a' : 'session-b',
        workspacePath: token === TOKEN_A ? '/workspace/a' : '/workspace/b',
        hostGeneration: 7,
      })),
    });

    const initialized = await host.handleRequest(initializeRequest());
    expect(initialized.status).toBe(200);
    const mcpSessionId = initialized.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    expect(registry.retainConnection).toHaveBeenCalledWith('session-a');

    const crossSession = await host.handleRequest(new Request('http://127.0.0.1/mcp/playwright', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN_B}`,
        Accept: 'application/json, text/event-stream',
        Host: '127.0.0.1',
        'mcp-session-id': String(mcpSessionId),
      },
    }));
    expect(crossSession.status).toBe(403);

    await host.handleRequest(new Request('http://127.0.0.1/mcp/playwright', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${TOKEN_A}`,
        Accept: 'application/json, text/event-stream',
        Host: '127.0.0.1',
        'mcp-session-id': String(mcpSessionId),
      },
    }));
    expect(registry.releaseConnection).toHaveBeenCalledTimes(1);
    await host.shutdown();
    expect(registry.releaseConnection).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized chunked body before JSON parsing or connection creation', async () => {
    const registry = fakeRegistry();
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      loadBrowserConfig: () => ({ settings: settings(), source: 'typed' }),
      verifyCapability: vi.fn(async () => ({
        productSessionId: 'session-a',
        workspacePath: '/workspace/a',
        hostGeneration: 7,
      })),
    });
    const oversized = new Request('http://127.0.0.1/mcp/playwright', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN_A}`,
        'Content-Type': 'application/json',
        Host: '127.0.0.1',
      },
      body: `{"payload":"${'x'.repeat(4 * 1024 * 1024)}"}`,
    });

    const response = await host.handleRequest(oversized);
    expect(response.status).toBe(413);
    expect(registry.retainConnection).not.toHaveBeenCalled();
  });

  it('returns stable actionable config errors without allocating Context ownership', async () => {
    const registry = fakeRegistry();
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      loadBrowserConfig: () => ({
        settings: settings(),
        source: 'legacy',
        migrationError: 'unsupported legacy browser argument',
      }),
      verifyCapability: vi.fn(async () => ({
        productSessionId: 'session-a',
        workspacePath: '/workspace/a',
        hostGeneration: 7,
      })),
    });

    const response = await host.handleRequest(initializeRequest());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { data: { code: 'BROWSER_CONFIG_MIGRATION_REQUIRED' } },
    });
    expect(registry.retainConnection).not.toHaveBeenCalled();
  });

  it('releases Context ownership when the source Sidecar dies without closing MCP', async () => {
    vi.useFakeTimers();
    const registry = fakeRegistry();
    let sourceIsLive = true;
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      loadBrowserConfig: () => ({ settings: settings(), source: 'typed' }),
      verifyCapability: vi.fn(async () => {
        if (!sourceIsLive) {
          const error = new Error('source Sidecar is no longer current');
          error.name = 'browser_capability_invalid';
          throw error;
        }
        return {
          productSessionId: 'session-a',
          workspacePath: '/workspace/a',
          hostGeneration: 7,
        };
      }),
    });

    const initialized = await host.handleRequest(initializeRequest());
    expect(initialized.status).toBe(200);
    sourceIsLive = false;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(registry.releaseConnection).toHaveBeenCalledTimes(1);
    await host.shutdown();
    expect(registry.releaseConnection).toHaveBeenCalledTimes(1);
  });

  it('routes MCP cancellation to only the pending Context acquisition', async () => {
    const registry = fakeRegistry();
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      loadBrowserConfig: () => ({ settings: settings(), source: 'typed' }),
      verifyCapability: vi.fn(async () => ({
        productSessionId: 'session-a',
        workspacePath: '/workspace/a',
        hostGeneration: 7,
      })),
    });
    const initialized = await host.handleRequest(initializeRequest());
    const mcpSessionId = initialized.headers.get('mcp-session-id');

    await host.handleRequest(new Request('http://127.0.0.1/mcp/playwright', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN_A}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Host: '127.0.0.1',
        'mcp-session-id': String(mcpSessionId),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 2, reason: 'user stopped the turn' },
      }),
    }));

    expect(registry.cancelPendingContext).toHaveBeenCalledWith('session-a');
    await host.shutdown();
  });

  it('rekeys a live connection when Rust upgrades its provisional Product Session id', async () => {
    const registry = fakeRegistry();
    let productSessionId = 'pending-tab-a';
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      loadBrowserConfig: () => ({ settings: settings(), source: 'typed' }),
      verifyCapability: vi.fn(async () => ({
        productSessionId,
        workspacePath: '/workspace/a',
        hostGeneration: 7,
      })),
    });
    const initialized = await host.handleRequest(initializeRequest());
    const mcpSessionId = initialized.headers.get('mcp-session-id');
    productSessionId = 'real-session-a';

    const response = await host.handleRequest(new Request('http://127.0.0.1/mcp/playwright', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN_A}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Host: '127.0.0.1',
        'mcp-session-id': String(mcpSessionId),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    }));

    expect(response.status).toBe(200);
    expect(registry.rekeyProductSession).toHaveBeenCalledWith(
      'pending-tab-a',
      'real-session-a',
    );
    await host.shutdown();
    expect(registry.releaseConnection).toHaveBeenLastCalledWith('real-session-a');
  });

  it('retires the old MCP connection before applying a changed Browser config', async () => {
    const registry = fakeRegistry();
    let headless = true;
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      loadBrowserConfig: () => ({
        settings: { ...settings(), headless },
        source: 'typed',
      }),
      verifyCapability: vi.fn(async () => ({
        productSessionId: 'session-a',
        workspacePath: '/workspace/a',
        hostGeneration: 7,
      })),
    });
    const first = await host.handleRequest(initializeRequest());
    const firstSessionId = first.headers.get('mcp-session-id');
    headless = false;
    const replacement = await host.handleRequest(initializeRequest());

    expect(replacement.status).toBe(200);
    expect(registry.releaseConnection).toHaveBeenCalledWith('session-a');
    const stale = await host.handleRequest(new Request('http://127.0.0.1/mcp/playwright', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN_A}`,
        Host: '127.0.0.1',
        'mcp-session-id': String(firstSessionId),
      },
    }));
    expect(stale.status).toBe(404);
    await host.shutdown();
  });

  it('drains an active request before applying a changed Browser config', async () => {
    const registry = fakeRegistry();
    let headless = true;
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      loadBrowserConfig: () => ({ settings: { ...settings(), headless }, source: 'typed' }),
      verifyCapability: vi.fn(async () => ({
        productSessionId: 'session-a',
        workspacePath: '/workspace/a',
        hostGeneration: 7,
      })),
    });
    const first = await host.handleRequest(initializeRequest());
    const firstSessionId = String(first.headers.get('mcp-session-id'));
    const connection = (host as unknown as {
      connections: Map<string, { transport: { handleRequest: () => Promise<Response> } }>;
    }).connections.get(firstSessionId)!;
    let finishActive!: () => void;
    connection.transport.handleRequest = vi.fn(() => new Promise<Response>(resolve => {
      finishActive = () => resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    const active = host.handleRequest(new Request('http://127.0.0.1/mcp/playwright', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN_A}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Host: '127.0.0.1',
        'mcp-session-id': firstSessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    }));
    await vi.waitFor(() => expect(connection.transport.handleRequest).toHaveBeenCalledOnce());

    headless = false;
    const replacement = host.handleRequest(initializeRequest());
    await Promise.resolve();
    await vi.waitFor(() => {
      expect(registry.cancelPendingContext).toHaveBeenCalledWith('session-a');
    });
    expect(registry.releaseConnection).not.toHaveBeenCalled();

    finishActive();
    await expect(active).resolves.toMatchObject({ status: 200 });
    await expect(replacement).resolves.toMatchObject({ status: 200 });
    expect(registry.releaseConnection).toHaveBeenCalledTimes(1);
    await host.shutdown();
  });

  it('drains an initialize admitted before shutdown before closing the registry', async () => {
    const registry = fakeRegistry();
    let finishVerify!: () => void;
    const verifyGate = new Promise<void>(resolve => {
      finishVerify = resolve;
    });
    const verifyCapability = vi.fn(async () => {
      await verifyGate;
      return {
        productSessionId: 'session-a',
        workspacePath: '/workspace/a',
        hostGeneration: 7,
      };
    });
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      loadBrowserConfig: () => ({ settings: settings(), source: 'typed' }),
      verifyCapability,
    });

    const initialize = host.handleRequest(initializeRequest());
    await vi.waitFor(() => expect(verifyCapability).toHaveBeenCalledOnce());
    const shutdown = host.shutdown();
    await Promise.resolve();
    expect(registry.shutdown).not.toHaveBeenCalled();

    finishVerify();
    await expect(initialize).resolves.toMatchObject({ status: 200 });
    await expect(shutdown).resolves.toBeUndefined();
    expect(registry.retainConnection).toHaveBeenCalledWith('session-a');
    expect(registry.releaseConnection).toHaveBeenCalledWith('session-a');
    expect(registry.shutdown).toHaveBeenCalledOnce();
  });

  it('cancels a registered Profile waiter before waiting for Host request drain', async () => {
    const registry = fakeRegistry();
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      loadBrowserConfig: () => ({ settings: settings(), source: 'typed' }),
      verifyCapability: vi.fn(async () => ({
        productSessionId: 'session-a',
        workspacePath: '/workspace/a',
        hostGeneration: 7,
      })),
    });
    const initialized = await host.handleRequest(initializeRequest());
    const sessionId = initialized.headers.get('mcp-session-id');
    const connection = (host as unknown as {
      connections: Map<string, { transport: { handleRequest: () => Promise<Response> } }>;
    }).connections.get(String(sessionId))!;
    let finishWaitingRequest!: () => void;
    connection.transport.handleRequest = vi.fn(() => new Promise<Response>(resolve => {
      finishWaitingRequest = () => resolve(new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32000, message: 'Profile acquisition cancelled' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }));
    registry.cancelPendingContext.mockImplementation(() => finishWaitingRequest?.());
    const active = host.handleRequest(new Request('http://127.0.0.1/mcp/playwright', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN_A}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Host: '127.0.0.1',
        'mcp-session-id': String(sessionId),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'browser_navigate', arguments: { url: 'https://example.com' } },
      }),
    }));
    await vi.waitFor(() => expect(connection.transport.handleRequest).toHaveBeenCalledOnce());

    const shutdown = host.shutdown();

    await expect(active).resolves.toMatchObject({ status: 200 });
    await expect(shutdown).resolves.toBeUndefined();
    expect(registry.cancelPendingContext).toHaveBeenCalledWith('session-a');
    expect(registry.releaseConnection).toHaveBeenCalledWith('session-a');
    expect(registry.shutdown).toHaveBeenCalledOnce();
  });

  it('supersedes an abandoned transport for the same exact Session binding', async () => {
    const registry = fakeRegistry();
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      loadBrowserConfig: () => ({ settings: settings(), source: 'typed' }),
      verifyCapability: vi.fn(async () => ({
        productSessionId: 'session-a',
        workspacePath: '/workspace/a',
        hostGeneration: 7,
      })),
    });
    const first = await host.handleRequest(initializeRequest());
    const firstSessionId = first.headers.get('mcp-session-id');
    const replacement = await host.handleRequest(initializeRequest());

    expect(replacement.status).toBe(200);
    expect(registry.releaseConnection).toHaveBeenCalledTimes(1);
    const stale = await host.handleRequest(new Request('http://127.0.0.1/mcp/playwright', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN_A}`,
        Host: '127.0.0.1',
        'mcp-session-id': String(firstSessionId),
      },
    }));
    expect(stale.status).toBe(404);
    await host.shutdown();
  });
});
