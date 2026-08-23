import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return port;
}

async function waitForHealth(port, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`release Sidecar exited before health:\n${output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The release Sidecar has not bound its loopback port yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`release Sidecar did not become healthy:\n${output()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("the release Sidecar can lazily load Browser Host from its packaged runtime", async () => {
  const build = spawnSync(
    process.execPath,
    ["scripts/esbuild-bundle.mjs", "server"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

  const releaseRoot = mkdtempSync(join(tmpdir(), "myagents-browser-release-"));
  const resourcesDir = join(releaseRoot, "Resources");
  const packagedNodeModules = join(resourcesDir, "node_modules");
  mkdirSync(resourcesDir, { recursive: true });
  cpSync(
    join(repoRoot, "src-tauri", "resources", "server-dist.js"),
    join(resourcesDir, "server-dist.js"),
  );

  const port = await reservePort();
  const homeDir = join(releaseRoot, "home");
  const agentDir = join(homeDir, "agent");
  mkdirSync(agentDir, { recursive: true });
  const child = spawn(
    process.execPath,
    [
      join(resourcesDir, "server-dist.js"),
      "--agent-dir",
      agentDir,
      "--port",
      String(port),
      "--sidecar-role",
      "global",
      "--no-pre-warm",
    ],
    {
      cwd: resourcesDir,
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        MYAGENTS_SIDECAR_ID: "__global__",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const output = () => `${stdout}\n${stderr}`;

  try {
    // A Global/Session Sidecar that never uses Browser Host must not resolve
    // Playwright at process startup. Add the packaged runtime only after the
    // bare release bundle has answered health.
    await waitForHealth(port, child, output);
    const stagedControlRoot = join(
      repoRoot,
      "src-tauri",
      "resources",
      "playwright-control",
    );
    mkdirSync(join(packagedNodeModules, "@playwright"), { recursive: true });
    for (const packageName of ["playwright", "playwright-core"]) {
      cpSync(
        join(stagedControlRoot, packageName),
        join(packagedNodeModules, packageName),
        { recursive: true },
      );
    }
    cpSync(
      join(stagedControlRoot, "@playwright", "mcp"),
      join(packagedNodeModules, "@playwright", "mcp"),
      { recursive: true },
    );
    const importProbe = join(resourcesDir, "playwright-runtime-probe.mjs");
    writeFileSync(
      importProbe,
      [
        'import { createConnection } from "@playwright/mcp";',
        'import { chromium } from "playwright";',
        'if (typeof createConnection !== "function") throw new Error("missing createConnection");',
        'if (typeof chromium?.launch !== "function") throw new Error("missing chromium.launch");',
      ].join("\n"),
    );
    const importResult = spawnSync(process.execPath, [importProbe], {
      cwd: resourcesDir,
      encoding: "utf8",
    });
    assert.equal(
      importResult.status,
      0,
      `${importResult.stdout}\n${importResult.stderr}`,
    );
    const response = await fetch(`http://127.0.0.1:${port}/mcp/playwright`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    });
    assert.equal(response.status, 401, output());
    const body = JSON.parse(await response.text());
    assert.equal(
      body?.error?.data?.code,
      "BROWSER_CAPABILITY_REQUIRED",
      output(),
    );
  } finally {
    await stopChild(child);
    rmSync(releaseRoot, { recursive: true, force: true });
  }
});
