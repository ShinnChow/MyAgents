import { randomUUID, timingSafeEqual } from 'crypto';
import { realpathSync } from 'fs';
import { isAbsolute, relative } from 'path';
import { pathToFileURL } from 'url';

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

import { BrowserContextRegistry } from './context-registry';
import { verifyBrowserCapability, type VerifiedBrowserCapability } from './capability-client';
import { compileBrowserRuntimeSettings } from './runtime-settings';

const MAX_MCP_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_MCP_CONNECTIONS = 256;
const CAPABILITY_SWEEP_INTERVAL_MS = 5_000;

interface HostConnection {
  token: string;
  binding: VerifiedBrowserCapability;
  server: Server;
  transport: WebStandardStreamableHTTPServerTransport;
  abortController: AbortController;
  sessionId: string | null;
  closed: boolean;
  retiring: boolean;
  activeRequests: number;
  drainWaiters: Set<() => void>;
}

export interface PlaywrightBrowserHostDependencies {
  verifyCapability(token: string, signal?: AbortSignal): Promise<VerifiedBrowserCapability>;
  registry: BrowserContextRegistry;
}

export function bindAuthorizedWorkspaceRoot(server: Server, workspacePath: string): void {
  server.listRoots = async () => ({
    roots: [{ uri: pathToFileURL(workspacePath).href, name: 'MyAgents workspace' }],
  });
}

function extractBearer(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return null;
  const token = authorization.slice('Bearer '.length).trim();
  return /^[a-f0-9]{32}$/.test(token) ? token : null;
}

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sameBinding(left: VerifiedBrowserCapability, right: VerifiedBrowserCapability): boolean {
  return left.productSessionId === right.productSessionId
    && left.workspacePath === right.workspacePath
    && left.hostGeneration === right.hostGeneration;
}

export function validateAuthorizedUploadPaths(
  workspacePath: string,
  paths: unknown,
): void {
  if (paths === undefined) return;
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) {
    const error = new Error('Browser upload paths are invalid');
    error.name = 'BROWSER_FILE_ACCESS_DENIED';
    throw error;
  }
  let workspace: string;
  try {
    workspace = realpathSync(workspacePath);
  } catch {
    const error = new Error('Browser upload root is unavailable');
    error.name = 'BROWSER_FILE_ACCESS_DENIED';
    throw error;
  }
  for (const path of paths) {
    try {
      const canonical = realpathSync(path);
      const candidate = relative(workspace, canonical);
      if (candidate === '..' || candidate.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(candidate)) {
        throw new Error('outside root');
      }
    } catch {
      const error = new Error('Browser upload path is outside the authorized workspace');
      error.name = 'BROWSER_FILE_ACCESS_DENIED';
      throw error;
    }
  }
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32_000, message, data: { code } },
    id: null,
  }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function browserConnectionError(error: unknown): { status: number; code: string; message: string } {
  const message = error instanceof Error ? error.message : '';
  const messageCode = /^(BROWSER_[A-Z_]+):/.exec(message)?.[1];
  const code = error instanceof Error && error.name !== 'Error' ? error.name : (messageCode ?? '');
  if (code === 'BROWSER_CONTEXT_CLOSE_FAILED') {
    return { status: 500, code, message: 'The browser could not be closed safely' };
  }
  if (code === 'BROWSER_IDENTITY_CHECKPOINT_FAILED') {
    return { status: 503, code, message: 'Browser login state could not be confirmed' };
  }
  if (code.startsWith('BROWSER_RESOURCE_')) {
    return { status: 503, code, message: 'Browser resources are not ready' };
  }
  return {
    status: 503,
    code: 'BROWSER_CONNECTION_FAILED',
    message: 'Browser MCP connection could not start',
  };
}

function requestBodyMethod(body: unknown): {
  method?: string;
  toolName?: string;
  toolArguments?: Record<string, unknown>;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const params = record.params && typeof record.params === 'object' && !Array.isArray(record.params)
    ? record.params as Record<string, unknown>
    : undefined;
  return {
    method: typeof record.method === 'string' ? record.method : undefined,
    toolName: typeof params?.name === 'string' ? params.name : undefined,
    toolArguments: params?.arguments && typeof params.arguments === 'object'
      && !Array.isArray(params.arguments)
      ? params.arguments as Record<string, unknown>
      : undefined,
  };
}

