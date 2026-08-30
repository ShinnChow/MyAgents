import { beforeEach, describe, expect, it } from 'vitest';

import { _clearHashCacheForTesting, hashPrivateIdentity } from './hash';

describe('analytics private identity hashing', () => {
  beforeEach(() => {
    _clearHashCacheForTesting();
  });

  it('is stable locally and separates Record from speech job identities', async () => {
    const recordHash = await hashPrivateIdentity('record', 'shared-id');
    const repeated = await hashPrivateIdentity('record', 'shared-id');
    const jobHash = await hashPrivateIdentity('speech-job', 'shared-id');

    expect(recordHash).toMatch(/^[0-9a-f]{32}$/);
    expect(repeated).toBe(recordHash);
    expect(jobHash).toMatch(/^[0-9a-f]{32}$/);
    expect(jobHash).not.toBe(recordHash);
    expect(recordHash).not.toContain('shared-id');
  });
});
