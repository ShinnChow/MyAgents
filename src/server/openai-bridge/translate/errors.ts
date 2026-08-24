// Error format translation: OpenAI → Anthropic

import type { AnthropicErrorResponse } from '../types/anthropic';

/** Map HTTP status code to Anthropic error type */
function statusToErrorType(status: number): string {
  switch (status) {
    case 400: return 'invalid_request_error';
    case 401: return 'authentication_error';
    case 403: return 'permission_error';
    case 404: return 'not_found_error';
    case 429: return 'rate_limit_error';
    // 529 is overloaded_error on the Anthropic wire (SDK 0.3.150+ classifies
    // it as 'overloaded', distinct from 429 'rate_limit'). Mapping it to the
    // generic api_error would hide the overload signal from the SDK's retry
    // classification.
    case 529: return 'overloaded_error';
    case 500:
    case 502:
    case 503:
      return 'api_error';
    default:
      return status >= 500 ? 'api_error' : 'invalid_request_error';
  }
}

export type OpenAiUpstreamFailureKind =
  | 'transient_rate_limit'
  | 'permanent_billing'
  | 'other';

export interface OpenAiUpstreamFailure {
  status: number;
  message: string;
  code?: string;
  type?: string;
  kind: OpenAiUpstreamFailureKind;
  evidence: 'structured_identifier' | 'explicit_billing_message' | 'http_status' | 'default';
}

function identifier(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const normalized = String(value).trim().toLowerCase();
    return normalized || undefined;
  }
  return undefined;
}

/** Extract the upstream status/code/type/message before Anthropic projection. */
function extractErrorFields(body: string, status: number): {
  message: string;
  code?: string;
  type?: string;
} {
  const fallback = `Upstream error (${status})`;

  try {
    const parsed = JSON.parse(body);
    const container = Array.isArray(parsed) ? parsed[0] : parsed;
    const error = container?.error && typeof container.error === 'object'
      ? container.error
      : container;
    const code = identifier(error?.code ?? container?.code);
    const type = identifier(error?.type ?? container?.type);

    // OpenAI format: { error: { message, type, code } }
    if (typeof error?.message === 'string' && error.message) {
      return { message: error.message, code, type };
    }

    // FastAPI / some providers: { detail: "..." } or { detail: [{ msg: "..." }] }
    if (container?.detail) {
      if (typeof container.detail === 'string') {
        return { message: container.detail, code, type };
      }
      if (Array.isArray(container.detail) && container.detail[0]?.msg) {
        return {
          message: container.detail.map((d: { msg: string }) => d.msg).join('; '),
          code,
          type,
        };
      }
    }

    // Simple format: { message: "..." }
    if (typeof container?.message === 'string') {
      return { message: container.message, code, type };
    }

    // Nested error object: { error: "string" }
    if (typeof container?.error === 'string') {
      return { message: container.error, code, type };
    }

    return { message: fallback, code, type };
  } catch {
    // Not JSON — use raw body (truncated)
    if (body) return { message: body.slice(0, 500) };
    return { message: fallback };
  }
}

const PERMANENT_BILLING_IDENTIFIERS = new Set([
  'insufficient_quota',
  'quota_exhausted',
  'quota_exceeded',
  'billing_not_active',
  'billing_hard_limit',
  'billing_hard_limit_reached',
  'payment_required',
]);

function isExplicitBillingMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('payment required')
    || lower.includes('billing not active')
    || lower.includes('billing_not_active')
    || lower.includes('billing hard limit')
    || lower.includes('billing_hard_limit')
    || lower.includes('insufficient balance')
    || lower.includes('account balance is insufficient')
    || lower.includes('余额不足')
    || lower.includes('账户欠费');
}

/**
 * Preserve the upstream error fact before wire projection. A 429 is transient
 * unless the provider supplies strong structured or explicit billing evidence;
 * generic quota wording can describe a short concurrency/window limit.
 */
export function classifyOpenAiUpstreamFailure(status: number, body: string): OpenAiUpstreamFailure {
  const fields = extractErrorFields(body, status);

  if (status === 402) {
    return { status, ...fields, kind: 'permanent_billing', evidence: 'http_status' };
  }

  if (status === 429) {
    if (
      (fields.code && PERMANENT_BILLING_IDENTIFIERS.has(fields.code))
      || (fields.type && PERMANENT_BILLING_IDENTIFIERS.has(fields.type))
    ) {
      return { status, ...fields, kind: 'permanent_billing', evidence: 'structured_identifier' };
    }
    if (isExplicitBillingMessage(fields.message)) {
      return { status, ...fields, kind: 'permanent_billing', evidence: 'explicit_billing_message' };
    }
    return { status, ...fields, kind: 'transient_rate_limit', evidence: 'default' };
  }

  return { status, ...fields, kind: 'other', evidence: 'http_status' };
}

/** Translate an upstream error to Anthropic error format */
export function translateError(status: number, body: string): {
  status: number;
  body: AnthropicErrorResponse;
  failure: OpenAiUpstreamFailure;
} {
  const failure = classifyOpenAiUpstreamFailure(status, body);

  // Only strong billing evidence may suppress the SDK's same-request retry.
  if (status === 429 && failure.kind === 'permanent_billing') {
    return {
      status: 402,
      body: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: failure.message,
        },
      },
      failure,
    };
  }

  // Map OpenAI status codes to Anthropic equivalents
  const anthropicStatus = status === 402 ? 400 : status;

  return {
    status: anthropicStatus,
    body: {
      type: 'error',
      error: {
        type: statusToErrorType(status),
        message: failure.message,
      },
    },
    failure,
  };
}
