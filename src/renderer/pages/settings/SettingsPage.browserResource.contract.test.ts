import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const settingsPageSource = readFileSync(
  resolve(import.meta.dirname, 'SettingsPage.tsx'),
  'utf8',
);

describe('Settings Browser resource projection contract', () => {
  it('observes Rust resource status on the capabilities surface that renders MCP tools', () => {
    expect(settingsPageSource).toContain("if (mode !== 'capabilities' || !isTauriEnvironment()) return;");
    expect(settingsPageSource).toContain("'browser-resource-status'");
    expect(settingsPageSource).toContain("'cmd_browser_resource_status'");
    expect(settingsPageSource).not.toContain("if (mode !== 'settings' || !isTauriEnvironment()) return;");
  });

  it('keeps standard Playwright at two user-facing profile modes', () => {
    expect(settingsPageSource).toContain("mode: StandardPlaywrightProfileMode;");
    expect(settingsPageSource).toContain("mode: 'isolated'");
    expect(settingsPageSource).toContain("mode: 'persistent'");
    expect(settingsPageSource).not.toContain("mode: 'upstream'");
    expect(settingsPageSource).toContain('sm:grid-cols-2');
    expect(settingsPageSource).toContain("toolbox.dialogs.playwright.userDataDirHint");
  });
});
