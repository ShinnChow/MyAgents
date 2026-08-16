import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SpaceTool } from "@/api/spaceCloud";
import { ToastProvider } from "@/components/Toast";
import type { AppConfig } from "@/config/types";
import { i18n } from "@/i18n";
import type {
  SpaceActions,
  SpaceToolRevisionState,
  SpaceToolsState,
} from "@/pages/space/spaceStore";
import { CUSTOM_EVENTS } from "../../../../shared/constants";
import { ToolsWorkspace } from "./ToolsWorkspace";

const CUSTOM_INSTALL_PLACEHOLDER =
  "填写面向 Agent 阅读的安装工具提示词，例如：使用命令完整安装 ffmpeg `git clone https://git.ffmpeg.org/ffmpeg.git ffmpeg`，并在完成后验证安装结果。";

const configMocks = vi.hoisted(() => ({
  diskConfig: {} as AppConfig,
  atomicModifyConfig: vi.fn(),
}));

const apiMocks = vi.hoisted(() => ({
  spacePublishCustomTool: vi.fn(),
  spaceUpdateCustomTool: vi.fn(),
  spaceDeleteTool: vi.fn(),
}));

vi.mock("@/config/services/appConfigService", () => ({
  atomicModifyConfig: configMocks.atomicModifyConfig,
}));

vi.mock("@/api/spaceCloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/spaceCloud")>();
  return {
    ...actual,
    spacePublishCustomTool: apiMocks.spacePublishCustomTool,
    spaceUpdateCustomTool: apiMocks.spaceUpdateCustomTool,
    spaceDeleteTool: apiMocks.spaceDeleteTool,
  };
});

const mcpTool: SpaceTool = {
  id: "tool-mcp",
  kind: "mcp",
  mcpServerId: "team-mcp",
  name: "Team MCP",
  description: "Shared team context",
  currentRevision: 1,
  latestRevision: 1,
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
};

const customTool: SpaceTool = {
  ...mcpTool,
  id: "tool-custom",
  kind: "custom_install_prompt",
  mcpServerId: null,
  name: "FFmpeg",
  description: "Install FFmpeg",
};

const config = {
  mcpServers: [
    {
      id: "team-mcp",
      name: "Team MCP",
      description: "Shared team context",
      type: "stdio",
      command: "npx",
      args: ["-y", "@example/team-mcp"],
      isBuiltin: false,
    },
  ],
} as AppConfig;

const toolsState: SpaceToolsState = {
  items: [mcpTool, customTool],
  hasMore: false,
  nextCursor: null,
  lastFetchedAt: Date.now(),
  isLoading: false,
  isLoadingMore: false,
  error: null,
};

function renderTools(
  input: {
    admin?: boolean;
    selectedToolId?: string | null;
    detailError?: string | null;
    detailMissing?: boolean;
    revisionState?: SpaceToolRevisionState;
    refreshFailure?: boolean;
    onSelectTool?: (toolId: string | null) => void;
  } = {},
) {
  const actions = {
    refreshToolDetail: input.refreshFailure
      ? vi.fn().mockRejectedValue(new Error("refresh failed"))
      : vi.fn().mockResolvedValue(undefined),
    refreshToolRevisions: input.refreshFailure
      ? vi.fn().mockRejectedValue(new Error("refresh failed"))
      : vi.fn().mockResolvedValue(undefined),
    loadMoreToolRevisions: vi.fn().mockResolvedValue(undefined),
    refreshTools: input.refreshFailure
      ? vi.fn().mockRejectedValue(new Error("refresh failed"))
      : vi.fn().mockResolvedValue(undefined),
    loadMoreTools: vi.fn().mockResolvedValue(undefined),
  } as unknown as SpaceActions;
  render(
    <ToastProvider>
      <ToolsWorkspace
        admin={input.admin ?? true}
        spaceId="official"
        spaceName="MyAgents Community"
        config={config}
        toolsState={toolsState}
        selectedToolId={input.selectedToolId ?? null}
        detailState={
          input.detailMissing
            ? {
                detail: null,
                lastFetchedAt: 0,
                isLoading: false,
                error: input.detailError ?? "offline",
              }
            : input.selectedToolId === mcpTool.id
            ? {
                detail: {
                  tool: mcpTool,
                  revision: {
                    id: "mcp-revision-1",
                    toolId: mcpTool.id,
                    revision: 1,
                    name: mcpTool.name,
                    description: mcpTool.description,
                    portableMcpManifest: {
                      schemaVersion: 1,
                      serverId: "team-mcp",
                      transport: "stdio",
                      stdio: {
                        command: "npx",
                        args: ["-y", "@example/team-mcp"],
                        envTemplates: {},
                      },
                      requiredConfigKeys: [],
                    },
                    createdAt: mcpTool.createdAt,
                  },
                },
                lastFetchedAt: Date.now(),
                isLoading: false,
                error: input.detailError ?? null,
              }
            : input.selectedToolId === customTool.id
            ? {
                detail: {
                  tool: customTool,
                  revision: {
                    id: "revision-1",
                    toolId: customTool.id,
                    revision: 1,
                    name: customTool.name,
                    description: customTool.description,
                    customInstallInstruction: "brew install ffmpeg",
                    createdAt: customTool.createdAt,
                  },
                },
                lastFetchedAt: Date.now(),
                isLoading: false,
                error: input.detailError ?? null,
              }
            : undefined
        }
        revisionState={input.revisionState}
        actions={actions}
        onSelectTool={input.onSelectTool ?? vi.fn()}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
      />
    </ToastProvider>,
  );
  return actions;
}