async function readBoundedJsonBody(request: Request): Promise<
  | { ok: true; body: unknown }
  | { ok: false; response: Response }
> {
  if (!request.body) {
    return { ok: false, response: jsonError(400, 'BROWSER_REQUEST_INVALID', 'Browser MCP request body is invalid') };
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MCP_REQUEST_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, response: jsonError(413, 'BROWSER_REQUEST_TOO_LARGE', 'Browser MCP request is too large') };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: jsonError(400, 'BROWSER_REQUEST_INVALID', 'Browser MCP request body is invalid') };
  } finally {
    reader.releaseLock();
  }
}

export class PlaywrightBrowserHost {
  private readonly dependencies: PlaywrightBrowserHostDependencies;
  private readonly allowedHosts: string[];
  private readonly connections = new Map<string, HostConnection>();
  private readonly pendingConnections = new Set<HostConnection>();
  private capabilitySweepTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionCreationTail: Promise<void> = Promise.resolve();
  private activeHostRequests = 0;
  private readonly hostDrainWaiters = new Set<() => void>();
  private closing = false;

  constructor(
    httpPort: number,
    dependencies: Partial<PlaywrightBrowserHostDependencies> = {},
  ) {
    const registry = dependencies.registry ?? new BrowserContextRegistry({
      onContextClosed: productSessionId => {
        void this.retireConnectionsForProductSession(productSessionId);
      },
    });
    this.dependencies = {
      verifyCapability: verifyBrowserCapability,
      registry,
      ...dependencies,
    };
    this.allowedHosts = [`127.0.0.1:${httpPort}`];
  }

  async handleRequest(request: Request): Promise<Response> {
    if (this.closing) return jsonError(503, 'BROWSER_HOST_STOPPING', 'Browser Host is stopping');
    this.activeHostRequests += 1;
    try {
      return await this.handleAdmittedRequest(request);
    } finally {
      this.activeHostRequests = Math.max(0, this.activeHostRequests - 1);
      if (this.activeHostRequests === 0) {
        for (const resolve of this.hostDrainWaiters) resolve();
        this.hostDrainWaiters.clear();
      }
    }
  }

  private async handleAdmittedRequest(request: Request): Promise<Response> {
    if (!['POST', 'GET', 'DELETE'].includes(request.method)) {
      return jsonError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
    }
    const contentLength = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_MCP_REQUEST_BYTES) {
      return jsonError(413, 'BROWSER_REQUEST_TOO_LARGE', 'Browser MCP request is too large');
    }
    const token = extractBearer(request);
    if (!token) return jsonError(401, 'BROWSER_CAPABILITY_REQUIRED', 'Browser capability is required');

    let binding: VerifiedBrowserCapability;
    try {
      binding = await this.dependencies.verifyCapability(token, request.signal);
    } catch {
      return jsonError(401, 'BROWSER_CAPABILITY_INVALID', 'Browser capability is invalid or expired');
    }

    const mcpSessionId = request.headers.get('mcp-session-id');
    let connection: HostConnection | undefined;
    let parsedBody: unknown;
    if (request.method === 'POST') {
      const parsed = await readBoundedJsonBody(request);
      if (!parsed.ok) return parsed.response;
      parsedBody = parsed.body;
    }

