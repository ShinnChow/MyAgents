import { track } from '@/analytics';

export type SpaceMetricName =
  | 'space_boot_start'
  | 'space_boot_end'
  | 'space_event_sync_start'
  | 'space_event_sync_end'
  | 'space_issue_detail_open'
  | 'space_issue_list_render_count'
  | 'space_tab_visible_revalidate_start'
  | 'space_tab_visible_revalidate_end'
  | 'space_delivery_wake'
  | 'space_mutation_latency';

export interface SpaceMetricPayload {
  operation?: string;
  durationMs?: number;
  count?: number;
  ok?: boolean;
  error?: string;
}

type SpaceAnalyticsRole = 'owner' | 'admin' | 'member' | 'unknown';
type SpaceAnalyticsKind = 'official' | 'team' | 'personal' | 'unknown';
type SpaceAnalyticsSurface = 'home' | 'issue_list' | 'issue_detail' | 'goals' | 'skills' | 'tools' | 'agents' | 'members' | 'settings' | 'unknown';
type SpaceMutationEvent =
  | 'space_issue_mutation'
  | 'space_goal_mutation'
  | 'space_skill_mutation'
  | 'space_tool_mutation'
  | 'space_registered_agent_mutation'
  | 'space_member_mutation'
  | 'space_settings_mutation';

export type SpaceToolMetricKind = 'mcp' | 'custom_install_prompt';
export type SpaceToolMetricResult =
  | 'success'
  | 'new'
  | 'identical'
  | 'replace'
  | 'conflict'
  | 'cancel'
  | 'failure';

interface SpaceMutationMetricOptions {
  toolKind?: SpaceToolMetricKind;
  toolResult?: SpaceToolMetricResult | (() => SpaceToolMetricResult);
}

interface SpaceAnalyticsContext {
  space_kind: SpaceAnalyticsKind;
  is_official: boolean;
  space_role: SpaceAnalyticsRole;
}

let analyticsContext: SpaceAnalyticsContext = {
  space_kind: 'unknown',
  is_official: false,
  space_role: 'unknown',
};

function normalizeSpaceKind(value?: string | null): SpaceAnalyticsKind {
  if (value === 'official') return 'official';
  if (value === 'team') return 'team';
  if (value === 'user' || value === 'personal') return 'personal';
  return 'unknown';
}

function normalizeRole(value?: string | null): SpaceAnalyticsRole {
  if (value === 'owner' || value === 'admin' || value === 'member') return value;
  return 'unknown';
}

export function setSpaceAnalyticsContext(input: { spaceKind?: string | null; role?: string | null } | null): void {
  if (!input) {
    analyticsContext = { space_kind: 'unknown', is_official: false, space_role: 'unknown' };
    return;
  }
  const spaceKind = normalizeSpaceKind(input.spaceKind);
  analyticsContext = {
    space_kind: spaceKind,
    is_official: spaceKind === 'official',
    space_role: normalizeRole(input.role),
  };
}

function baseParams(surface: SpaceAnalyticsSurface = 'unknown') {
  return {
    ...analyticsContext,
    space_surface: surface,
  };
}

export function trackSpaceOpen(surface: SpaceAnalyticsSurface = 'home'): void {
  track('space_open', baseParams(surface));
}

export function trackSpaceToolListLoad(input: {
  ok: boolean;
  durationMs: number;
  count?: number;
  error?: unknown;
}): void {
  track('space_open', {
    ...baseParams('tools'),
    operation: 'list_load',
    ok: input.ok,
    duration_ms: input.durationMs,
    ...(input.count === undefined ? {} : { count: input.count }),
    ...(input.ok ? {} : { error_code: normalizeSpaceErrorCode(input.error) }),
  });
}

export function trackSpaceSwitch(): void {
  track('space_switch', baseParams('home'));
}

export function trackSpaceAuth(operation: 'start' | 'success' | 'failure', ok: boolean, error?: unknown): void {
  const params = {
    ...baseParams('home'),
    operation,
    ok,
    ...(ok ? {} : { error_code: normalizeSpaceErrorCode(error) }),
  };
  if (operation === 'start') track('space_auth_start', params);
  else track('space_auth_complete', params);
}

export function normalizeSpaceErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('login')) return 'unauthorized';
  if (lower.includes('403') || lower.includes('forbidden') || lower.includes('permission')) return 'forbidden';
  if (lower.includes('404') || lower.includes('not found')) return 'not_found';
  if (lower.includes('429') || lower.includes('rate')) return 'rate_limited';
  if (lower.includes('400') || lower.includes('validation') || lower.includes('invalid')) return 'validation_error';
  if (lower.includes('network') || lower.includes('fetch') || lower.includes('load failed')) return 'network_error';
  if (lower.includes('500') || lower.includes('server')) return 'server_error';
  return 'unknown';
}

function mutationEvent(operation: string): SpaceMutationEvent {
  if (operation.startsWith('issue.')) return 'space_issue_mutation';
  if (operation.startsWith('goal.')) return 'space_goal_mutation';
  if (operation.startsWith('skill.')) return 'space_skill_mutation';
  if (operation.startsWith('tool.')) return 'space_tool_mutation';
  if (operation.startsWith('agent.')) return 'space_registered_agent_mutation';
  if (operation.startsWith('member.')) return 'space_member_mutation';
  return 'space_settings_mutation';
}

