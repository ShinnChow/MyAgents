import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalizeLegacyMyAgentsResourceUrl,
  resolveMyAgentsResourceUrl,
} from './myagentsProtocol';

const originalPlatform = navigator.platform;
const originalUserAgent = navigator.userAgent;

function setNavigator(platform: string, userAgent: string) {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
}

afterEach(() => {
  vi.restoreAllMocks();
  void originalPlatform;
  void originalUserAgent;
});

describe('myagents-resource protocol projection', () => {
  it('emits the canonical scheme on macOS and Linux', () => {
    setNavigator('MacIntel', 'Mozilla/5.0 (Macintosh)');
    expect(resolveMyAgentsResourceUrl('/attachment/s/file.png')).toBe(
      'myagents-resource://attachment/s/file.png',
    );
  });

  it('emits the WebView2 custom-protocol host on Windows', () => {
    setNavigator('Win32', 'Mozilla/5.0 (Windows NT 10.0)');
    expect(resolveMyAgentsResourceUrl('/tool-attachment/s/t/file.png')).toBe(
      'http://myagents-resource.localhost/tool-attachment/s/t/file.png',
    );
  });

  it('rewrites only historical resource authorities through the platform projection', () => {
    setNavigator('MacIntel', 'Mozilla/5.0 (Macintosh)');
    expect(canonicalizeLegacyMyAgentsResourceUrl('myagents://attachment/s/file.png')).toBe(
      'myagents-resource://attachment/s/file.png',
    );
    expect(canonicalizeLegacyMyAgentsResourceUrl('myagents://tool-attachment/s/t/file.png')).toBe(
      'myagents-resource://tool-attachment/s/t/file.png',
    );
    expect(canonicalizeLegacyMyAgentsResourceUrl('myagents://open/v1/spaces/a/issues/b')).toBe(
      'myagents://open/v1/spaces/a/issues/b',
    );
  });
});