    if (mcpSessionId) {
      connection = this.connections.get(mcpSessionId);
      if (!connection) return jsonError(404, 'BROWSER_CONNECTION_NOT_FOUND', 'Browser MCP connection was not found');
      if (connection.retiring) {
        return jsonError(409, 'BROWSER_CONNECTION_REPLACED', 'Browser MCP connection was replaced');
      }
      if (!this.reconcileConnectionBinding(connection, binding)) {
        return jsonError(403, 'BROWSER_CONNECTION_FORBIDDEN', 'Browser MCP connection belongs to another Session');
      }
      // Rust has already authenticated the presented capability and resolved
      // it back to the same Product Session/workspace/Host generation. Accept
      // credential rotation for that owner (for example after a Session
      // Sidecar restart) and keep the connection's sweep credential current.
      if (!tokensEqual(connection.token, token)) connection.token = token;
    } else if (request.method === 'POST') {
      const requestShape = requestBodyMethod(parsedBody);
      if (requestShape.method !== 'initialize') {
        return jsonError(400, 'BROWSER_CONNECTION_REQUIRED', 'MCP initialization is required');
      }
      if (this.connections.size + this.pendingConnections.size >= MAX_MCP_CONNECTIONS) {
        return jsonError(503, 'BROWSER_CONNECTION_CAPACITY', 'Browser Host connection capacity reached');
      }
      try {
        connection = await this.createConnection(token, binding);
      } catch (error) {
        const failure = browserConnectionError(error);
        console.warn(
          `[browser-host] connection=failed code=${failure.code} error=${error instanceof Error ? error.name : 'unknown'}`,
        );
        return jsonError(failure.status, failure.code, failure.message);
      }
    } else {
      return jsonError(400, 'BROWSER_CONNECTION_REQUIRED', 'MCP session id is required');
    }

    const { method, toolName, toolArguments } = requestBodyMethod(parsedBody);
    if (method === 'notifications/cancelled') {
      this.dependencies.registry.cancelPendingContext(binding.productSessionId);
    }
    const isToolCall = method === 'tools/call' && toolName?.startsWith('browser_') === true;
    if (isToolCall && toolName === 'browser_file_upload') {
      try {
        validateAuthorizedUploadPaths(binding.workspacePath, toolArguments?.paths);
      } catch {
        return jsonError(403, 'BROWSER_FILE_ACCESS_DENIED', 'Browser upload path is not authorized');
      }
    }