describe("Space Tools workspace", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    configMocks.diskConfig = {} as AppConfig;
    configMocks.atomicModifyConfig.mockClear();
    apiMocks.spacePublishCustomTool.mockReset();
    apiMocks.spaceUpdateCustomTool.mockReset();
    apiMocks.spaceDeleteTool.mockReset();
    configMocks.atomicModifyConfig.mockImplementation(
      async (modify: (config: AppConfig) => AppConfig) => {
        configMocks.diskConfig = modify(configMocks.diskConfig);
        return configMocks.diskConfig;
      },
    );
  });

  it("renders matching Tool cards with MCP and custom tags", () => {
    renderTools();
    expect(screen.getByRole("button", { name: /Team MCP/ })).toHaveTextContent(
      "MCP",
    );
    expect(screen.getByRole("button", { name: /FFmpeg/ })).toHaveTextContent(
      "自定义",
    );
  });

  it("shows exactly the two confirmed publish entries to admins", () => {
    renderTools();
    fireEvent.click(screen.getByRole("button", { name: /发布工具/ }));
    const menuItems = screen
      .getAllByRole("button")
      .filter((button) =>
        ["发布本地已安装 MCP 工具", "发布自定义安装工具提示词"].includes(
          button.textContent?.trim() ?? "",
        ),
      );
    expect(menuItems).toHaveLength(2);
  });

  it("hides publishing from members", () => {
    renderTools({ admin: false });
    expect(
      screen.queryByRole("button", { name: /发布工具/ }),
    ).not.toBeInTheDocument();
  });

  it("uses the confirmed example placeholder in the custom form", () => {
    renderTools();
    fireEvent.click(screen.getByRole("button", { name: /发布工具/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "发布自定义安装工具提示词" }),
    );
    expect(
      screen.getByPlaceholderText(CUSTOM_INSTALL_PLACEHOLDER),
    ).toBeVisible();
    fireEvent.blur(screen.getByRole("textbox", { name: "工具名称" }));
    fireEvent.blur(screen.getByRole("textbox", { name: "工具简介" }));
    fireEvent.blur(
      screen.getByRole("textbox", { name: "自定义安装指令" }),
    );
    expect(screen.getByText("请填写工具名称")).toBeVisible();
    expect(screen.getByText("请填写工具简介")).toBeVisible();
    expect(screen.getByText("请填写自定义安装指令")).toBeVisible();
  });

  it("renders custom instructions as an unlabeled code block", () => {
    renderTools({ selectedToolId: customTool.id });
    const instruction = screen.getByText("brew install ffmpeg");
    expect(instruction.tagName).toBe("CODE");
    expect(
      within(instruction.parentElement!).queryByText(/bash|shell/i),
    ).toBeNull();
  });

  it("keeps detail failures recoverable with an inline retry", () => {
    const actions = renderTools({
      selectedToolId: mcpTool.id,
      detailMissing: true,
      detailError: "offline",
    });
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(actions.refreshToolDetail).toHaveBeenCalledWith(mcpTool.id, {
      force: true,
    });
  });

  it("keeps cached detail visible when refresh fails and can load older history", () => {
    const actions = renderTools({
      selectedToolId: mcpTool.id,
      detailError: "offline",
      revisionState: {
        history: {
          tool: { id: mcpTool.id, latestRevision: 101, currentRevision: 101 },
          items: [
            {
              id: "revision-101",
              toolId: mcpTool.id,
              revision: 101,
              name: "Team MCP v101",
              description: "Shared context",
              createdAt: "2026-08-16T00:00:00.000Z",
            },
          ],
          hasMore: true,
          nextCursor: "older",
        },
        lastFetchedAt: Date.now(),
        isLoading: false,
        isLoadingMore: false,
        error: null,
      },
    });
    expect(screen.getAllByText("Shared team context")).not.toHaveLength(0);
    expect(screen.getByRole("button", { name: "重试" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "历史版本" }));
    fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
    expect(actions.loadMoreToolRevisions).toHaveBeenCalledWith(mcpTool.id);
  });

  it("does not misreport a committed publish when post-mutation refresh fails", async () => {
    apiMocks.spacePublishCustomTool.mockResolvedValueOnce({
      tool: customTool,
      revision: {
        id: "revision-1",
        toolId: customTool.id,
        revision: 1,
        name: customTool.name,
        description: customTool.description,
        customInstallInstruction: "brew install ffmpeg",
        createdAt: customTool.createdAt,
      },
    });
    renderTools({ refreshFailure: true });
    fireEvent.click(screen.getByRole("button", { name: /发布工具/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "发布自定义安装工具提示词" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "工具名称" }), {
      target: { value: "FFmpeg" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "工具简介" }), {
      target: { value: "Install FFmpeg" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "自定义安装指令" }),
      { target: { value: "brew install ffmpeg" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "发布" }));

    await waitFor(() =>
      expect(apiMocks.spacePublishCustomTool).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "工具名称" }),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("工具已发布")).toBeVisible();
  });

  it("does not retry a committed delete when the post-mutation refresh fails", async () => {
    apiMocks.spaceDeleteTool.mockResolvedValueOnce({ deleted: true });
    const onSelectTool = vi.fn();
    renderTools({
      selectedToolId: customTool.id,
      refreshFailure: true,
      onSelectTool,
    });
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() =>
      expect(apiMocks.spaceDeleteTool).toHaveBeenCalledTimes(1),
    );
    await waitFor(() => expect(onSelectTool).toHaveBeenCalledWith(null));
    expect(await screen.findByText("工具已删除")).toBeVisible();
  });

  it("keeps the revision-conflict error visible when conflict refresh fails", async () => {
    apiMocks.spaceUpdateCustomTool.mockRejectedValueOnce(
      Object.assign(new Error("TOOL_REVISION_CONFLICT: stale revision"), {
        code: "TOOL_REVISION_CONFLICT",
      }),
    );
    renderTools({ selectedToolId: customTool.id, refreshFailure: true });
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(apiMocks.spaceUpdateCustomTool).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByText(/stale revision/)).toBeVisible();
  });

  it("keeps the edit-open revision as the CAS token after a remote refresh", async () => {
    apiMocks.spaceUpdateCustomTool.mockResolvedValueOnce({
      tool: { ...customTool, latestRevision: 3, currentRevision: 3 },
      revision: {
        id: "revision-3",
        toolId: customTool.id,
        revision: 3,
        name: customTool.name,
        description: customTool.description,
        customInstallInstruction: "brew install ffmpeg",
        createdAt: customTool.createdAt,
      },
    });
    const actions = {
      refreshToolDetail: vi.fn().mockResolvedValue(undefined),
      refreshToolRevisions: vi.fn().mockResolvedValue(undefined),
      loadMoreToolRevisions: vi.fn().mockResolvedValue(undefined),
      refreshTools: vi.fn().mockResolvedValue(undefined),
      loadMoreTools: vi.fn().mockResolvedValue(undefined),
    } as unknown as SpaceActions;
    function Harness() {
      const [latestRevision, setLatestRevision] = useState(1);
      const currentTool = {
        ...customTool,
        latestRevision,
        currentRevision: latestRevision,
      };
      return (
        <ToastProvider>
          <button type="button" onClick={() => setLatestRevision(2)}>
            remote refresh
          </button>
          <ToolsWorkspace
            admin
            spaceId="official"
            spaceName="MyAgents Community"
            config={config}
            toolsState={toolsState}
            selectedToolId={customTool.id}
            detailState={{
              detail: {
                tool: currentTool,
                revision: {
                  id: `revision-${latestRevision}`,
                  toolId: customTool.id,
                  revision: latestRevision,
                  name: customTool.name,
                  description: customTool.description,
                  customInstallInstruction: "brew install ffmpeg",
                  createdAt: customTool.createdAt,
                },
              },
              lastFetchedAt: 1_786_838_400_000,
              isLoading: false,
              error: null,
            }}
            actions={actions}
            onSelectTool={vi.fn()}
            onRefresh={vi.fn().mockResolvedValue(undefined)}
          />
        </ToastProvider>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "remote refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(apiMocks.spaceUpdateCustomTool).toHaveBeenCalledWith(
        expect.objectContaining({ expectedLatestRevision: 1 }),
      ),
    );
  });

  it("installs MCP globally as disabled and opens the matching capability", async () => {
    const openSettings = vi.fn();
    window.addEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, openSettings);
    try {
      renderTools({ selectedToolId: mcpTool.id });
      fireEvent.click(screen.getByRole("button", { name: "安装" }));

      await waitFor(() =>
        expect(configMocks.atomicModifyConfig).toHaveBeenCalledTimes(1),
      );
      expect(configMocks.diskConfig.mcpServers).toContainEqual(
        expect.objectContaining({
          id: "team-mcp",
          command: "npx",
          isBuiltin: false,
        }),
      );
      expect(configMocks.diskConfig.mcpEnabledServers ?? []).not.toContain(
        "team-mcp",
      );
      expect(screen.getByText("MCP 工具已添加到本地")).toBeVisible();
      await waitFor(() =>
        expect(openSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            detail: { section: "mcp", mcpServerId: "team-mcp" },
          }),
        ),
      );
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, openSettings);
    }
  });

  it("treats an identical MCP as already added without rewriting its definition", async () => {
    const existingConfig = { ...config, mcpEnabledServers: ["team-mcp"] };
    configMocks.diskConfig = existingConfig;
    const openSettings = vi.fn();
    window.addEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, openSettings);
    try {
      renderTools({ selectedToolId: mcpTool.id });
      fireEvent.click(screen.getByRole("button", { name: "安装" }));

      await waitFor(() => expect(openSettings).toHaveBeenCalledTimes(1));
      expect(configMocks.diskConfig).toBe(existingConfig);
      expect(configMocks.diskConfig.mcpEnabledServers).toEqual(["team-mcp"]);
      expect(screen.getByText("MCP 工具已添加到本地")).toBeVisible();
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, openSettings);
    }
  });

  it("requires confirmation before replacing a different MCP in place", async () => {
    configMocks.diskConfig = {
      ...config,
      mcpServers: [
        {
          ...config.mcpServers![0],
          args: ["-y", "@example/old-team-mcp"],
        },
      ],
      mcpEnabledServers: ["team-mcp"],
    };
    const openSettings = vi.fn();
    window.addEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, openSettings);
    try {
      renderTools({ selectedToolId: mcpTool.id });
      fireEvent.click(screen.getByRole("button", { name: "安装" }));

      expect(
        await screen.findByText("本地已存在同 ID 的不同 MCP 配置"),
      ).toBeVisible();
      expect(openSettings).not.toHaveBeenCalled();
      expect(configMocks.diskConfig.mcpEnabledServers).toContain("team-mcp");

      fireEvent.click(screen.getByRole("button", { name: "替换本地配置" }));
      await waitFor(() => expect(openSettings).toHaveBeenCalledTimes(1));
      expect(configMocks.diskConfig.mcpServers?.[0]?.args).toEqual([
        "-y",
        "@example/team-mcp",
      ]);
      expect(configMocks.diskConfig.mcpEnabledServers).not.toContain(
        "team-mcp",
      );
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.OPEN_SETTINGS, openSettings);
    }
  });

  it("dispatches custom installation through the dedicated helper scenario", () => {
    const openHelper = vi.fn();
    window.addEventListener(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, openHelper);
    try {
      renderTools({ selectedToolId: customTool.id });
      fireEvent.click(screen.getByRole("button", { name: "安装" }));

      expect(openHelper).toHaveBeenCalledWith(
        expect.objectContaining({
          detail: expect.objectContaining({
            scenario: "space_tool_install",
            description: expect.stringContaining(
              "请使用 /tool-install skill，在当前设备上安装这个工具",
            ),
          }),
        }),
      );
    } finally {
      window.removeEventListener(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, openHelper);
    }
  });
});