export function normalizeSpaceMutationOperation(operation: string): string {
  const table: Record<string, string> = {
    'issue.create': 'create',
    'issue.update': 'update',
    'issue.attachments.upload': 'update',
    'issue.comment': 'comment',
    'issue.state': 'state_change',
    'issue.close_own': 'cancel',
    'issue.close': 'cancel',
    'issue.complete': 'complete',
    'issue.cancel_claim': 'cancel_claim',
    'goal.create': 'create',
    'goal.update': 'update',
    'goal.archive': 'archive',
    'skill.upload': 'upload',
    'skill.revision.upload': 'upload',
    'skill.revision.rollback': 'upload',
    'skill.delete': 'delete',
    'skill.install': 'install',
    'tool.publish': 'publish',
    'tool.update': 'update',
    'tool.rollback': 'rollback',
    'tool.delete': 'delete',
    'tool.install': 'install',
    'tool.helper_launch': 'helper_launch',
    'agent.register': 'register',
    'agent.update': 'update',
    'agent.revoke': 'revoke',
    'member.join': 'join',
    'member.approve': 'approve',
    'member.reject': 'reject',
    'member.remove': 'remove',
    'member.role': 'role_update',
    'profile.update': 'profile_update',
    'settings.create': 'create',
    'settings.update': 'settings_update',
  };
  return table[operation] ?? 'settings_update';
}

export function normalizeSpaceMutationSurface(operation: string): SpaceAnalyticsSurface {
  if (operation.startsWith('issue.')) return 'issue_detail';
  if (operation.startsWith('goal.')) return 'goals';
  if (operation.startsWith('skill.')) return 'skills';
  if (operation.startsWith('tool.')) return 'tools';
  if (operation.startsWith('agent.')) return 'agents';
  if (operation.startsWith('member.')) return 'members';
  return 'settings';
}

export function trackSpaceMutation(operation: string, input: {
  durationMs: number;
  ok: boolean;
  error?: unknown;
  toolKind?: SpaceToolMetricKind;
  result?: SpaceToolMetricResult;
}): void {
  const params = {
    ...baseParams(normalizeSpaceMutationSurface(operation)),
    operation: normalizeSpaceMutationOperation(operation),
    ok: input.ok,
    duration_ms: input.durationMs,
    ...(operation.startsWith('tool.') && input.toolKind ? { tool_kind: input.toolKind } : {}),
    ...(operation.startsWith('tool.') && input.result ? { result: input.result } : {}),
    ...(input.ok ? {} : { error_code: normalizeSpaceErrorCode(input.error) }),
  };
  const event = mutationEvent(operation);
  if (event === 'space_issue_mutation') track('space_issue_mutation', params);
  else if (event === 'space_goal_mutation') track('space_goal_mutation', params);
  else if (event === 'space_skill_mutation') track('space_skill_mutation', params);
  else if (event === 'space_tool_mutation') track('space_tool_mutation', params);
  else if (event === 'space_registered_agent_mutation') track('space_registered_agent_mutation', params);
  else if (event === 'space_member_mutation') track('space_member_mutation', params);
  else track('space_settings_mutation', params);
}

export function trackSpaceToolMutation(input: {
  operation: 'install' | 'helper_launch';
  toolKind: SpaceToolMetricKind;
  result: SpaceToolMetricResult;
  ok: boolean;
  durationMs?: number;
  error?: unknown;
}): void {
  trackSpaceMutation(`tool.${input.operation}`, {
    durationMs: input.durationMs ?? 0,
    ok: input.ok,
    error: input.error,
    toolKind: input.toolKind,
    result: input.result,
  });
}

export function nowForSpaceMetric(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function recordSpaceMetric(name: SpaceMetricName, payload: SpaceMetricPayload = {}): void {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    try {
      performance.mark(name, { detail: payload });
    } catch {
      performance.mark(name);
    }
  }
  const debugEnabled =
    import.meta.env.DEV
    && typeof window !== 'undefined'
    && window.localStorage?.getItem('myagents.space.metrics') === '1';
  if (debugEnabled) {
    console.debug('[Space metric]', name, payload);
  }
}

export async function withSpaceMutationMetric<T>(
  operation: string,
  task: () => Promise<T>,
  options: SpaceMutationMetricOptions = {},
): Promise<T> {
  const startedAt = nowForSpaceMetric();
  try {
    const result = await task();
    const durationMs = Math.round(nowForSpaceMetric() - startedAt);
    recordSpaceMetric('space_mutation_latency', {
      operation,
      durationMs,
      ok: true,
    });
    const resultLabel = typeof options.toolResult === 'function'
      ? options.toolResult()
      : options.toolResult;
    trackSpaceMutation(operation, {
      durationMs,
      ok: true,
      toolKind: options.toolKind,
      result: resultLabel,
    });
    return result;
  } catch (error) {
    const durationMs = Math.round(nowForSpaceMetric() - startedAt);
    recordSpaceMetric('space_mutation_latency', {
      operation,
      durationMs,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    trackSpaceMutation(operation, {
      durationMs,
      ok: false,
      error,
      toolKind: options.toolKind,
      result: 'failure',
    });
    throw error;
  }
}
