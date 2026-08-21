import {
  mutateBrowserIdentity,
  readBrowserIdentity,
  type BrowserIdentitySnapshot,
  type BrowserIdentityMutation,
} from './identity-client';

const MAX_SETTINGS_BODY_BYTES = 256 * 1024;

export function projectBrowserIdentitySettings(snapshot: BrowserIdentitySnapshot) {
  const cookies = snapshot.state.cookies.map(cookie => ({
    name: typeof cookie.name === 'string' ? cookie.name : '',
    domain: typeof cookie.domain === 'string' ? cookie.domain : '',
    path: typeof cookie.path === 'string' ? cookie.path : '/',
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    expires: typeof cookie.expires === 'number' ? cookie.expires : -1,
    sameSite: cookie.sameSite === 'Strict' || cookie.sameSite === 'None'
      ? cookie.sameSite
      : 'Lax',
  }));
  const domains = [...new Set(cookies
    .map(cookie => cookie.domain.replace(/^\./, ''))
    .filter(Boolean))].sort();
  const origins = [...new Set(snapshot.state.origins
    .map(origin => typeof origin.origin === 'string' ? origin.origin : '')
    .filter(Boolean))].sort();
  return {
    revision: snapshot.revision,
    exists: snapshot.revision > 0,
    cookieCount: cookies.length,
    domains,
    cookies,
    origins,
    recovery: snapshot.recovery ?? null,
  };
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error('invalid_request');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SETTINGS_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('request_too_large');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally {
    reader.releaseLock();
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function parseCookie(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cookie = value as Record<string, unknown>;
  if (
    typeof cookie.name !== 'string'
    || !cookie.name
    || typeof cookie.value !== 'string'
    || typeof cookie.domain !== 'string'
    || !cookie.domain
    || typeof cookie.path !== 'string'
    || !cookie.path
  ) return null;
  return cookie;
}

function parseMutation(value: unknown): BrowserIdentityMutation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.operation === 'upsertCookie') {
    const cookie = parseCookie(body.cookie);
    return cookie ? { operation: 'upsertCookie', cookie } : null;
  }
  if (
    body.operation === 'replaceCookie'
    && typeof body.previousName === 'string'
    && body.previousName
    && typeof body.previousDomain === 'string'
    && body.previousDomain
    && typeof body.previousPath === 'string'
    && body.previousPath
  ) {
    const cookie = parseCookie(body.cookie);
    return cookie ? {
      operation: 'replaceCookie',
      previousName: body.previousName,
      previousDomain: body.previousDomain,
      previousPath: body.previousPath,
      cookie,
    } : null;
  }
  if (
    body.operation === 'deleteCookie'
    && typeof body.name === 'string'
    && body.name
    && typeof body.domain === 'string'
    && body.domain
    && typeof body.path === 'string'
    && body.path
  ) {
    return {
      operation: 'deleteCookie',
      name: body.name,
      domain: body.domain,
      path: body.path,
    };
  }
  if (body.operation === 'deleteOrigin' && typeof body.origin === 'string' && body.origin) {
    return { operation: 'deleteOrigin', origin: body.origin };
  }
  return null;
}

/** Renderer-facing control plane; execution credentials never cross it. */
export async function handleBrowserIdentitySettingsRequest(request: Request): Promise<Response> {
  try {
    if (request.method === 'GET') {
      const snapshot = await readBrowserIdentity(request.signal);
      return jsonResponse({ ok: true, ...projectBrowserIdentitySettings(snapshot) });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ ok: false, code: 'method_not_allowed' }, 405);
    }
    const contentLength = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_SETTINGS_BODY_BYTES) {
      return jsonResponse({ ok: false, code: 'request_too_large' }, 413);
    }
    const body = await readBoundedJson(request);
    const baseRevision = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).baseRevision
      : undefined;
    const mutation = parseMutation(body);
    if (typeof baseRevision !== 'number' || !Number.isSafeInteger(baseRevision) || baseRevision < 0) {
      return jsonResponse({ ok: false, code: 'invalid_revision' }, 400);
    }
    if (!mutation) return jsonResponse({ ok: false, code: 'invalid_request' }, 400);
    const snapshot = await mutateBrowserIdentity(baseRevision, mutation, request.signal);
    return jsonResponse({ ok: true, ...projectBrowserIdentitySettings(snapshot) });
  } catch (error) {
    if (error instanceof Error && error.message === 'request_too_large') {
      return jsonResponse({ ok: false, code: 'request_too_large' }, 413);
    }
    if (error instanceof SyntaxError || (error instanceof Error && error.message === 'invalid_request')) {
      return jsonResponse({ ok: false, code: 'invalid_request' }, 400);
    }
    return jsonResponse({
      ok: false,
      code: 'browser_identity_unavailable',
      error: error instanceof Error ? error.message : 'Browser Identity Store is unavailable',
    }, 503);
  }
}