    let response: Response;
    const cancelPendingContext = () => {
      if (isToolCall) this.dependencies.registry.cancelPendingContext(binding.productSessionId);
    };
    if (isToolCall) {
      if (request.signal.aborted) cancelPendingContext();
      else request.signal.addEventListener('abort', cancelPendingContext, { once: true });
    }
    connection.activeRequests += 1;
    try {
      try {
        response = await connection.transport.handleRequest(
          request,
          parsedBody === undefined ? undefined : { parsedBody },
        );
      } catch (error) {
        console.warn(
          `[browser-host] request=failed code=BROWSER_TRANSPORT_FAILED error=${error instanceof Error ? error.name : 'unknown'}`,
        );
        connection.retiring = true;
        return jsonError(500, 'BROWSER_TRANSPORT_FAILED', 'Browser MCP request failed');
      }
      if (isToolCall && response.ok && !connection.closed) {
        if (toolName === 'browser_close') {
          try {
            await this.dependencies.registry.closeSessionContext(binding.productSessionId);
          } catch (error) {
            const failure = browserConnectionError(error);
            return jsonError(failure.status, failure.code, failure.message);
          }
        } else {
          if (toolName === 'browser_tabs') {
            this.dependencies.registry.reconcileTabAction(
              binding.productSessionId,
              toolArguments?.action,
              toolArguments?.index,
            );
          }
          this.dependencies.registry.scheduleCheckpoint(binding.productSessionId);
        }
      }
      if (method === 'initialize' && response.ok && !connection.closed) {
        await this.retireSupersededConnections(connection);
      }
      if (request.method === 'DELETE' && mcpSessionId) {
        await this.closeConnection(mcpSessionId);
      } else if (!mcpSessionId && !connection.sessionId) {
        await this.disposeConnection(connection);
      }
      return response;
    } finally {
      connection.activeRequests = Math.max(0, connection.activeRequests - 1);
      request.signal.removeEventListener('abort', cancelPendingContext);
      if (connection.activeRequests === 0) {
        for (const resolve of connection.drainWaiters) resolve();
        connection.drainWaiters.clear();
        if (connection.retiring) await this.disposeConnection(connection);
      }
    }
  }

  private async createConnection(
    token: string,
    binding: VerifiedBrowserCapability,
  ): Promise<HostConnection> {
    const queued = this.connectionCreationTail.then(() => (
      this.createConnectionSerial(token, binding)
    ));
    this.connectionCreationTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async createConnectionSerial(
    token: string,
    binding: VerifiedBrowserCapability,
  ): Promise<HostConnection> {
    const compiled = compileBrowserRuntimeSettings(
      binding.productSessionId,
      binding.workspacePath,
    );
    const abortController = new AbortController();
    this.dependencies.registry.retainConnection(binding.productSessionId);
    let server: Server;
    try {
      const { createConnection } = await import('@playwright/mcp');
      server = await createConnection(
        compiled.connectionConfig,
        () => this.dependencies.registry.getContext(
          binding,
          abortController.signal,
        ),
      );
    } catch (error) {
      this.dependencies.registry.releaseConnection(binding.productSessionId);
      throw error;
    }
    bindAuthorizedWorkspaceRoot(server, binding.workspacePath);
    let assignedSessionId: string | null = null;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      allowedHosts: this.allowedHosts,
      enableDnsRebindingProtection: true,
      onsessioninitialized: sessionId => {
        assignedSessionId = sessionId;
        connection.sessionId = sessionId;
        this.pendingConnections.delete(connection);
        this.connections.set(sessionId, connection);
      },
      onsessionclosed: sessionId => {
        void this.closeConnection(sessionId);
      },
    });
    const connection: HostConnection = {
      token,
      binding,
      server,
      transport,
      abortController,
      sessionId: null,
      closed: false,
      retiring: false,
      activeRequests: 0,
      drainWaiters: new Set(),
    };
    this.pendingConnections.add(connection);
    this.scheduleCapabilitySweep();
    try {
      await server.connect(transport);
    } catch (error) {
      this.pendingConnections.delete(connection);
      if (assignedSessionId) this.connections.delete(assignedSessionId);
      await this.disposeConnection(connection);
      throw error;
    }
    return connection;
  }

  private async closeConnection(sessionId: string): Promise<void> {
    const connection = this.connections.get(sessionId);
    if (!connection) return;
    this.connections.delete(sessionId);
    await this.disposeConnection(connection);
  }

  private async disposeConnection(connection: HostConnection): Promise<void> {
    if (connection.closed) return;
    connection.retiring = true;
    if (connection.activeRequests > 0) return;
    connection.closed = true;
    this.pendingConnections.delete(connection);
    if (connection.sessionId) this.connections.delete(connection.sessionId);
    connection.abortController.abort();
    await connection.server.close().catch(() => {});
    this.dependencies.registry.releaseConnection(connection.binding.productSessionId);
    if (this.connections.size === 0 && this.pendingConnections.size === 0) {
      if (this.capabilitySweepTimer) clearTimeout(this.capabilitySweepTimer);
      this.capabilitySweepTimer = null;
    }
  }

  private beginRetiringConnection(connection: HostConnection): void {
    if (connection.closed) return;
    connection.retiring = true;
    // A resource/Context waiter has not entered a BrowserContext yet, so it is
    // already at a safe replacement boundary. Cancel that exact pending
    // acquisition; real Browser tool calls with an established Context drain.
    this.dependencies.registry.cancelPendingContext(connection.binding.productSessionId);
  }

  private async retireConnection(connection: HostConnection): Promise<void> {
    if (connection.closed) return;
    this.beginRetiringConnection(connection);
    if (connection.activeRequests > 0) {
      await new Promise<void>(resolve => connection.drainWaiters.add(resolve));
    }
    await this.disposeConnection(connection);
  }

  private async retireSupersededConnections(current: HostConnection): Promise<void> {
    const candidates = new Set([...this.connections.values(), ...this.pendingConnections]);
    await Promise.allSettled([...candidates].map(async connection => {
      if (connection === current || connection.closed || !sameBinding(connection.binding, current.binding)) {
        return;
      }
      connection.retiring = true;
      if (connection.activeRequests === 0) await this.disposeConnection(connection);
    }));
  }

  private async retireConnectionsForProductSession(productSessionId: string): Promise<void> {
    const candidates = new Set([...this.connections.values(), ...this.pendingConnections]);
    await Promise.allSettled([...candidates].map(async connection => {
      if (connection.closed || connection.binding.productSessionId !== productSessionId) return;
      connection.retiring = true;
      if (connection.activeRequests === 0) await this.disposeConnection(connection);
    }));
  }

  async retireProductSession(productSessionId: string): Promise<void> {
    const candidates = new Set([...this.connections.values(), ...this.pendingConnections]);
    await Promise.all([...candidates]
      .filter(connection => connection.binding.productSessionId === productSessionId)
      .map(connection => this.retireConnection(connection)));
    await this.dependencies.registry.closeSessionContext(productSessionId);
  }

  private reconcileConnectionBinding(
    connection: HostConnection,
    binding: VerifiedBrowserCapability,
  ): boolean {
    if (sameBinding(connection.binding, binding)) return true;
    if (
      !connection.binding.productSessionId.startsWith('pending-')
      || binding.productSessionId.startsWith('pending-')
      || connection.binding.hostGeneration !== binding.hostGeneration
      || connection.binding.workspacePath !== binding.workspacePath
      || !this.dependencies.registry.rekeyProductSession(
        connection.binding.productSessionId,
        binding.productSessionId,
      )
    ) return false;
    connection.binding = binding;
    return true;
  }

  private scheduleCapabilitySweep(): void {
    if (
      this.closing
      || this.capabilitySweepTimer
      || (this.connections.size === 0 && this.pendingConnections.size === 0)
    ) return;
    this.capabilitySweepTimer = setTimeout(() => {
      this.capabilitySweepTimer = null;
      void this.sweepCapabilities().finally(() => this.scheduleCapabilitySweep());
    }, CAPABILITY_SWEEP_INTERVAL_MS);
    this.capabilitySweepTimer.unref?.();
  }

  private async sweepCapabilities(): Promise<void> {
    const candidates = new Set([...this.connections.values(), ...this.pendingConnections]);
    await Promise.allSettled([...candidates].map(async connection => {
      if (connection.closed) return;
      const verifiedToken = connection.token;
      try {
        const binding = await this.dependencies.verifyCapability(verifiedToken);
        // A request may rotate this connection's capability while the control
        // plane is verifying the old credential. Discard that stale result;
        // the next bounded sweep will verify the current token.
        if (!tokensEqual(connection.token, verifiedToken)) return;
        if (!this.reconcileConnectionBinding(connection, binding)) {
          await this.disposeConnection(connection);
        }
      } catch (error) {
        // Rust returns this stable code only when the source or Host
        // generation is no longer live. Transient control-plane failures keep
        // the Context and are retried by the next bounded sweep.
        if (
          tokensEqual(connection.token, verifiedToken)
          && error instanceof Error
          && error.name === 'browser_capability_invalid'
        ) {
          await this.disposeConnection(connection);
        }
      }
    }));
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.capabilitySweepTimer) clearTimeout(this.capabilitySweepTimer);
    this.capabilitySweepTimer = null;
    // Pending resource/Context acquisition is itself an admitted Host request. Fence
    // and cancel every connection already known to the Host before waiting for
    // the request drain, otherwise shutdown would wait on a lease waiter that
    // only connection retirement can release.
    for (const connection of new Set([
      ...this.connections.values(),
      ...this.pendingConnections,
    ])) {
      this.beginRetiringConnection(connection);
    }
    if (this.activeHostRequests > 0) {
      await new Promise<void>(resolve => this.hostDrainWaiters.add(resolve));
    }
    // An initialize admitted just before the closing fence can finish
    // verification and register its connection during the drain.
    await Promise.allSettled([
      ...[...this.connections.values()].map(connection => this.retireConnection(connection)),
      ...[...this.pendingConnections].map(connection => this.retireConnection(connection)),
    ]);
    await this.dependencies.registry.shutdown();
  }
}
