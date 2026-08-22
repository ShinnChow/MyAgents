import { describe, expect, it } from 'vitest';

import {
  MANAGED_BROWSER_MCP_ID,
  STANDARD_PLAYWRIGHT_MCP_ID,
  applyBuiltinBrowserExecutionToolToggle,
  isBrowserResourceReady,
  isReservedBuiltinBrowserMcpId,
  selectLatestBrowserResourceStatus,
  shouldAutoMaintainBrowserResource,
  splitStandardPlaywrightProfileArgs,
  standardPlaywrightProfileArgs,
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
  it('maps absent and explicit-empty Playwright argv onto the two profile modes without rewriting compatibility state', () => {
    expect(splitStandardPlaywrightProfileArgs(undefined)).toEqual({
      mode: 'isolated',
      userDataDir: '',
      remainingArgs: [],
    });
    expect(splitStandardPlaywrightProfileArgs([])).toEqual({
      mode: 'persistent',
      userDataDir: '',
      remainingArgs: [],
    });
    expect(standardPlaywrightProfileArgs('isolated', '')).toEqual(['--isolated']);
    expect(standardPlaywrightProfileArgs('persistent', '')).toEqual([]);
  });

  it('separates only owned profile flags and preserves explicit upstream arguments', () => {
    expect(splitStandardPlaywrightProfileArgs([
      '--user-data-dir=/tmp/profile',
      '--storage-state=/tmp/state.json',
      '--custom-flag',
    ])).toEqual({
      mode: 'persistent',
      userDataDir: '/tmp/profile',
      remainingArgs: ['--storage-state=/tmp/state.json', '--custom-flag'],
    });
    expect(standardPlaywrightProfileArgs('persistent', '/tmp/profile')).toEqual([
      '--user-data-dir=/tmp/profile',
    ]);
  });

  it('reserves only the two exact product-owned catalogue identities', () => {
    expect(isReservedBuiltinBrowserMcpId(STANDARD_PLAYWRIGHT_MCP_ID)).toBe(true);
    expect(isReservedBuiltinBrowserMcpId(MANAGED_BROWSER_MCP_ID)).toBe(true);
    expect(isReservedBuiltinBrowserMcpId('playwright-custom')).toBe(false);
    expect(isReservedBuiltinBrowserMcpId('MyAgents-Browser')).toBe(false);
  });

  it('atomically replaces the peer when either built-in entry is enabled', () => {
    expect(applyBuiltinBrowserExecutionToolToggle([STANDARD_PLAYWRIGHT_MCP_ID, 'custom-browser'], MANAGED_BROWSER_MCP_ID, true, true)).toEqual([
      'custom-browser',
      MANAGED_BROWSER_MCP_ID,
    ]);

    expect(applyBuiltinBrowserExecutionToolToggle([MANAGED_BROWSER_MCP_ID, 'custom-browser'], STANDARD_PLAYWRIGHT_MCP_ID, true, true)).toEqual([
      'custom-browser',
      STANDARD_PLAYWRIGHT_MCP_ID,
    ]);
  });

  it('disabling one entry never enables or disables its peer', () => {
    expect(
      applyBuiltinBrowserExecutionToolToggle([STANDARD_PLAYWRIGHT_MCP_ID, MANAGED_BROWSER_MCP_ID, 'custom-browser'], STANDARD_PLAYWRIGHT_MCP_ID, false, false),
    ).toEqual([MANAGED_BROWSER_MCP_ID, 'custom-browser']);
  });

  it('does not apply name-based mutual exclusion to custom servers', () => {
    expect(applyBuiltinBrowserExecutionToolToggle(['playwright-custom'], 'another-browser', true, false)).toEqual(['playwright-custom', 'another-browser']);
  });

  it('keeps both desired selections unchanged when managed Browser is not ready', () => {
    expect(applyBuiltinBrowserExecutionToolToggle([STANDARD_PLAYWRIGHT_MCP_ID, 'custom-browser'], MANAGED_BROWSER_MCP_ID, true, false)).toEqual([
      STANDARD_PLAYWRIGHT_MCP_ID,
      'custom-browser',
    ]);
    expect(applyBuiltinBrowserExecutionToolToggle([MANAGED_BROWSER_MCP_ID, 'custom-browser'], MANAGED_BROWSER_MCP_ID, true, false)).toEqual([
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
