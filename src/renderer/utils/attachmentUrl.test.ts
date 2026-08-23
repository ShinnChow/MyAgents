import { afterEach, describe, expect, it, vi } from 'vitest';

const tauriMock = vi.hoisted(() => ({ enabled: false }));

vi.mock('@/api/tauriClient', () => ({
  isTauri: () => tauriMock.enabled,
}));

import { resolveAttachmentUrl } from './attachmentUrl';

const originalNavigator = globalThis.navigator;

function setNavigatorPlatform(platform: string, userAgent = platform): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform, userAgent },
    configurable: true,
  });
}

function setTauriEnvironment(enabled: boolean): void {
  tauriMock.enabled = enabled;
}

describe('resolveAttachmentUrl', () => {
  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
    });
    setTauriEnvironment(false);
  });

  it('uses a relative HTTP endpoint in browser dev mode', () => {
    setTauriEnvironment(false);
    expect(resolveAttachmentUrl({ savedPath: 'session-a/image one.png' }))
      .toBe('/api/attachment/session-a/image%20one.png');
  });

  it('uses the custom scheme form on non-Windows Tauri WebViews', () => {
    setTauriEnvironment(true);
    setNavigatorPlatform('MacIntel');
    expect(resolveAttachmentUrl({ savedPath: 'session-a/image one.png' }))
      .toBe('myagents-resource://attachment/session-a/image%20one.png');
  });

  it('uses Tauri localhost on Windows WebView2', () => {
    setTauriEnvironment(true);
    setNavigatorPlatform('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(resolveAttachmentUrl({ savedPath: 'session-a/image one.png' }))
      .toBe('http://myagents-resource.localhost/attachment/session-a/image%20one.png');
  });
});
