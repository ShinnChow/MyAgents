import { createHash, randomUUID } from 'node:crypto';

import { managementApi } from '../utils/management-api-client';

export type McpStartupPriority = 'interactive' | 'background';

export interface McpStartupExecutable {
  command: string;
  args?: readonly string[];
}

export interface McpStartupLease {
  requestId: string;
  executableIdentity: string;
  runtimeGeneration: number;
  configGeneration: number;
  leaseEpoch: number;
}

type ManagementCall = typeof managementApi;

export interface McpStartupDemand {
  requestId: string;
  executableIdentity: string;
  ready: Promise<McpStartupLease | null>;
  cancel(): void;
}

export function mcpStartupExecutableIdentity(executables: readonly McpStartupExecutable[]): string {
  const normalized = executables
    .map(executable => ({ command: executable.command, args: [...(executable.args ?? [])] }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function cancelMcpStartupDemand(
  call: ManagementCall,
  body: Record<string, unknown>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await call(
        '/api/mcp/startup/cancel',
        'POST',
        body,
        { timeoutMs: 2_000 },
      );
      // cancelled=false is an idempotent success when an earlier cancel
      // reached Rust but only its response was lost.
      if (response.ok === true) return true;
    } catch {
      // Retry this exact request identity; never create a second demand.
    }
    if (attempt < 2) await delay(100);
  }
  return false;
}

/**
 * Begin one application-owned startup-wave demand. Acquire is idempotent by
 * requestId, so an unknown transport result is retried instead of failing open
 * and potentially starting a second wave outside Rust's capacity owner.
 */
export function startMcpStartupDemand(options: {
  executables: readonly McpStartupExecutable[];
  runtimeGeneration: number;
  configGeneration: number;
  priority: McpStartupPriority;
  managementCall?: ManagementCall;
  sidecarId?: string;
}): McpStartupDemand {
  const controller = new AbortController();
  const requestId = `mcp-${randomUUID()}`;
  const executableIdentity = mcpStartupExecutableIdentity(options.executables);
  const sidecarId = options.sidecarId ?? process.env.MYAGENTS_SIDECAR_ID?.trim();
  const call = options.managementCall ?? managementApi;
  const requestBody = {
    sidecarId,
    requestId,
    executableIdentity,
    runtimeGeneration: options.runtimeGeneration,
    configGeneration: options.configGeneration,
  };
  let completed = false;
  const ready = (async (): Promise<McpStartupLease | null> => {
    if (!sidecarId || options.executables.length === 0) return null;
    while (!controller.signal.aborted) {
      let response: Record<string, unknown>;
      try {
        response = await call(
          '/api/mcp/startup/acquire',
          'POST',
          { ...requestBody, priority: options.priority },
          { timeoutMs: 2_000, parentSignal: controller.signal },
        );
      } catch {
        if (!await sleep(100, controller.signal)) return null;
        continue;
      }
      if (controller.signal.aborted) {
        return null;
      }
      if (response.ok !== true) {
        if (response.code === 'transport_outcome_unknown') {
          if (!await sleep(100, controller.signal)) return null;
          continue;
        }
        return null;
      }
      if (response.admitted === true) {
        const leaseEpoch = response.leaseEpoch;
        if (typeof leaseEpoch !== 'number' || !Number.isSafeInteger(leaseEpoch) || leaseEpoch <= 0) {
          await cancelMcpStartupDemand(call, requestBody);
          return null;
        }
        completed = true;
        return {
          requestId,
          executableIdentity,
          runtimeGeneration: options.runtimeGeneration,
          configGeneration: options.configGeneration,
          leaseEpoch,
        };
      }
      if (response.admitted !== false) {
        await cancelMcpStartupDemand(call, requestBody);
        return null;
      }
      const retryAfterMs = typeof response.retryAfterMs === 'number' && Number.isFinite(response.retryAfterMs)
        ? Math.min(2_000, Math.max(50, Math.round(response.retryAfterMs)))
        : 100;
      if (!await sleep(retryAfterMs, controller.signal)) return null;
    }
    return null;
  })();
  return {
    requestId,
    executableIdentity,
    ready,
    cancel: () => {
      if (controller.signal.aborted || completed) return;
      controller.abort();
      if (!sidecarId || options.executables.length === 0) return;
      // Cancel immediately for the common queued case, then repeat after the
      // in-flight acquire settles so cancel-before-acquire reordering cannot
      // leave a late waiter or lease behind.
      const firstCancellation = cancelMcpStartupDemand(call, requestBody);
      void ready.finally(async () => {
        await firstCancellation;
        await cancelMcpStartupDemand(call, requestBody);
      });
    },
  };
}

export async function settleMcpStartupLease(
  lease: McpStartupLease,
  outcome: 'ready' | 'failed' | 'released' | 'spawn_denied',
  options: {
    errorCode?: 'EPERM' | 'EACCES' | 'ENOEXEC';
    managementCall?: ManagementCall;
    sidecarId?: string;
  } = {},
): Promise<boolean> {
  const sidecarId = options.sidecarId ?? process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (!sidecarId) return false;
  const response = await (options.managementCall ?? managementApi)(
    '/api/mcp/startup/settle',
    'POST',
    {
      sidecarId,
      requestId: lease.requestId,
      executableIdentity: lease.executableIdentity,
      runtimeGeneration: lease.runtimeGeneration,
      configGeneration: lease.configGeneration,
      leaseEpoch: lease.leaseEpoch,
      outcome,
      ...(options.errorCode ? { errorCode: options.errorCode } : {}),
    },
    { timeoutMs: 2_000 },
  );
  return response.ok === true && response.settled === true;
}
