import { describe, expect, it } from 'vitest';

import { translateError } from './openai-bridge/translate/errors';
import {
  joinAnthropicMessagesUrl,
  classifyOpenAiProbeStatus,
  anthropicAuthHeaders,
  summarizeProbeOutcome,
  composeVerifyFailureDetail,
  verifyTimeoutMessage,
  parseProviderError,
} from './provider-probe';

describe('joinAnthropicMessagesUrl — replicate SDK client.mjs buildURL (no /v1 dedupe)', () => {
  it('appends /v1/messages to a bare base', () => {
    expect(joinAnthropicMessagesUrl('https://api.x.com')).toBe('https://api.x.com/v1/messages');
  });
  it('collapses the double slash when base ends with /', () => {
    expect(joinAnthropicMessagesUrl('https://api.x.com/')).toBe('https://api.x.com/v1/messages');
  });
  it('DOES duplicate /v1 when the base already ends in /v1 (matches SDK → surfaces the same 404)', () => {
    expect(joinAnthropicMessagesUrl('https://api.x.com/v1')).toBe('https://api.x.com/v1/v1/messages');
  });
  it('duplicates /v1 with a trailing slash too', () => {
    expect(joinAnthropicMessagesUrl('https://api.x.com/v1/')).toBe('https://api.x.com/v1/v1/messages');
  });
});

describe('classifyOpenAiProbeStatus — shape-independent definite failures only', () => {
  it('treats auth/permission/model/rate + 402 quota-remap as definite-fail', () => {
    for (const s of [401, 402, 403, 404, 429]) {
      expect(classifyOpenAiProbeStatus(s)).toBe('definite-fail');
    }
  });
  it('treats 400 as inconclusive (request-shape / direct-402→400 — must not false-reject a valid key)', () => {
    expect(classifyOpenAiProbeStatus(400)).toBe('inconclusive');
  });
  it('treats 502 as inconclusive (ambiguous connect-failure vs transient upstream gateway)', () => {
    expect(classifyOpenAiProbeStatus(502)).toBe('inconclusive');
  });
  it('treats 2xx and other transient/hang statuses as inconclusive (fall through to SDK)', () => {
    for (const s of [200, 201, 408, 500, 503, 504]) {
      expect(classifyOpenAiProbeStatus(s)).toBe('inconclusive');
    }
  });
});

describe('anthropicAuthHeaders — mirror agent-session auth mapping', () => {
  it('api_key → x-api-key only', () => {
    const h = anthropicAuthHeaders('api_key', 'sk-1');
    expect(h['x-api-key']).toBe('sk-1');
    expect(h['authorization']).toBeUndefined();
  });
  it('auth_token_clear_api_key → Bearer only', () => {
    const h = anthropicAuthHeaders('auth_token_clear_api_key', 'sk-2');
    expect(h['authorization']).toBe('Bearer sk-2');
    expect(h['x-api-key']).toBeUndefined();
  });
  it('both / default → both headers', () => {
    for (const t of ['both', undefined, 'auth_token'] as const) {
      const h = anthropicAuthHeaders(t, 'sk-3');
      expect(h['x-api-key']).toBe('sk-3');
      expect(h['authorization']).toBe('Bearer sk-3');
    }
  });
  it('always carries content-type + anthropic-version', () => {
    const h = anthropicAuthHeaders('both', 'k');
    expect(h['content-type']).toBe('application/json');
    expect(h['anthropic-version']).toBeTruthy();
  });
});

describe('summarizeProbeOutcome', () => {
  it('undefined → undefined', () => {
    expect(summarizeProbeOutcome(undefined)).toBeUndefined();
  });
  it('timedOut → timeout phrasing', () => {
    expect(summarizeProbeOutcome({ timedOut: true })).toContain('探测超时');
  });
  it('connectError → connect phrasing', () => {
    expect(summarizeProbeOutcome({ connectError: 'ECONNREFUSED' })).toContain('ECONNREFUSED');
  });
  it('status + body → HTTP + body', () => {
    const s = summarizeProbeOutcome({ status: 401, body: 'invalid api key' });
    expect(s).toContain('HTTP 401');
    expect(s).toContain('invalid api key');
  });
});

