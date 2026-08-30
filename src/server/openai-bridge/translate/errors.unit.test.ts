import { describe, expect, it } from 'vitest';

import { classifyOpenAiUpstreamFailure, translateError } from './errors';

describe('translateError — upstream retry semantics', () => {
  it('keeps a generic allocated-quota 429 retryable', () => {
    const translated = translateError(429, JSON.stringify({
      error: {
        message: 'Allocated quota exceeded, please increase your quota limit.',
      },
    }));

    expect(translated.status).toBe(429);
    expect(translated.body.error.type).toBe('rate_limit_error');
    expect(translated.failure.kind).toBe('transient_rate_limit');
  });

  it.each([
    [{ code: 'insufficient_quota' }, 'structured_identifier'],
    [{ type: 'billing_not_active' }, 'structured_identifier'],
    [{ message: 'Payment required before making more requests.' }, 'explicit_billing_message'],
    [{ message: 'Insufficient Balance' }, 'explicit_billing_message'],
  ])('remaps a 429 only with permanent billing evidence: %j', (error, evidence) => {
    const translated = translateError(429, JSON.stringify({ error }));

    expect(translated.status).toBe(402);
    expect(translated.body.error.type).toBe('invalid_request_error');
    expect(translated.failure).toMatchObject({ kind: 'permanent_billing', evidence });
  });

  it('preserves structured fields before projecting the wire error', () => {
    const failure = classifyOpenAiUpstreamFailure(429, JSON.stringify({
      error: {
        code: 'insufficient_quota',
        type: 'billing_not_active',
        message: 'No quota remains.',
      },
    }));

    expect(failure).toMatchObject({
      status: 429,
      code: 'insufficient_quota',
      type: 'billing_not_active',
      message: 'No quota remains.',
      kind: 'permanent_billing',
    });
  });

  it('keeps a direct upstream 402 non-retryable', () => {
    const translated = translateError(402, JSON.stringify({
      error: { message: 'Provider-specific limit' },
    }));

    expect(translated.status).toBe(400);
    expect(translated.failure.kind).toBe('permanent_billing');
  });
});
