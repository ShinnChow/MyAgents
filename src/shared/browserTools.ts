export const STANDARD_PLAYWRIGHT_MCP_ID = 'playwright' as const;
export const MANAGED_BROWSER_MCP_ID = 'myagents-browser' as const;

export const DEFAULT_STANDARD_PLAYWRIGHT_ARGS = ['--isolated'] as const;

/** These product-owned catalogue identities cannot be shadowed by custom MCPs. */
export function isReservedBuiltinBrowserMcpId(serverId: string): boolean {
  return serverId === STANDARD_PLAYWRIGHT_MCP_ID || serverId === MANAGED_BROWSER_MCP_ID;
}

/**
 * The two MyAgents-owned browser entries intentionally expose overlapping
 * browser_* tools. Keep the product rule local to these exact preset IDs:
 * enabling one disables the other in the same config mutation; disabling an
 * entry never changes its peer. Custom MCPs are deliberately unaffected.
 */
export function applyBuiltinBrowserToolToggle(current: readonly string[], serverId: string, enabled: boolean, managedBrowserReady: boolean): string[] {
  const next = new Set(current);
  if (!enabled) {
    next.delete(serverId);
    return [...next];
  }

  if (serverId === MANAGED_BROWSER_MCP_ID && !managedBrowserReady) {
    return [...next];
  }

  next.add(serverId);
  if (serverId === STANDARD_PLAYWRIGHT_MCP_ID) {
    next.delete(MANAGED_BROWSER_MCP_ID);
  } else if (serverId === MANAGED_BROWSER_MCP_ID) {
    next.delete(STANDARD_PLAYWRIGHT_MCP_ID);
  }
  return [...next];
}

export type BrowserResourceState =
  | 'never_installed'
  | 'checking'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'ready'
  | 'updating'
  | 'install_failed'
  | 'update_failed'
  | 'unsupported';

export interface BrowserResourceStatus {
  platform?: string;
  requiredRevision: string;
  installedRevision?: string;
  installAuthorized: boolean;
  state: BrowserResourceState;
  operationId?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  progressPercent?: number;
  errorCode?: string;
  retryable: boolean;
  automaticRetryCount: number;
  statusRevision: number;
  updatedAt: string;
}

export function isBrowserResourceReady(status: BrowserResourceStatus | null | undefined): boolean {
  return status?.state === 'ready' && status.installAuthorized && status.installedRevision === status.requiredRevision;
}

export function selectLatestBrowserResourceStatus(current: BrowserResourceStatus | null | undefined, incoming: BrowserResourceStatus): BrowserResourceStatus {
  if (!current || incoming.statusRevision >= current.statusRevision) return incoming;
  return current;
}

export function shouldAutoMaintainBrowserResource(status: BrowserResourceStatus | null | undefined): boolean {
  if (!status?.installAuthorized) return false;
  return (
    !isBrowserResourceReady(status) &&
    status.state !== 'downloading' &&
    status.state !== 'verifying' &&
    status.state !== 'installing' &&
    status.state !== 'updating' &&
    status.state !== 'unsupported'
  );
}
