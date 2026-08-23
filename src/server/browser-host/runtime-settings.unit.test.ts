import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";

import { compileBrowserRuntimeSettings } from "./runtime-settings";

describe("compileBrowserRuntimeSettings", () => {
  it("compiles the fixed managed Chromium contract", () => {
    const compiled = compileBrowserRuntimeSettings("session-a", "/workspace/a");

    expect(compiled).toMatchObject({
      browserName: "chromium",
      launchOptions: { headless: false },
      contextOptions: {},
      connectionConfig: {
        capabilities: ["storage"],
        allowUnrestrictedFileAccess: false,
        outputDir: "/workspace/a/.myagents/browser-artifacts/session-a",
        outputMode: "stdout",
        browser: {
          browserName: "chromium",
          isolated: true,
          launchOptions: { headless: false },
          contextOptions: {},
        },
      },
    });
  });

  it("sanitizes the Product Session component inside the workspace root", () => {
    expect(
      compileBrowserRuntimeSettings("../session:a", "/workspace/a")
        .connectionConfig.outputDir,
    ).toBe("/workspace/a/.myagents/browser-artifacts/___session_a");
  });

  it("rejects an artifact directory symlink that escapes the authorized workspace", () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "myagents-browser-root-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(join(workspace, ".myagents"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, ".myagents", "browser-artifacts"));
    try {
      expect(() =>
        compileBrowserRuntimeSettings("session-a", workspace),
      ).toThrow("BROWSER_ARTIFACT_ROOT_INVALID");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
