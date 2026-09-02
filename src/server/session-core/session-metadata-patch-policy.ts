const RECENCY_BUMP_FIELDS = new Set([
  'model',
  'reasoningEffort',
  'permissionMode',
  'mcpEnabledServers',
  'enabledPluginIds',
  'enabledOfficialToolIds',
  'providerId',
  'providerRoute',
  'providerExecutionIdentity',
  'providerEnvJson',
]);

/**
 * Session organization is not activity. Keep the PATCH route's recency policy
 * explicit and independently testable so adding another metadata field cannot
 * silently make old history jump to the top.
 */
export function shouldBumpSessionRecency(payload: object): boolean {
  return Object.entries(payload).some(([key, value]) => (
    value !== undefined && RECENCY_BUMP_FIELDS.has(key)
  ));
}
