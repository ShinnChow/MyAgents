import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  type AppConfig,
  type McpServerDefinition,
} from "./config-types";
import {
  analyzeSpaceMcpCandidate,
  applyPortableMcpInstall,
  buildPortableMcpManifest,
  canonicalPortableMcpManifest,
  validatePortableMcpManifest,
} from "./spaceToolManifest";

function config(patch: Partial<AppConfig> = {}): AppConfig {
  return { ...DEFAULT_CONFIG, ...patch };
}

function stdio(patch: Partial<McpServerDefinition> = {}): McpServerDefinition {
  return {
    id: "team-mcp",
    name: "Team MCP",
    description: "Shared local MCP.",
    type: "stdio",
    command: "npx",
    args: ["-y", "@example/team-mcp"],
    env: { NODE_ENV: "production" },
    isBuiltin: false,
    ...patch,
  };
}

describe("Space portable MCP policy", () => {
  it("exports stdio configuration without copying configured secret values", () => {
    const manifest = buildPortableMcpManifest(
      stdio(),
      config({
        mcpServerArgs: { "team-mcp": ["--token", "super-secret-token-value"] },
        mcpServerEnv: { "team-mcp": { API_KEY: "sk-real-value-1234567890" } },
      }),
    );

    expect(manifest).toEqual({
      schemaVersion: 1,
      serverId: "team-mcp",
      transport: "stdio",
      stdio: {
        command: "npx",
        args: ["-y", "@example/team-mcp", "--token", "{{TOKEN}}"],
        envTemplates: {
          API_KEY: "{{API_KEY}}",
          NODE_ENV: "production",
        },
      },
      requiredConfigKeys: ["API_KEY", "TOKEN"],
    });
    expect(JSON.stringify(manifest)).not.toContain("super-secret");
    expect(JSON.stringify(manifest)).not.toContain("sk-real");
  });

  it("exports remote headers as templates and keeps sse transport", () => {
    const manifest = buildPortableMcpManifest(
      {
        id: "remote-team",
        name: "Remote Team",
        type: "sse",
        url: "https://mcp.example.test/sse",
        headers: {
          Authorization: "Bearer private-token",
          "X-Region": "cn",
        },
        isBuiltin: false,
      },
      config(),
    );

    expect(manifest.transport).toBe("sse");
    expect(manifest.remote).toEqual({
      urlTemplate: "https://mcp.example.test/sse",
      headerTemplates: {
        Authorization: "{{AUTHORIZATION}}",
        "X-Region": "{{X_REGION}}",
      },
    });
    expect(manifest.requiredConfigKeys).toEqual(["AUTHORIZATION", "X_REGION"]);
  });

  it.each([
    [stdio({ command: "/Users/example/bin/mcp" }), "absolute_path"],
    [
      stdio({ command: "bash", args: ["-c", "echo hello"] }),
      "shell_trampoline",
    ],
    [
      stdio({ args: ["--config=/Users/example/private.json"] }),
      "absolute_path",
    ],
    [
      {
        id: "query-secret",
        name: "Query Secret",
        type: "http" as const,
        url: "https://mcp.example.test/mcp?token=real",
        isBuiltin: false,
      },
      "secret_candidate",
    ],
  ])(
    "blocks unsafe definitions without returning a manifest",
    (server, code) => {
      const result = analyzeSpaceMcpCandidate(server, config());
      expect(result).toEqual({ status: "blocked", codes: [code] });
    },
  );

  it("excludes every preset id even when a custom definition overrides it", () => {
    const result = analyzeSpaceMcpCandidate(
      stdio({ id: "playwright" }),
      config(),
    );
    expect(result).toEqual({ status: "blocked", codes: ["preset_reserved"] });
  });

  it("warns for package-manager, platform, and localhost dependencies", () => {
    expect(
      analyzeSpaceMcpCandidate(stdio({ platforms: ["darwin"] }), config()),
    ).toMatchObject({
      status: "warning",
      codes: expect.arrayContaining([
        "runtime_dependency",
        "platform_dependency",
      ]),
    });
    expect(
      analyzeSpaceMcpCandidate(
        {
          id: "local-http",
          name: "Local HTTP",
          type: "http",
          url: "http://localhost:8787/mcp",
          isBuiltin: false,
        },
        config(),
      ),
    ).toMatchObject({
      status: "warning",
      codes: ["localhost_dependency"],
    });
  });

  it.each([
    [stdio({ name: "n".repeat(100) }), "warning", undefined],
    [stdio({ name: "n".repeat(101) }), "blocked", "name_too_long"],
    [stdio({ description: "d".repeat(1000) }), "warning", undefined],
    [
      stdio({ description: "d".repeat(1001) }),
      "blocked",
      "description_too_long",
    ],
  ])("enforces Tool metadata boundaries before publish", (server, status, code) => {
    const result = analyzeSpaceMcpCandidate(server, config());
    expect(result.status).toBe(status);
    if (code) expect(result.codes).toContain(code);
  });

  it("rejects schema additions and mismatched placeholder keys on install", () => {
    expect(() =>
      validatePortableMcpManifest({
        ...buildPortableMcpManifest(stdio(), config()),
        arbitraryScript: "echo unsafe",
      }),
    ).toThrow(/unsupported fields/);
    const manifest = buildPortableMcpManifest(stdio(), config());
    expect(() =>
      validatePortableMcpManifest({
        ...manifest,
        requiredConfigKeys: ["MISSING"],
      }),
    ).toThrow(/must match placeholders/);
  });

  it.each([
    [["--token", "plain-text-credential"], []],
    [["--api-key=plain-text-credential"], []],
  ])(
    "rejects sensitive stdio argument values even when their shape does not look secret",
    (args, requiredConfigKeys) => {
      expect(() =>
        validatePortableMcpManifest({
          schemaVersion: 1,
          serverId: "team-mcp",
          transport: "stdio",
          stdio: { command: "npx", args, envTemplates: {} },
          requiredConfigKeys,
        }),
      ).toThrow(/credential/);
    },
  );

  it("treats local secrets and enabled state as irrelevant to canonical equality", () => {
    const cloud = buildPortableMcpManifest(
      stdio({
        env: { API_KEY: "{{API_KEY}}" },
      }),
      config(),
    );
    const local = config({
      mcpServers: [stdio({ env: { API_KEY: "sk-local-only-123456789" } })],
      mcpEnabledServers: ["team-mcp"],
      mcpServerEnv: { "team-mcp": { API_KEY: "sk-local-only-123456789" } },
    });

    const result = applyPortableMcpInstall(
      local,
      cloud,
      { name: "Cloud display name" },
      false,
    );
    expect(result.outcome).toBe("identical");
    expect(result.config).toBe(local);
    expect(canonicalPortableMcpManifest(cloud)).not.toContain("sk-local");
  });

  it("installs absent MCPs globally and keeps them disabled", () => {
    const manifest = buildPortableMcpManifest(stdio(), config());
    const before = config({ mcpEnabledServers: ["another-server"] });
    const result = applyPortableMcpInstall(
      before,
      manifest,
      {
        name: "Published Team MCP",
        description: "Published description",
      },
      false,
    );

    expect(result.outcome).toBe("installed");
    expect(result.config.mcpServers).toContainEqual(
      expect.objectContaining({
        id: "team-mcp",
        name: "Published Team MCP",
        isBuiltin: false,
      }),
    );
    expect(result.config.mcpEnabledServers).toEqual(["another-server"]);
  });

  it("requires confirmation for a different definition and replaces in place without touching Agent refs", () => {
    const cloud = buildPortableMcpManifest(
      stdio({ args: ["-y", "@example/new-mcp", "--token", "{{TOKEN}}"] }),
      config(),
    );
    const agents = [{ id: "agent-one", mcpEnabledServers: ["team-mcp"] }];
    const before = config({
      mcpServers: [
        stdio({ args: ["-y", "@example/old-mcp", "--token", "local-token"] }),
      ],
      mcpEnabledServers: ["team-mcp"],
      mcpServerEnv: {
        "team-mcp": { TOKEN: "local-token", REMOVED_SECRET: "do-not-copy" },
      },
      mcpServerArgs: { "team-mcp": ["--old-extra"] },
      agents: agents as AppConfig["agents"],
    });

    expect(
      applyPortableMcpInstall(before, cloud, { name: "New MCP" }, false),
    ).toEqual({
      config: before,
      outcome: "conflict",
    });
    const replaced = applyPortableMcpInstall(
      before,
      cloud,
      { name: "New MCP" },
      true,
    );
    expect(replaced.outcome).toBe("replaced");
    expect(replaced.config.mcpServers).toHaveLength(1);
    expect(replaced.config.mcpServers?.[0]?.args).toEqual([
      "-y",
      "@example/new-mcp",
      "--token",
      "local-token",
    ]);
    expect(replaced.config.mcpServerEnv?.["team-mcp"]).toEqual({
      TOKEN: "local-token",
    });
    expect(replaced.config.mcpServerArgs?.["team-mcp"]).toBeUndefined();
    expect(replaced.config.mcpEnabledServers).not.toContain("team-mcp");
    expect(replaced.config.agents).toBe(agents);
  });

  it("does not migrate a removed argument secret into a different placeholder", () => {
    const cloud = buildPortableMcpManifest(
      stdio({ args: ["--workspace", "{{WORKSPACE}}"] }),
      config(),
    );
    const before = config({
      mcpServers: [stdio({ args: ["--token", "local-secret"] })],
    });

    const replaced = applyPortableMcpInstall(
      before,
      cloud,
      { name: "New MCP" },
      true,
    );
    expect(replaced.config.mcpServers?.[0]?.args).toEqual([
      "--workspace",
      "{{WORKSPACE}}",
    ]);
    expect(JSON.stringify(replaced.config.mcpServers)).not.toContain(
      "local-secret",
    );
  });
});