describe('composeVerifyFailureDetail — always non-empty (P0)', () => {
  it('never returns empty (stderr line guarantees content) and omits model when unset', () => {
    const d = composeVerifyFailureDetail({});
    expect(d).not.toContain('model:');
    expect(d).toContain('stderr');
    expect(d.length).toBeGreaterThan(0);
  });
  it('falls back to "无 stderr 输出" when stderr is empty', () => {
    expect(composeVerifyFailureDetail({ stderr: [] })).toContain('无 stderr 输出');
  });
  it('carries baseUrl, model, protocol, elapsed, stderr', () => {
    const d = composeVerifyFailureDetail({
      baseUrl: 'https://api.x.com',
      model: 'gpt-x',
      apiProtocol: 'openai',
      elapsedMs: 1234,
      stderr: ['boom'],
    });
    expect(d).toContain('baseUrl: https://api.x.com');
    expect(d).toContain('model: gpt-x');
    expect(d).toContain('protocol: openai');
    expect(d).toContain('elapsed: 1234ms');
    expect(d).toContain('boom');
  });
  it('labels a scoped bridge error as authoritative and prefers it over the weak one', () => {
    const d = composeVerifyFailureDetail({ scopedBridgeError: 'tls fail', weakBridgeError: 'other' });
    expect(d).toContain('bridge: tls fail');
    expect(d).not.toContain('other');
  });
  it('labels a weak (unconfirmed) bridge error explicitly', () => {
    const d = composeVerifyFailureDetail({ weakBridgeError: 'maybe-mine' });
    expect(d).toContain('未确认归属');
    expect(d).toContain('maybe-mine');
  });
  it('appends the diagnostic line', () => {
    expect(composeVerifyFailureDetail({ diagnostic: 'HTTP 402 余额不足' })).toContain('诊断探测: HTTP 402 余额不足');
  });
});

describe('verifyTimeoutMessage — honest copy, no false "请检查网络连接"', () => {
  it('scoped bridge error → connect message', () => {
    expect(verifyTimeoutMessage({ reason: 'timeout', hasProviderContext: true, scopedBridgeError: 'closed' }))
      .toBe('无法连接到供应商：closed');
  });
  it('provider timeout → "supplier did not respond", NOT a network-check message', () => {
    const m = verifyTimeoutMessage({ reason: 'timeout', hasProviderContext: true, timeoutMs: 30000 });
    expect(m).toContain('未响应');
    expect(m).not.toContain('请检查网络连接');
  });
  it('subscription timeout (no provider context) keeps the network-oriented copy', () => {
    expect(verifyTimeoutMessage({ reason: 'timeout', hasProviderContext: false }))
      .toBe('验证超时，请检查网络连接');
  });
  it('provider no-result → unparseable-response copy', () => {
    expect(verifyTimeoutMessage({ reason: 'no_result', hasProviderContext: true })).toContain('无法解析');
  });
  it('subscription no-result → plain copy', () => {
    expect(verifyTimeoutMessage({ reason: 'no_result', hasProviderContext: false })).toBe('验证未返回结果');
  });
});

describe('parseProviderError — structured retryability + billing regression', () => {
  it('buckets strong 402 / billing / balance evidence to the billing message', () => {
    for (const t of [
      'HTTP 402 payment required',
      'Insufficient Balance',
      'insufficient_quota',
      'billing_not_active',
      '账户欠费',
      '余额不足',
    ]) {
      expect(parseProviderError(t.toLowerCase(), t).error).toBe('余额不足或账户欠费，请检查供应商账户');
    }
  });
  it('keeps raw text in detail', () => {
    expect(parseProviderError('insufficient balance', 'Insufficient Balance').detail).toBe('Insufficient Balance');
  });
  it('regression: 401 → key invalid, 403 → forbidden, 404 → model/url, 429 → rate limit', () => {
    expect(parseProviderError('401 unauthorized').error).toBe('API Key 无效或已过期');
    expect(parseProviderError('403 forbidden').error).toBe('访问被拒绝，请检查 API Key 权限');
    expect(parseProviderError('model not found').error).toBe('模型不存在或 API 地址错误');
    expect(parseProviderError('rate limit exceeded').error).toBe('请求频率限制，请稍后再试');
  });
  it('429 rate-limit still buckets to rate-limit (not billing) when no quota words present', () => {
    expect(parseProviderError('429 too many requests rate limit').error).toBe('请求频率限制，请稍后再试');
  });
  it('uses the projected 429 status instead of guessing from generic quota text', () => {
    const parsed = parseProviderError(
      'allocated quota exceeded, please increase your quota limit.',
      'Allocated quota exceeded, please increase your quota limit.',
      429,
    );
    expect(parsed).toMatchObject({
      error: '请求频率限制，请稍后再试',
      retryable: true,
    });
  });
  it('keeps a projected permanent 402 authoritative over an original 429 in the message', () => {
    const translated = translateError(429, JSON.stringify({
      error: {
        code: 'insufficient_quota',
        message: 'HTTP 429: insufficient_quota',
      },
    }));
    const wireBody = JSON.stringify(translated.body);
    const parsed = parseProviderError(wireBody.toLowerCase(), wireBody, translated.status);

    expect(translated.status).toBe(402);
    expect(parsed).toMatchObject({
      error: '余额不足或账户欠费，请检查供应商账户',
    });
    expect(parsed.retryable).toBeUndefined();
  });
  it('does not guess permanent billing from generic quota wording without a status', () => {
    expect(parseProviderError('allocated quota exceeded').error).toBe('allocated quota exceeded');
  });
});
