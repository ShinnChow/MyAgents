import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import {
  bindAuthorizedWorkspaceRoot,
  PlaywrightBrowserHost,
  validateAuthorizedUploadPaths,
} from './browser-host';
import type { BrowserContextRegistry } from './context-registry';

const TOKEN_A = 'a'.repeat(32);
const TOKEN_B = 'b'.repeat(32);

function fakeRegistry() {
  return {
    retainConnection: vi.fn(),
    releaseConnection: vi.fn(),
    cancelPendingContext: vi.fn(),
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

function request(body: unknown, token = TOKEN_A, sessionId?: string): Request {
  return new Request('http://127.0.0.1/mcp/browser', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Host: '127.0.0.1',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
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

function capability(token: string) {
  return {
    productSessionId: token === TOKEN_A ? 'session-a' : 'session-b',
    workspacePath: '/workspace/a',
    hostGeneration: 7,
  };
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
    try {
      expect(() => validateAuthorizedUploadPaths(workspace, [insideFile])).not.toThrow();
      expect(() => validateAuthorizedUploadPaths(workspace, [join(escapedDirectory, 'secret.txt')]))
        .toThrowError(expect.objectContaining({ name: 'BROWSER_FILE_ACCESS_DENIED' }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds an initialized MCP connection to one capability and releases it exactly once', async () => {
    const registry = fakeRegistry();
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      verifyCapability: vi.fn(async token => capability(token)),
    });

    const initialized = await host.handleRequest(initializeRequest());
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    expect(registry.retainConnection).toHaveBeenCalledWith('session-a');

    const crossSession = await host.handleRequest(new Request('http://127.0.0.1/mcp/browser', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN_B}`,
        Host: '127.0.0.1',
        'mcp-session-id': String(sessionId),
      },
    }));
    expect(crossSession.status).toBe(403);
    expect(registry.rekeyProductSession).not.toHaveBeenCalled();

    await host.handleRequest(new Request('http://127.0.0.1/mcp/browser', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${TOKEN_A}`,
        Accept: 'application/json, text/event-stream',
        Host: '127.0.0.1',
        'mcp-session-id': String(sessionId),
      },
    }));
    expect(registry.releaseConnection).toHaveBeenCalledOnce();
    await host.shutdown();
    expect(registry.releaseConnection).toHaveBeenCalledOnce();
  });

  it('accepts a rotated capability for the same Product Session connection', async () => {
    const registry = fakeRegistry();
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      verifyCapability: vi.fn(async () => capability(TOKEN_A)),
    });

    const initialized = await host.handleRequest(initializeRequest(TOKEN_A));
    const sessionId = String(initialized.headers.get('mcp-session-id'));
    const closedWithRotatedCapability = await host.handleRequest(new Request('http://127.0.0.1/mcp/browser', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${TOKEN_B}`,
        Accept: 'application/json, text/event-stream',
        Host: '127.0.0.1',
        'mcp-session-id': sessionId,
      },
    }));

    expect(closedWithRotatedCapability.status).not.toBe(403);
    expect(registry.releaseConnection).toHaveBeenCalledOnce();
    await host.shutdown();
  });

  it('does not let an invalid result for the old capability retire a rotated connection', async () => {
    const registry = fakeRegistry();
    let rejectOldCapability!: (error: Error) => void;
    let verificationCount = 0;
    const verifyCapability = vi.fn(async (token: string) => {
      verificationCount += 1;
      if (verificationCount === 2 && token === TOKEN_A) {
        return await new Promise<ReturnType<typeof capability>>((_, reject) => {
          rejectOldCapability = reject;
        });
      }
      return capability(TOKEN_A);
    });
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      verifyCapability,
    });

    const initialized = await host.handleRequest(initializeRequest(TOKEN_A));
    const sessionId = String(initialized.headers.get('mcp-session-id'));
    const sweep = (host as unknown as { sweepCapabilities(): Promise<void> }).sweepCapabilities();
    await vi.waitFor(() => expect(verificationCount).toBe(2));

    const rotated = await host.handleRequest(request({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }, TOKEN_B, sessionId));
    expect(rotated.status).toBe(200);

    const staleError = new Error('old capability expired');
    staleError.name = 'browser_capability_invalid';
    rejectOldCapability(staleError);
    await sweep;

    expect(registry.releaseConnection).not.toHaveBeenCalled();
    const stillLive = await host.handleRequest(request({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: {},
    }, TOKEN_B, sessionId));
    expect(stillLive.status).toBe(200);
    await host.shutdown();
  });

  it('rejects an oversized chunked body before connection creation', async () => {
    const registry = fakeRegistry();
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      verifyCapability: vi.fn(async token => capability(token)),
    });
    const oversized = new Request('http://127.0.0.1/mcp/browser', {
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
    await host.shutdown();
  });

  it('releases Context ownership when the source Sidecar retires', async () => {
    vi.useFakeTimers();
    const registry = fakeRegistry();
    let sourceIsLive = true;
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      verifyCapability: vi.fn(async () => {
        if (!sourceIsLive) {
          const error = new Error('source Sidecar is no longer current');
          error.name = 'browser_capability_invalid';
          throw error;
        }
        return capability(TOKEN_A);
      }),
    });

    expect((await host.handleRequest(initializeRequest())).status).toBe(200);
    sourceIsLive = false;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(registry.releaseConnection).toHaveBeenCalledOnce();
    await host.shutdown();
  });

  it('routes cancellation to only the pending Context acquisition', async () => {
    const registry = fakeRegistry();
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      verifyCapability: vi.fn(async token => capability(token)),
    });
    const initialized = await host.handleRequest(initializeRequest());
    const sessionId = String(initialized.headers.get('mcp-session-id'));

    const response = await host.handleRequest(request({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 7, reason: 'stopped' },
    }, TOKEN_A, sessionId));

    expect(response.status).toBeLessThan(500);
    expect(registry.cancelPendingContext).toHaveBeenCalledWith('session-a');
    await host.shutdown();
  });

  it('rekeys a live connection when Rust materializes its provisional Session id', async () => {
    const registry = fakeRegistry();
    let productSessionId = 'pending-tab-a';
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      verifyCapability: vi.fn(async () => ({
        productSessionId,
        workspacePath: '/workspace/a',
        hostGeneration: 7,
      })),
    });
    const initialized = await host.handleRequest(initializeRequest());
    const sessionId = String(initialized.headers.get('mcp-session-id'));
    productSessionId = 'real-session-a';

    const response = await host.handleRequest(new Request('http://127.0.0.1/mcp/browser', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TOKEN_A}`,
        Accept: 'application/json, text/event-stream',
        Host: '127.0.0.1',
        'mcp-session-id': sessionId,
      },
    }));

    expect(response.status).toBe(200);
    expect(registry.rekeyProductSession).toHaveBeenCalledWith('pending-tab-a', 'real-session-a');
    await host.shutdown();
    expect(registry.releaseConnection).toHaveBeenLastCalledWith('real-session-a');
  });

  it('cancels an active resource waiter before waiting for Host shutdown drain', async () => {
    const registry = fakeRegistry();
    const host = new PlaywrightBrowserHost({
      registry: registry as unknown as BrowserContextRegistry,
      verifyCapability: vi.fn(async token => capability(token)),
    });
    const initialized = await host.handleRequest(initializeRequest());
    const sessionId = String(initialized.headers.get('mcp-session-id'));
    const connection = (host as unknown as {
      connections: Map<string, { transport: { handleRequest: () => Promise<Response> } }>;
    }).connections.get(sessionId)!;
    let finishWaitingRequest!: () => void;
    connection.transport.handleRequest = vi.fn(() => new Promise<Response>(resolve => {
      finishWaitingRequest = () => resolve(new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        error: { code: -32000, message: 'Browser resource wait cancelled' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }));
    registry.cancelPendingContext.mockImplementation(() => finishWaitingRequest?.());
    const active = host.handleRequest(request({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'browser_navigate', arguments: { url: 'https://example.com' } },
    }, TOKEN_A, sessionId));
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
      verifyCapability: vi.fn(async token => capability(token)),
    });
    const first = await host.handleRequest(initializeRequest());
    const firstSessionId = first.headers.get('mcp-session-id');
    const replacement = await host.handleRequest(initializeRequest());

    expect(replacement.status).toBe(200);
    expect(registry.releaseConnection).toHaveBeenCalledOnce();
    const stale = await host.handleRequest(new Request('http://127.0.0.1/mcp/browser', {
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
