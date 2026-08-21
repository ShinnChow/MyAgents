import { randomUUID } from 'node:crypto';

import { managementApi } from '../utils/management-api-client';

export interface BrowserProfileLease {
  requestId: string;
  leaseEpoch: number;
  token: string;
}

type BrowserProfileWaitState = 'queued' | 'granted' | 'cancelled';

function globalSidecarId(): string {
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (sidecarId !== '__global__') throw new Error('Browser Profile lease requires Global Sidecar');
  return sidecarId;
}

function wait(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function reportBrowserProfileWait(
  sidecarId: string,
  token: string,
  requestId: string,
  state: BrowserProfileWaitState,
  queuePosition?: number | null,
): Promise<void> {
  await Promise.resolve(
    managementApi(
      '/api/browser/profile/status',
      'POST',
      {
        sidecarId,
        token,
        requestId,
        state,
        ...(queuePosition == null ? {} : { queuePosition }),
      },
      { timeoutMs: 2_000 },
    ),
  ).catch(() => {});
}

async function cancelBrowserProfileWait(
  sidecarId: string,
  token: string,
  requestId: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await managementApi(
        '/api/browser/profile/cancel',
        'POST',
        { sidecarId, token, requestId },
        { timeoutMs: 2_000 },
      );
      // cancelled=false is an idempotent success when an earlier request was
      // admitted/cancelled but only its response was lost.
      if (result.ok === true) return true;
    } catch {
      // Reconcile the same request id; never enqueue a second waiter.
    }
    if (attempt < 2) await wait(100);
  }
  return false;
}

async function reconcileBrowserProfileWaitCancellation(
  sidecarId: string,
  token: string,
  requestId: string,
): Promise<void> {
  while (!await cancelBrowserProfileWait(sidecarId, token, requestId)) {
    await wait(1_000);
  }
}

async function reconcileBrowserProfileRelease(lease: BrowserProfileLease): Promise<void> {
  while (!await attemptBrowserProfileRelease(lease)) {
    await wait(1_000);
  }
}

async function settleUnreturnedProfileLease(
  sidecarId: string,
  token: string,
  requestId: string,
): Promise<void> {
  if (await cancelBrowserProfileWait(sidecarId, token, requestId)) return;
  // The current Global Host can settle this exact request even after its
  // source Session retires. Continue outside the foreground error path so a
  // lost acquire response can never leave a holder without a Context owner.
  void reconcileBrowserProfileWaitCancellation(sidecarId, token, requestId);
}

export async function acquireBrowserProfileLease(
  token: string,
  signal?: AbortSignal,
): Promise<BrowserProfileLease> {
  const sidecarId = globalSidecarId();
  const requestId = `profile-${randomUUID()}`;
  const startedAt = Date.now();
  let lastQueuePosition: number | null | undefined;
  let waitVisible = false;
  while (!signal?.aborted) {
    let result: Record<string, unknown>;
    try {
      result = await managementApi(
        '/api/browser/profile/acquire',
        'POST',
        { sidecarId, token, requestId },
        { timeoutMs: 2_000, parentSignal: signal },
      );
    } catch {
      if (!await wait(100, signal)) break;
      // The request id is idempotent in Rust: retrying recovers the exact
      // admitted epoch when only the response was lost.
      continue;
    }
    if (signal?.aborted) break;
    if (result.ok !== true) {
      if (result.code === 'transport_outcome_unknown') {
        if (!await wait(100, signal)) break;
        // Rust keys acquire by requestId, so this recovers either the queued
        // request or the already-admitted lease without creating a duplicate.
        continue;
      }
      await settleUnreturnedProfileLease(sidecarId, token, requestId);
      if (waitVisible) {
        await reportBrowserProfileWait(sidecarId, token, requestId, 'cancelled');
      }
      throw new Error('BROWSER_PROFILE_LEASE_UNAVAILABLE');
    }
    if (result.admitted === true) {
      if (typeof result.leaseEpoch !== 'number' || result.leaseEpoch <= 0) {
        await settleUnreturnedProfileLease(sidecarId, token, requestId);
        if (waitVisible) {
          await reportBrowserProfileWait(sidecarId, token, requestId, 'cancelled');
        }
        throw new Error('BROWSER_PROFILE_LEASE_MALFORMED');
      }
      await reportBrowserProfileWait(sidecarId, token, requestId, 'granted');
      console.info(`[browser-host] profile=granted queuedMs=${Date.now() - startedAt}`);
      return { requestId, leaseEpoch: result.leaseEpoch, token };
    }
    if (result.admitted !== false) {
      await settleUnreturnedProfileLease(sidecarId, token, requestId);
      if (waitVisible) {
        await reportBrowserProfileWait(sidecarId, token, requestId, 'cancelled');
      }
      throw new Error('BROWSER_PROFILE_LEASE_MALFORMED');
    }
    const queuePosition = typeof result.queuePosition === 'number' ? result.queuePosition : null;
    if (queuePosition !== lastQueuePosition) {
      lastQueuePosition = queuePosition;
      await reportBrowserProfileWait(sidecarId, token, requestId, 'queued', queuePosition);
      waitVisible = true;
      console.info(`[browser-host] profile=queued queuePosition=${queuePosition ?? 'unknown'}`);
    }
    const delay = typeof result.retryAfterMs === 'number'
      ? Math.min(1_000, Math.max(50, result.retryAfterMs))
      : 100;
    if (!await wait(delay, signal)) break;
  }
  await settleUnreturnedProfileLease(sidecarId, token, requestId);
  await reportBrowserProfileWait(sidecarId, token, requestId, 'cancelled');
  throw new Error('BROWSER_WAIT_CANCELLED');
}

async function attemptBrowserProfileRelease(lease: BrowserProfileLease): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await managementApi(
        '/api/browser/profile/release',
        'POST',
        {
          sidecarId: globalSidecarId(),
          token: lease.token,
          requestId: lease.requestId,
          leaseEpoch: lease.leaseEpoch,
        },
        { timeoutMs: 2_000 },
      );
      // released=false is an idempotent success when an earlier response was
      // lost: this exact epoch is no longer the holder either way.
      return result.ok === true;
    } catch {
      if (attempt < 2) await wait(100);
    }
  }
  return false;
}

export async function releaseBrowserProfileLease(lease: BrowserProfileLease): Promise<boolean> {
  const released = await attemptBrowserProfileRelease(lease);
  if (released) return true;
  // The persistent Context has already closed, so it is safe to complete
  // cleanup asynchronously while keeping the Rust lease fenced from B.
  void reconcileBrowserProfileRelease(lease);
  return false;
}
