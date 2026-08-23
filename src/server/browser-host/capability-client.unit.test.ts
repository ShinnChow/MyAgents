import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/management-api-client', () => ({
  managementApi: vi.fn(),
}));

import { managementApi } from '../utils/management-api-client';
import { acquireBrowserCapability, verifyBrowserCapability } from './capability-client';

const managementApiMock = vi.mocked(managementApi);

describe('Browser Host capability client', () => {
  beforeEach(() => {
    vi.stubEnv('MYAGENTS_SIDECAR_ID', 'session-birth');
    managementApiMock.mockReset();
  });

  afterEach(() => vi.unstubAllEnvs());

  it('acquires a runtime-only loopback projection', async () => {
    managementApiMock.mockResolvedValue({
      ok: true,
      url: 'http://127.0.0.1:43112/mcp/playwright',
      token: 'a'.repeat(32),
      hostGeneration: 7,
    });

    await expect(acquireBrowserCapability()).resolves.toEqual({
      url: 'http://127.0.0.1:43112/mcp/playwright',
      token: 'a'.repeat(32),
      hostGeneration: 7,
    });
    expect(managementApiMock).toHaveBeenCalledWith(
      '/api/browser/capability/acquire',
      'POST',
      {
        sidecarId: 'session-birth',
      },
      { parentSignal: undefined },
    );
  });

  it('allows only the Global Sidecar to verify credentials', async () => {
    await expect(verifyBrowserCapability('a'.repeat(32))).rejects.toThrow(
      'Only the current Global Sidecar',
    );
    expect(managementApiMock).not.toHaveBeenCalled();
  });

  it('does not accept a non-loopback or malformed capability projection', async () => {
    managementApiMock.mockResolvedValue({
      ok: true,
      url: 'http://example.com/mcp',
      token: 'secret',
      hostGeneration: 7,
    });
    await expect(acquireBrowserCapability()).rejects.toThrow(
      'malformed',
    );
  });
});
