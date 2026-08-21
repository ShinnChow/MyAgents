import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readBrowserIdentity: vi.fn(),
  mutateBrowserIdentity: vi.fn(),
}));

vi.mock('./identity-client', () => ({
  readBrowserIdentity: mocks.readBrowserIdentity,
  mutateBrowserIdentity: mocks.mutateBrowserIdentity,
}));

import { handleBrowserIdentitySettingsRequest } from './settings-api';

const snapshot = {
  revision: 3,
  recovery: 'corrupt-current' as const,
  state: {
    cookies: [{
      name: 'sid',
      value: 'secret-cookie-value',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      expires: -1,
      sameSite: 'Lax',
    }],
    origins: [{
      origin: 'https://example.com',
      localStorage: [{ name: 'token', value: 'secret-local-value' }],
    }],
  },
};

beforeEach(() => {
  mocks.readBrowserIdentity.mockReset().mockResolvedValue(snapshot);
  mocks.mutateBrowserIdentity.mockReset().mockResolvedValue({ ...snapshot, revision: 4 });
});

describe('Browser Identity Settings API', () => {
  it('returns only bounded metadata and never renderer-facing identity values', async () => {
    const response = await handleBrowserIdentitySettingsRequest(
      new Request('http://127.0.0.1/api/browser/identity'),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      revision: 3,
      exists: true,
      cookieCount: 1,
      domains: ['example.com'],
      cookies: [{
        name: 'sid',
        domain: '.example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        expires: -1,
        sameSite: 'Lax',
      }],
      origins: ['https://example.com'],
      recovery: 'corrupt-current',
    });
    expect(JSON.stringify(body)).not.toContain('secret-cookie-value');
    expect(JSON.stringify(body)).not.toContain('secret-local-value');
  });

  it('passes cookie replacement and origin deletion through the identity owner', async () => {
    const replaceCookie = {
      operation: 'replaceCookie',
      previousName: 'old',
      previousDomain: '.example.com',
      previousPath: '/',
      cookie: { name: 'new', value: 'value', domain: '.example.com', path: '/' },
    };
    const replaceResponse = await handleBrowserIdentitySettingsRequest(new Request(
      'http://127.0.0.1/api/browser/identity',
      { method: 'POST', body: JSON.stringify({ baseRevision: 3, ...replaceCookie }) },
    ));
    expect(replaceResponse.status).toBe(200);
    expect(mocks.mutateBrowserIdentity).toHaveBeenNthCalledWith(1, 3, replaceCookie, expect.any(AbortSignal));

    const deleteOrigin = { operation: 'deleteOrigin', origin: 'https://example.com' };
    const deleteResponse = await handleBrowserIdentitySettingsRequest(new Request(
      'http://127.0.0.1/api/browser/identity',
      { method: 'POST', body: JSON.stringify({ baseRevision: 4, ...deleteOrigin }) },
    ));
    expect(deleteResponse.status).toBe(200);
    expect(mocks.mutateBrowserIdentity).toHaveBeenNthCalledWith(2, 4, deleteOrigin, expect.any(AbortSignal));
  });

  it('rejects malformed and oversized bodies before mutation', async () => {
    const malformed = await handleBrowserIdentitySettingsRequest(new Request(
      'http://127.0.0.1/api/browser/identity',
      { method: 'POST', body: '{' },
    ));
    expect(malformed.status).toBe(400);

    const oversized = await handleBrowserIdentitySettingsRequest(new Request(
      'http://127.0.0.1/api/browser/identity',
      { method: 'POST', body: `{"operation":"deleteOrigin","origin":"${'x'.repeat(256 * 1024)}"}` },
    ));
    expect(oversized.status).toBe(413);
    expect(mocks.mutateBrowserIdentity).not.toHaveBeenCalled();
  });
});
