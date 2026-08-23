import { managementApi } from '../utils/management-api-client';

export interface BrowserCapabilityProjection {
  url: string;
  token: string;
  hostGeneration: number;
}

export interface VerifiedBrowserCapability {
  productSessionId: string;
  workspacePath: string;
  hostGeneration: number;
}

function managementError(result: Record<string, unknown>, fallback: string): Error {
  const error = typeof result.error === 'string' ? result.error : fallback;
  const code = typeof result.code === 'string' ? result.code : 'management_error';
  const wrapped = new Error(error);
  wrapped.name = code;
  return wrapped;
}

export async function acquireBrowserCapability(
  signal?: AbortSignal,
): Promise<BrowserCapabilityProjection> {
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (!sidecarId) throw new Error('Browser capability requires a Sidecar process identity');
  const result = await managementApi(
    '/api/browser/capability/acquire',
    'POST',
    { sidecarId },
    { parentSignal: signal },
  );
  if (result.ok !== true) throw managementError(result, 'Browser Host is unavailable');
  if (
    typeof result.url !== 'string'
    || !result.url.startsWith('http://127.0.0.1:')
    || typeof result.token !== 'string'
    || !/^[a-f0-9]{32}$/.test(result.token)
    || typeof result.hostGeneration !== 'number'
    || result.hostGeneration <= 0
  ) {
    throw new Error('Browser capability response is malformed');
  }
  return {
    url: result.url,
    token: result.token,
    hostGeneration: result.hostGeneration,
  };
}

export async function adoptBrowserProductSession(
  productSessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (!sidecarId) throw new Error('Browser Session adoption requires a Sidecar process identity');
  const result = await managementApi(
    '/api/browser/session/adopt',
    'POST',
    { sidecarId, productSessionId },
    { parentSignal: signal },
  );
  if (result.ok !== true || result.adopted !== true) {
    throw managementError(result, 'Browser Product Session adoption was rejected');
  }
}

export async function verifyBrowserCapability(
  token: string,
  signal?: AbortSignal,
): Promise<VerifiedBrowserCapability> {
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (sidecarId !== '__global__') {
    throw new Error('Only the current Global Sidecar may verify Browser capabilities');
  }
  const result = await managementApi(
    '/api/browser/capability/verify',
    'POST',
    { sidecarId, token },
    { parentSignal: signal },
  );
  if (result.ok !== true) throw managementError(result, 'Browser capability is invalid');
  if (
    typeof result.productSessionId !== 'string'
    || !result.productSessionId
    || typeof result.workspacePath !== 'string'
    || !result.workspacePath
    || typeof result.hostGeneration !== 'number'
    || result.hostGeneration <= 0
  ) {
    throw new Error('Verified Browser capability response is malformed');
  }
  return {
    productSessionId: result.productSessionId,
    workspacePath: result.workspacePath,
    hostGeneration: result.hostGeneration,
  };
}
