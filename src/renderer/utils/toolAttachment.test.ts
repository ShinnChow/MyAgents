import { afterEach, describe, expect, it } from 'vitest';

import { resolveTauriToolAttachmentUrl } from './toolAttachment';

const originalNavigator = globalThis.navigator;

function setNavigatorPlatform(platform: string, userAgent = platform): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform, userAgent },
    configurable: true,
  });
}

describe('resolveTauriToolAttachmentUrl', () => {
  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
    });
  });

  it('maps sidecar tool attachment API paths to the desktop custom scheme', () => {
    setNavigatorPlatform('MacIntel');
    expect(
      resolveTauriToolAttachmentUrl('/api/attachment/tool/session-a/turn-b/image.png'),
    ).toBe('myagents-resource://tool-attachment/session-a/turn-b/image.png');
    expect(
      resolveTauriToolAttachmentUrl('/api/attachment/tool/session-a/turn-b/image.png', 'session-a'),
    ).toBe('myagents-resource://tool-attachment/session-a/turn-b/image.png');
  });

  it('maps sidecar tool attachment API paths to Tauri localhost on Windows', () => {
    setNavigatorPlatform('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(
      resolveTauriToolAttachmentUrl('/api/attachment/tool/session-a/turn-b/image.png', 'session-a'),
    ).toBe('http://myagents-resource.localhost/tool-attachment/session-a/turn-b/image.png');
  });

  it('preserves encoded path segments', () => {
    setNavigatorPlatform('MacIntel');
    expect(
      resolveTauriToolAttachmentUrl('/api/attachment/tool/session-a/turn-b/image%20one.png'),
    ).toBe('myagents-resource://tool-attachment/session-a/turn-b/image%20one.png');
  });

  it('does not rewrite unrelated attachment paths', () => {
    setNavigatorPlatform('MacIntel');
    expect(resolveTauriToolAttachmentUrl('/api/attachment/session/file.png')).toBeNull();
    expect(resolveTauriToolAttachmentUrl('/generated/tool-attachments/s/t/file.png')).toBeNull();
  });

  it('rejects tool attachment paths from another session when an expected session is provided', () => {
    setNavigatorPlatform('MacIntel');
    expect(
      resolveTauriToolAttachmentUrl('/api/attachment/tool/session-b/turn-b/image.png', 'session-a'),
    ).toBeNull();
  });

  it('rejects tool attachment paths when the current session is unavailable', () => {
    setNavigatorPlatform('MacIntel');
    expect(
      resolveTauriToolAttachmentUrl('/api/attachment/tool/session-a/turn-b/image.png', null),
    ).toBeNull();
  });
});
