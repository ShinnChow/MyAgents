import { describe, expect, it } from 'vitest';

import { sessionUserTagFailureStatus } from './session-user-tag-http';

describe('Session user Tag HTTP failure contract', () => {
  it.each([
    ['invalid-name', 400],
    ['session-not-found', 404],
    ['tag-not-found', 404],
    ['protected-session', 403],
    ['limit-reached', 409],
    ['merge-required', 409],
    ['conflict', 409],
    ['io-error', 500],
  ] as const)('maps %s to HTTP %s without losing the structured reason', (reason, status) => {
    expect(sessionUserTagFailureStatus(reason)).toBe(status);
  });
});
