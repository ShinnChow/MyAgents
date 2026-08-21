import { managementApi } from '../utils/management-api-client';

export interface BrowserIdentityState {
  cookies: Array<Record<string, unknown>>;
  origins: Array<Record<string, unknown>>;
}

export interface BrowserIdentitySnapshot {
  revision: number;
  state: BrowserIdentityState;
  recovery?: 'corrupt-current' | 'corrupt-legacy';
}

export interface BrowserIdentityCheckpointResult extends BrowserIdentitySnapshot {
  conflictCount: number;
}

export type BrowserIdentityMutation =
  | { operation: 'upsertCookie'; cookie: Record<string, unknown> }
  | {
    operation: 'replaceCookie';
    previousName: string;
    previousDomain: string;
    previousPath: string;
    cookie: Record<string, unknown>;
  }
  | { operation: 'deleteCookie'; name: string; domain: string; path: string }
  | { operation: 'deleteOrigin'; origin: string };

function parseState(value: unknown): BrowserIdentityState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Browser Identity Store returned malformed state');
  }
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.cookies) || !Array.isArray(raw.origins)) {
    throw new Error('Browser Identity Store returned malformed state');
  }
  return {
    cookies: raw.cookies as Array<Record<string, unknown>>,
    origins: raw.origins as Array<Record<string, unknown>>,
  };
}

function assertGlobalSidecar(): string {
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (sidecarId !== '__global__') {
    throw new Error('Browser Identity Store is available only to the Global Sidecar');
  }
  return sidecarId;
}

function readError(result: Record<string, unknown>, fallback: string): Error {
  return new Error(typeof result.error === 'string' ? result.error : fallback);
}

export async function readBrowserIdentity(signal?: AbortSignal): Promise<BrowserIdentitySnapshot> {
  const sidecarId = assertGlobalSidecar();
  const result = await managementApi(
    '/api/browser/identity/read',
    'POST',
    { sidecarId },
    { parentSignal: signal },
  );
  if (result.ok !== true) throw readError(result, 'Browser Identity Store is unavailable');
  if (typeof result.revision !== 'number' || result.revision < 0) {
    throw new Error('Browser Identity Store returned malformed revision');
  }
  return {
    revision: result.revision,
    state: parseState(result.state),
    ...(result.recovery === 'corrupt-current' || result.recovery === 'corrupt-legacy'
      ? { recovery: result.recovery }
      : {}),
  };
}

export async function checkpointBrowserIdentity(
  productSessionId: string,
  base: BrowserIdentitySnapshot,
  observedBaseState: BrowserIdentityState,
  state: BrowserIdentityState,
  signal?: AbortSignal,
): Promise<BrowserIdentityCheckpointResult> {
  const sidecarId = assertGlobalSidecar();
  const result = await managementApi(
    '/api/browser/identity/checkpoint',
    'POST',
    {
      sidecarId,
      productSessionId,
      baseRevision: base.revision,
      baseState: base.state,
      observedBaseState,
      state,
    },
    { timeoutMs: 30_000, parentSignal: signal },
  );
  if (result.ok !== true) throw readError(result, 'Browser identity checkpoint failed');
  if (
    typeof result.revision !== 'number'
    || result.revision < 0
    || typeof result.conflictCount !== 'number'
    || result.conflictCount < 0
  ) {
    throw new Error('Browser Identity Store returned malformed checkpoint result');
  }
  return {
    revision: result.revision,
    conflictCount: result.conflictCount,
    state: parseState(result.state),
  };
}

export async function mutateBrowserIdentity(
  baseRevision: number,
  mutation: BrowserIdentityMutation,
  signal?: AbortSignal,
): Promise<BrowserIdentitySnapshot> {
  const sidecarId = assertGlobalSidecar();
  const result = await managementApi(
    '/api/browser/identity/mutate',
    'POST',
    { sidecarId, baseRevision, ...mutation },
    { parentSignal: signal },
  );
  if (result.ok !== true) throw readError(result, 'Browser identity mutation failed');
  if (typeof result.revision !== 'number' || result.revision < 0) {
    throw new Error('Browser Identity Store returned malformed mutation result');
  }
  return {
    revision: result.revision,
    state: parseState(result.state),
    ...(result.recovery === 'corrupt-current' || result.recovery === 'corrupt-legacy'
      ? { recovery: result.recovery }
      : {}),
  };
}
