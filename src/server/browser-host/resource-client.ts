import { managementApi } from '../utils/management-api-client';

export interface BrowserResourceResolution {
  executablePath: string;
  revision: string;
}

const ACTIVE_STATES = new Set(['checking', 'downloading', 'verifying', 'installing', 'updating']);

function abortError(): Error {
  const error = new Error('Browser resource wait was cancelled');
  error.name = 'BROWSER_RESOURCE_WAIT_CANCELLED';
  return error;
}

async function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    timer.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Resolve the app-managed Chromium executable from Rust, the installation
 * authority. Tool calls wait only while the one shared install/update
 * transaction is active; an uninstalled or failed resource is terminal.
 */
export async function waitForBrowserResource(signal?: AbortSignal): Promise<BrowserResourceResolution> {
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
  if (sidecarId !== '__global__') {
    throw new Error('Browser resources are available only to the Global Sidecar');
  }

  while (true) {
    if (signal?.aborted) throw abortError();
    const result = await managementApi('/api/browser/resource/resolve', 'POST', { sidecarId }, { parentSignal: signal });
    if (
      result.ok === true &&
      typeof result.executablePath === 'string' &&
      result.executablePath.length > 0 &&
      typeof result.revision === 'string' &&
      result.revision.length > 0
    ) {
      return {
        executablePath: result.executablePath,
        revision: result.revision,
      };
    }

    const state = typeof result.state === 'string' ? result.state : '';
    if (!ACTIVE_STATES.has(state)) {
      const error = new Error(typeof result.error === 'string' ? result.error : 'Browser resources are not installed');
      error.name = typeof result.code === 'string' ? result.code.toUpperCase() : 'BROWSER_RESOURCE_NOT_READY';
      throw error;
    }
    await wait(typeof result.retryAfterMs === 'number' ? Math.max(100, Math.min(1_000, result.retryAfterMs)) : 250, signal);
  }
}
