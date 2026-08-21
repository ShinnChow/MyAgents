import { describe, expect, it, vi } from 'vitest';

import {
  mcpStartupExecutableIdentity,
  settleMcpStartupLease,
  startMcpStartupDemand,
} from './mcp-startup-admission-client';

describe('MCP startup admission client', () => {
  it('hashes a startup wave deterministically without sending command text as identity', () => {
    const first = mcpStartupExecutableIdentity([
      { command: '/bin/node', args: ['server-b.js'] },
      { command: '/bin/python', args: ['server-a.py'] },
    ]);
    const second = mcpStartupExecutableIdentity([
      { command: '/bin/python', args: ['server-a.py'] },
      { command: '/bin/node', args: ['server-b.js'] },
    ]);
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain('server');
  });

  it('retains one request identity while Rust queues then grants it', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const managementCall = vi.fn(async (_path, _method, body) => {
      calls.push(body ?? {});
      return calls.length === 1
        ? { ok: true, admitted: false, retryAfterMs: 1, queuePosition: 1 }
        : { ok: true, admitted: true, leaseEpoch: 7 };
    });
    const demand = startMcpStartupDemand({
      executables: [{ command: '/bin/node', args: ['mcp.js'] }],
      runtimeGeneration: 2,
      configGeneration: 3,
      priority: 'interactive',
      managementCall: managementCall as never,
      sidecarId: 'sidecar-a',
    });
    await expect(demand.ready).resolves.toMatchObject({ leaseEpoch: 7 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.requestId).toBe(calls[1]?.requestId);
  });

  it('recovers a granted startup lease after an acquire response is lost', async () => {
    vi.useFakeTimers();
    try {
      const calls: Array<Record<string, unknown>> = [];
      const managementCall = vi.fn(async (_path, _method, body) => {
        calls.push(body ?? {});
        if (calls.length === 1) return { ok: false, code: 'transport_outcome_unknown' };
        return { ok: true, admitted: true, leaseEpoch: 9 };
      });
      const demand = startMcpStartupDemand({
        executables: [{ command: '/bin/node', args: ['mcp.js'] }],
        runtimeGeneration: 2,
        configGeneration: 3,
        priority: 'interactive',
        managementCall: managementCall as never,
        sidecarId: 'sidecar-a',
      });

      await vi.advanceTimersByTimeAsync(100);
      await expect(demand.ready).resolves.toMatchObject({ leaseEpoch: 9 });
      expect(calls[0]?.requestId).toBe(calls[1]?.requestId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles the exact full lease identity', async () => {
    const managementCall = vi.fn(async () => ({ ok: true, settled: true }));
    await expect(settleMcpStartupLease({
      requestId: 'mcp-a',
      executableIdentity: 'a'.repeat(64),
      runtimeGeneration: 2,
      configGeneration: 3,
      leaseEpoch: 4,
    }, 'ready', {
      managementCall: managementCall as never,
      sidecarId: 'sidecar-a',
    })).resolves.toBe(true);
    expect(managementCall).toHaveBeenCalledWith(
      '/api/mcp/startup/settle',
      'POST',
      expect.objectContaining({ requestId: 'mcp-a', leaseEpoch: 4, outcome: 'ready' }),
      { timeoutMs: 2_000 },
    );
  });

  it('cancels a queued demand in Rust immediately with the exact identity', async () => {
    let resolveAcquire: ((value: Record<string, unknown>) => void) | undefined;
    const managementCall = vi.fn((
      path: string,
      _method?: string,
      _body?: Record<string, unknown>,
    ) => {
      if (path === '/api/mcp/startup/acquire') {
        return new Promise<Record<string, unknown>>(resolve => {
          resolveAcquire = resolve;
        });
      }
      return Promise.resolve({ ok: true, cancelled: true });
    });
    const demand = startMcpStartupDemand({
      executables: [{ command: '/bin/node', args: ['mcp.js'] }],
      runtimeGeneration: 2,
      configGeneration: 3,
      priority: 'interactive',
      managementCall: managementCall as never,
      sidecarId: 'sidecar-a',
    });

    demand.cancel();
    resolveAcquire?.({ ok: false });
    await expect(demand.ready).resolves.toBeNull();
    await vi.waitFor(() => expect(managementCall).toHaveBeenCalledWith(
      '/api/mcp/startup/cancel',
      'POST',
      expect.objectContaining({
        sidecarId: 'sidecar-a',
        requestId: demand.requestId,
        executableIdentity: demand.executableIdentity,
        runtimeGeneration: 2,
        configGeneration: 3,
      }),
      { timeoutMs: 2_000 },
    ));
  });

  it('retries an unknown cancel outcome with the exact demand identity', async () => {
    vi.useFakeTimers();
    try {
      const managementCall = vi.fn(async (
        path: string,
        _method?: string,
        _body?: Record<string, unknown>,
      ) => {
        if (path === '/api/mcp/startup/acquire') {
          return { ok: true, admitted: false, retryAfterMs: 1_000 };
        }
        return managementCall.mock.calls.filter(([calledPath]) => (
          calledPath === '/api/mcp/startup/cancel'
        )).length === 1
          ? { ok: false, code: 'transport_outcome_unknown' }
          : { ok: true, cancelled: false };
      });
      const demand = startMcpStartupDemand({
        executables: [{ command: '/bin/node', args: ['mcp.js'] }],
        runtimeGeneration: 2,
        configGeneration: 3,
        priority: 'interactive',
        managementCall: managementCall as never,
        sidecarId: 'sidecar-a',
      });

      demand.cancel();
      await vi.advanceTimersByTimeAsync(100);
      await expect(demand.ready).resolves.toBeNull();

      const cancelCalls = managementCall.mock.calls.filter(([path]) => (
        path === '/api/mcp/startup/cancel'
      ));
      expect(cancelCalls).toHaveLength(3);
      expect(cancelCalls[0]?.[2]).toEqual(cancelCalls[2]?.[2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels again after an in-flight acquire settles behind the first cancel', async () => {
    let resolveAcquire: ((value: Record<string, unknown>) => void) | undefined;
    const managementCall = vi.fn((
      path: string,
      _method?: string,
      _body?: Record<string, unknown>,
    ) => {
      if (path === '/api/mcp/startup/acquire') {
        return new Promise<Record<string, unknown>>(resolve => {
          resolveAcquire = resolve;
        });
      }
      return Promise.resolve({ ok: true, cancelled: false });
    });
    const demand = startMcpStartupDemand({
      executables: [{ command: '/bin/node', args: ['mcp.js'] }],
      runtimeGeneration: 2,
      configGeneration: 3,
      priority: 'interactive',
      managementCall: managementCall as never,
      sidecarId: 'sidecar-a',
    });

    demand.cancel();
    await vi.waitFor(() => expect(managementCall).toHaveBeenCalledWith(
      '/api/mcp/startup/cancel',
      'POST',
      expect.objectContaining({ requestId: demand.requestId }),
      { timeoutMs: 2_000 },
    ));
    resolveAcquire?.({ ok: true, admitted: true, leaseEpoch: 9 });
    await expect(demand.ready).resolves.toBeNull();
    await vi.waitFor(() => {
      const cancelCalls = managementCall.mock.calls.filter(([path]) => (
        path === '/api/mcp/startup/cancel'
      ));
      expect(cancelCalls).toHaveLength(2);
      expect(cancelCalls[0]?.[2]).toEqual(cancelCalls[1]?.[2]);
    });
  });
});
