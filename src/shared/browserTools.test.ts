import { describe, expect, it } from 'vitest';

import {
  MANAGED_BROWSER_MCP_ID,
  STANDARD_PLAYWRIGHT_MCP_ID,
  applyBuiltinBrowserToolToggle,
  isBrowserResourceReady,
  isReservedBuiltinBrowserMcpId,
  selectLatestBrowserResourceStatus,
  shouldAutoMaintainBrowserResource,
  type BrowserResourceStatus,
} from './browserTools';

const readyStatus: BrowserResourceStatus = {
  requiredRevision: 'chromium-1212',
  installedRevision: 'chromium-1212',
  installAuthorized: true,
  state: 'ready',
  retryable: false,
  automaticRetryCount: 0,
  statusRevision: 1,
  updatedAt: '2026-08-22T00:00:00.000Z',
};

describe('built-in browser tool policy', () => {
  it('reserves only the two exact product-owned catalogue identities', () => {
    expect(isReservedBuiltinBrowserMcpId(STANDARD_PLAYWRIGHT_MCP_ID)).toBe(true);
    expect(isReservedBuiltinBrowserMcpId(MANAGED_BROWSER_MCP_ID)).toBe(true);
    expect(isReservedBuiltinBrowserMcpId('playwright-custom')).toBe(false);
    expect(isReservedBuiltinBrowserMcpId('MyAgents-Browser')).toBe(false);
  });

  it('atomically replaces the peer when either built-in entry is enabled', () => {
    expect(applyBuiltinBrowserToolToggle([STANDARD_PLAYWRIGHT_MCP_ID, 'custom-browser'], MANAGED_BROWSER_MCP_ID, true, true)).toEqual([
      'custom-browser',
      MANAGED_BROWSER_MCP_ID,
    ]);

    expect(applyBuiltinBrowserToolToggle([MANAGED_BROWSER_MCP_ID, 'custom-browser'], STANDARD_PLAYWRIGHT_MCP_ID, true, true)).toEqual([
      'custom-browser',
      STANDARD_PLAYWRIGHT_MCP_ID,
    ]);
  });

  it('disabling one entry never enables or disables its peer', () => {
    expect(
      applyBuiltinBrowserToolToggle([STANDARD_PLAYWRIGHT_MCP_ID, MANAGED_BROWSER_MCP_ID, 'custom-browser'], STANDARD_PLAYWRIGHT_MCP_ID, false, false),
    ).toEqual([MANAGED_BROWSER_MCP_ID, 'custom-browser']);
  });

  it('does not apply name-based mutual exclusion to custom servers', () => {
    expect(applyBuiltinBrowserToolToggle(['playwright-custom'], 'another-browser', true, false)).toEqual(['playwright-custom', 'another-browser']);
  });

  it('keeps both desired selections unchanged when managed Browser is not ready', () => {
    expect(applyBuiltinBrowserToolToggle([STANDARD_PLAYWRIGHT_MCP_ID, 'custom-browser'], MANAGED_BROWSER_MCP_ID, true, false)).toEqual([
      STANDARD_PLAYWRIGHT_MCP_ID,
      'custom-browser',
    ]);
    expect(applyBuiltinBrowserToolToggle([MANAGED_BROWSER_MCP_ID, 'custom-browser'], MANAGED_BROWSER_MCP_ID, true, false)).toEqual([
      MANAGED_BROWSER_MCP_ID,
      'custom-browser',
    ]);
  });
});

describe('Browser resource policy', () => {
  it('requires exact installed and required revisions', () => {
    expect(isBrowserResourceReady(readyStatus)).toBe(true);
    expect(isBrowserResourceReady({ ...readyStatus, installedRevision: 'old' })).toBe(false);
  });

  it('auto-maintains only after a successful explicit installation', () => {
    expect(
      shouldAutoMaintainBrowserResource({
        ...readyStatus,
        state: 'update_failed',
        installedRevision: 'old',
        retryable: true,
      }),
    ).toBe(true);
    expect(
      shouldAutoMaintainBrowserResource({
        ...readyStatus,
        state: 'never_installed',
        installedRevision: undefined,
        installAuthorized: false,
      }),
    ).toBe(false);
  });

  it('does not let a stale command response overwrite a newer resource event', () => {
    const current = { ...readyStatus, statusRevision: 8 };
    const stale: BrowserResourceStatus = {
      ...readyStatus,
      installedRevision: undefined,
      state: 'installing',
      statusRevision: 7,
    };
    expect(selectLatestBrowserResourceStatus(current, stale)).toBe(current);
    expect(selectLatestBrowserResourceStatus(stale, current)).toBe(current);
  });
});
