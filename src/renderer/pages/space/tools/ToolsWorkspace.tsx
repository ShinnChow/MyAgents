import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  CircleAlert,
  History,
  Loader2,
  MoreHorizontal,
  PackagePlus,
  Pencil,
  RefreshCw,
  RotateCcw,
  Trash2,
  UploadCloud,
  Wrench,
  X,
} from "lucide-react";

import {
  spaceErrorMessage,
  type SpaceTool,
  type SpaceToolDetail,
} from "@/api/spaceCloud";
import OverlayBackdrop from "@/components/OverlayBackdrop";
import { useToast } from "@/components/Toast";
import type { AppConfig, McpServerDefinition } from "@/config/types";
import { atomicModifyConfig } from "@/config/services/appConfigService";
import { useCloseLayer } from "@/hooks/useCloseLayer";
import { useWorkspaceFileService } from "@/hooks/useWorkspaceFileService";
import {
  SPACE_COLLECTION_FRAME_CLASS,
  SPACE_PRIMARY_TOOL_BUTTON_CLASS,
  SPACE_REFRESH_TOOL_BUTTON_CLASS,
  SPACE_TWO_COLUMN_GRID_CLASS,
  formatDate,
} from "@/pages/space/spaceUi";
import {
  SPACE_VISIBLE_REFRESH_TTL_MS,
  withSpaceStoreMutationMetric,
  type SpaceActions,
  type SpaceToolDetailState,
  type SpaceToolRevisionState,
  type SpaceToolsState,
} from "@/pages/space/spaceStore";
import { trackSpaceToolMutation } from "@/pages/space/spaceMetrics";
import { dispatchHelperRequest } from "@/utils/dispatchHelperRequest";
import { buildSpaceToolInstallPrompt } from "@/utils/spaceToolInstallPrompt";
import { CUSTOM_EVENTS } from "../../../../shared/constants";
import {
  RESERVED_SPACE_MCP_SERVER_IDS,
  SpaceMcpPolicyError,
  analyzeSpaceMcpCandidate,
  applyPortableMcpInstall,
  validatePortableMcpManifest,
  type PortableMcpManifestV1,
  type SpaceMcpPolicyResult,
} from "../../../../shared/spaceToolManifest";

type PublishMode = "mcp" | "custom" | null;
type DetailMode = "entry" | "history" | "delete";

function ToolIcon({
  name,
  iconUrl,
  size = 32,
}: {
  name: string;
  iconUrl?: string | null;
  size?: number;
}) {
  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-lg object-cover shadow-sm"
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="grid shrink-0 place-items-center rounded-lg bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)] shadow-sm"
    >
      <Wrench className="h-4 w-4" />
      <span className="sr-only">{name}</span>
    </span>
  );
}

function ToolTag({ kind }: { kind: SpaceTool["kind"] }) {
  const { t } = useTranslation("app");
  return (
    <span className="rounded-md border border-[var(--line-subtle)] bg-[var(--paper-inset)] px-1.5 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">
      {kind === "mcp" ? t("space.tools.kindMcp") : t("space.tools.kindCustom")}
    </span>
  );
}

function ToolOverlay({
  children,
  onClose,
  busy = false,
  size = "form",
}: {
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  size?: "form" | "detail";
}) {
  return (
    <OverlayBackdrop
      portal
      onClose={() => {
        if (!busy) onClose();
      }}
      className="z-[220] items-center justify-center px-3 py-6 sm:px-6"
    >
      <section
        className={`flex max-h-[calc(100dvh-24px)] w-full flex-col overflow-hidden rounded-2xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-lg ${size === "detail" ? "h-[min(680px,calc(100dvh-48px))] max-w-[720px]" : "max-w-[800px] sm:max-h-[min(80vh,820px)]"}`}
      >
        {children}
      </section>
    </OverlayBackdrop>
  );
}

function OverlayHeader({
  title,
  onClose,
  closeDisabled = false,
  children,
}: {
  title: string;
  onClose: () => void;
  closeDisabled?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation("app");
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-[var(--line-subtle)] px-4">
      <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-[var(--ink)]">
        {title}
      </h2>
      {children}
      <button
        type="button"
        onClick={onClose}
        disabled={closeDisabled}
        aria-label={t("space.tools.close")}
        className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <X className="h-4 w-4" />
      </button>
    </header>
  );
}

type McpCandidate = {
  server: McpServerDefinition;
  policy: SpaceMcpPolicyResult;
};

function McpPublishOverlay({
  config,
  busy,
  onClose,
  onContinue,
}: {
  config: AppConfig;
  busy: boolean;
  onClose: () => void;
  onContinue: (candidate: McpCandidate) => void;
}) {
  const { t } = useTranslation("app");
  const candidates = useMemo<McpCandidate[]>(
    () =>
      (config.mcpServers ?? [])
        .filter(
          (server) =>
            server.isBuiltin !== true &&
            !RESERVED_SPACE_MCP_SERVER_IDS.has(server.id),
        )
        .map((server) => ({
          server,
          policy: analyzeSpaceMcpCandidate(server, config),
        })),
    [config],
  );
  const [selectedId, setSelectedId] = useState(candidates[0]?.server.id ?? "");
  const selected = candidates.find(({ server }) => server.id === selectedId);
  return (
    <ToolOverlay onClose={onClose} busy={busy}>
      <OverlayHeader
        title={t("space.tools.publishInstalledMcp")}
        onClose={onClose}
        closeDisabled={busy}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {candidates.length ? (
          <div className="grid gap-2">
            {candidates.map(({ server, policy }) => {
              const blocked = policy.status === "blocked";
              return (
                <button
                  key={server.id}
                  type="button"
                  disabled={blocked}
                  onClick={() => setSelectedId(server.id)}
                  className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border p-3 text-left transition-colors ${selectedId === server.id ? "border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)]/50" : "border-[var(--line)] hover:bg-[var(--hover-bg)]"} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  <span
                    className={`h-4 w-4 rounded-full border-2 ${selectedId === server.id ? "border-[var(--accent-warm)] bg-[var(--accent-warm)] shadow-[inset_0_0_0_3px_var(--paper-elevated)]" : "border-[var(--line-strong)]"}`}
                  />
                  <span className="min-w-0">
                    <strong className="block truncate text-sm font-semibold text-[var(--ink)]">
                      {server.name}
                    </strong>
                    <span className="mt-0.5 block truncate text-xs text-[var(--ink-muted)]">
                      {server.description || server.id} · {server.type} ·{" "}
                      {config.mcpEnabledServers?.includes(server.id)
                        ? t("space.tools.localEnabled")
                        : t("space.tools.localDisabled")}
                    </span>
                    {policy.codes.length ? (
                      <span
                        className={`mt-1 block text-xs ${blocked ? "text-[var(--danger)]" : "text-[var(--warning)]"}`}
                      >
                        {policy.codes
                          .map((code) => t(`space.tools.policy.${code}`))
                          .join("；")}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={`text-xs font-semibold ${blocked ? "text-[var(--danger)]" : policy.status === "warning" ? "text-[var(--warning)]" : "text-[var(--success)]"}`}
                  >
                    {blocked
                      ? t("space.tools.portabilityBlocked")
                      : policy.status === "warning"
                        ? t("space.tools.portabilityWarning")
                        : t("space.tools.portabilitySafe")}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="grid min-h-40 place-items-center text-center text-sm text-[var(--ink-muted)]">
            {t("space.tools.noLocalMcp")}
          </div>
        )}
      </div>
      <footer className="flex shrink-0 justify-end gap-2 border-t border-[var(--line-subtle)] px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="h-9 rounded-lg px-3 text-sm font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
        >
          {t("space.common.cancel")}
        </button>
        <button
          type="button"
          disabled={!selected?.policy.manifest || busy}
          onClick={() => selected && onContinue(selected)}
          className={SPACE_PRIMARY_TOOL_BUTTON_CLASS}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("space.tools.next")}
        </button>
      </footer>
    </ToolOverlay>
  );
}

function ToolIdentityFields({
  name,
  description,
  iconFilePath,
  iconPreview,
  resetIcon,
  existingIconUrl,
  descriptionRequired,
  onNameChange,
  onDescriptionChange,
  onIconChange,
  onResetIcon,
}: {
  name: string;
  description: string;
  iconFilePath: string | null;
  iconPreview: string | null;
  resetIcon: boolean;
  existingIconUrl?: string | null;
  descriptionRequired: boolean;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onIconChange: (path: string, preview: string) => void;
  onResetIcon: () => void;
}) {
  const { t } = useTranslation("app");
  const toast = useToast();
  const fileService = useWorkspaceFileService(null);
  const [touched, setTouched] = useState({ name: false, description: false });
  const pickIcon = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        {
          name: t("space.tools.icon"),
          extensions: ["png", "jpg", "jpeg", "webp"],
        },
      ],
    });
    if (!selected || Array.isArray(selected)) return;
    try {
      const preview = await fileService.readPathsAsBase64({
        paths: [selected],
      });
      const file = preview.files[0];
      if (!file || file.error) {
        throw new Error(file?.error || t("space.tools.iconPreviewFailed"));
      }
      onIconChange(selected, `data:${file.mimeType};base64,${file.data}`);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void pickIcon()}
          className="rounded-xl outline-none ring-[var(--accent-warm)] focus-visible:ring-2"
          aria-label={t("space.tools.chooseIcon")}
        >
          <ToolIcon
            name={name || t("space.tools.defaultName")}
            iconUrl={resetIcon ? null : iconPreview}
            size={48}
          />
        </button>
        <div className="min-w-0 text-xs text-[var(--ink-muted)]">
          <button
            type="button"
            onClick={() => void pickIcon()}
            className="font-semibold text-[var(--accent-warm)] hover:underline"
          >
            {t("space.tools.chooseIcon")}
          </button>
          {iconFilePath ? (
            <p className="mt-1 truncate">{iconFilePath.split(/[\\/]/).pop()}</p>
          ) : null}
          {existingIconUrl && !resetIcon ? (
            <button
              type="button"
              className="mt-1 block hover:underline"
              onClick={onResetIcon}
            >
              {t("space.tools.resetIcon")}
            </button>
          ) : null}
        </div>
      </div>
      <label className="block text-xs font-semibold text-[var(--ink-muted)]">
        {t("space.tools.name")}
        <input
          value={name}
          maxLength={100}
          onChange={(event) => onNameChange(event.target.value)}
          onBlur={() => setTouched((value) => ({ ...value, name: true }))}
          aria-invalid={touched.name && !name.trim()}
          className="mt-1 h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
        />
        {touched.name && !name.trim() ? (
          <span className="mt-1 block text-xs font-normal text-[var(--danger)]">
            {t("space.tools.nameRequired")}
          </span>
        ) : null}
      </label>
      <label className="block text-xs font-semibold text-[var(--ink-muted)]">
        {t("space.tools.description")}
        <input
          value={description}
          maxLength={1000}
          onChange={(event) => onDescriptionChange(event.target.value)}
          onBlur={() =>
            setTouched((value) => ({ ...value, description: true }))
          }
          aria-invalid={
            descriptionRequired && touched.description && !description.trim()
          }
          className="mt-1 h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
        />
        {descriptionRequired && touched.description && !description.trim() ? (
          <span className="mt-1 block text-xs font-normal text-[var(--danger)]">
            {t("space.tools.descriptionRequired")}
          </span>
        ) : null}
      </label>
    </div>
  );
}

function CustomToolFormOverlay({
  existing,
  busy,
  onClose,
  onSubmit,
}: {
  existing?: SpaceToolDetail | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    description: string;
    instruction: string;
    iconFilePath: string | null;
    resetIcon: boolean;
  }) => Promise<void>;
}) {
  const { t } = useTranslation("app");
  const [name, setName] = useState(existing?.revision.name ?? "");
  const [description, setDescription] = useState(
    existing?.revision.description ?? "",
  );
  const [instruction, setInstruction] = useState(
    existing?.revision.customInstallInstruction ?? "",
  );
  const [iconFilePath, setIconFilePath] = useState<string | null>(null);
  const [resetIcon, setResetIcon] = useState(false);
  const [iconPreview, setIconPreview] = useState<string | null>(
    existing?.revision.iconUrl ?? null,
  );
  const [instructionTouched, setInstructionTouched] = useState(false);
  const canSubmit = Boolean(
    name.trim() && description.trim() && instruction.trim(),
  );
  return (
    <ToolOverlay onClose={onClose} busy={busy}>
      <OverlayHeader
        title={
          existing
            ? t("space.tools.updateCustom")
            : t("space.tools.publishCustomPrompt")
        }
        onClose={onClose}
        closeDisabled={busy}
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <ToolIdentityFields
          name={name}
          description={description}
          iconFilePath={iconFilePath}
          iconPreview={iconPreview}
          resetIcon={resetIcon}
          existingIconUrl={existing?.revision.iconUrl}
          descriptionRequired
          onNameChange={setName}
          onDescriptionChange={setDescription}
          onIconChange={(path, preview) => {
            setIconFilePath(path);
            setIconPreview(preview);
            setResetIcon(false);
          }}
          onResetIcon={() => {
            setIconFilePath(null);
            setIconPreview(null);
            setResetIcon(true);
          }}
        />
        <label className="block text-xs font-semibold text-[var(--ink-muted)]">
          {t("space.tools.installInstruction")}
          <textarea
            value={instruction}
            maxLength={20_000}
            rows={10}
            placeholder={t("space.tools.installInstructionPlaceholder")}
            onChange={(event) => setInstruction(event.target.value)}
            onBlur={() => setInstructionTouched(true)}
            aria-invalid={instructionTouched && !instruction.trim()}
            className="mt-1 min-h-56 w-full resize-y rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3 font-mono text-sm leading-6 text-[var(--ink)] outline-none placeholder:font-sans placeholder:text-[var(--ink-faint)] focus:border-[var(--accent-warm)]"
          />
          {instructionTouched && !instruction.trim() ? (
            <span className="mt-1 block text-xs font-normal text-[var(--danger)]">
              {t("space.tools.instructionRequired")}
            </span>
          ) : null}
        </label>
      </div>
      <footer className="flex shrink-0 justify-end gap-2 border-t border-[var(--line-subtle)] px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="h-9 rounded-lg px-3 text-sm font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
        >
          {t("space.common.cancel")}
        </button>
        <button
          type="button"
          disabled={!canSubmit || busy}
          onClick={() =>
            void onSubmit({
              name: name.trim(),
              description: description.trim(),
              instruction,
              iconFilePath,
              resetIcon,
            })
          }
          className={SPACE_PRIMARY_TOOL_BUTTON_CLASS}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {existing ? t("space.common.save") : t("space.tools.publish")}
        </button>
      </footer>
    </ToolOverlay>
  );
}

type McpToolFormInput = {
  name: string;
  description: string;
  portableMcpManifest: PortableMcpManifestV1;
  iconFilePath: string | null;
  resetIcon: boolean;
};

function McpToolFormOverlay({
  candidate,
  existing,
  busy,
  onClose,
  onSubmit,
}: {
  candidate?: McpCandidate | null;
  existing?: SpaceToolDetail | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: McpToolFormInput) => Promise<void>;
}) {
  const { t } = useTranslation("app");
  const initialManifest =
    existing?.revision.portableMcpManifest ?? candidate?.policy.manifest;
  const [name, setName] = useState(
    existing?.revision.name ?? candidate?.server.name ?? "",
  );
  const [description, setDescription] = useState(
    existing?.revision.description ?? candidate?.server.description ?? "",
  );
  const [manifestJson, setManifestJson] = useState(() =>
    initialManifest ? JSON.stringify(initialManifest, null, 2) : "",
  );
  const [manifestTouched, setManifestTouched] = useState(false);
  const [iconFilePath, setIconFilePath] = useState<string | null>(null);
  const [resetIcon, setResetIcon] = useState(false);
  const [iconPreview, setIconPreview] = useState<string | null>(
    existing?.revision.iconUrl ?? null,
  );
  const parsed = useMemo<{
    manifest: PortableMcpManifestV1 | null;
    error: string | null;
  }>(() => {
    try {
      const manifest = validatePortableMcpManifest(JSON.parse(manifestJson));
      const expectedServerId =
        existing?.tool.mcpServerId ??
        existing?.revision.portableMcpManifest?.serverId;
      if (expectedServerId && manifest.serverId !== expectedServerId) {
        return {
          manifest: null,
          error: t("space.tools.mcpServerIdImmutable"),
        };
      }
      return { manifest, error: null };
    } catch (error) {
      if (error instanceof SpaceMcpPolicyError) {
        return {
          manifest: null,
          error: t(`space.tools.policy.${error.code}`),
        };
      }
      return { manifest: null, error: t("space.tools.mcpJsonInvalid") };
    }
  }, [existing, manifestJson, t]);
  const canSubmit = Boolean(name.trim() && parsed.manifest);

  return (
    <ToolOverlay onClose={onClose} busy={busy}>
      <OverlayHeader
        title={
          existing
            ? t("space.tools.updateMcp")
            : t("space.tools.publishInstalledMcp")
        }
        onClose={onClose}
        closeDisabled={busy}
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <ToolIdentityFields
          name={name}
          description={description}
          iconFilePath={iconFilePath}
          iconPreview={iconPreview}
          resetIcon={resetIcon}
          existingIconUrl={existing?.revision.iconUrl}
          descriptionRequired={false}
          onNameChange={setName}
          onDescriptionChange={setDescription}
          onIconChange={(path, preview) => {
            setIconFilePath(path);
            setIconPreview(preview);
            setResetIcon(false);
          }}
          onResetIcon={() => {
            setIconFilePath(null);
            setIconPreview(null);
            setResetIcon(true);
          }}
        />
        <label className="block text-xs font-semibold text-[var(--ink-muted)]">
          {t("space.tools.mcpConfiguration")}
          <textarea
            value={manifestJson}
            rows={14}
            spellCheck={false}
            aria-label={t("space.tools.mcpConfiguration")}
            onChange={(event) => {
              setManifestJson(event.target.value);
              setManifestTouched(true);
            }}
            onBlur={() => setManifestTouched(true)}
            aria-invalid={manifestTouched && Boolean(parsed.error)}
            className="mt-1 min-h-72 w-full resize-y rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3 font-mono text-sm leading-6 text-[var(--ink)] outline-none focus:border-[var(--accent-warm)]"
          />
          <span className="mt-1 block text-xs font-normal leading-5 text-[var(--ink-faint)]">
            {existing
              ? t("space.tools.mcpConfigurationEditHelp")
              : t("space.tools.mcpConfigurationHelp")}
          </span>
          {manifestTouched && parsed.error ? (
            <span className="mt-1 block text-xs font-normal text-[var(--danger)]">
              {parsed.error}
            </span>
          ) : null}
        </label>
      </div>
      <footer className="flex shrink-0 justify-end gap-2 border-t border-[var(--line-subtle)] px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="h-9 rounded-lg px-3 text-sm font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
        >
          {t("space.common.cancel")}
        </button>
        <button
          type="button"
          disabled={!canSubmit || busy}
          onClick={() => {
            setManifestTouched(true);
            if (!parsed.manifest) return;
            void onSubmit({
              name: name.trim(),
              description: description.trim(),
              portableMcpManifest: parsed.manifest,
              iconFilePath,
              resetIcon,
            });
          }}
          className={SPACE_PRIMARY_TOOL_BUTTON_CLASS}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {existing ? t("space.common.save") : t("space.tools.publish")}
        </button>
      </footer>
    </ToolOverlay>
  );
}

export function ToolsWorkspace({
  admin,
  spaceId,
  spaceName,
  config,
  toolsState,
  selectedToolId,
  detailState,
  revisionState,
  actions,
  onSelectTool,
  onRefresh,
}: {
  admin: boolean;
  spaceId: string;
  spaceName: string;
  config: AppConfig;
  toolsState: SpaceToolsState;
  selectedToolId: string | null;
  detailState?: SpaceToolDetailState;
  revisionState?: SpaceToolRevisionState;
  actions: SpaceActions;
  onSelectTool: (id: string | null) => void;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation("app");
  const toast = useToast();
  const [publishMenuOpen, setPublishMenuOpen] = useState(false);
  const [publishMode, setPublishMode] = useState<PublishMode>(null);
  const [mcpCandidate, setMcpCandidate] = useState<McpCandidate | null>(null);
  const [detailMode, setDetailMode] = useState<DetailMode>("entry");
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editBaseLatestRevision, setEditBaseLatestRevision] = useState<
    number | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [replaceConflict, setReplaceConflict] = useState(false);
  const selectedSummary = toolsState.items.find(
    (tool) => tool.id === selectedToolId,
  );
  const detail = detailState?.detail ?? null;

  useCloseLayer(() => {
    if (busy) return true;
    if (adminMenuOpen) {
      setAdminMenuOpen(false);
      return true;
    }
    if (publishMenuOpen) {
      setPublishMenuOpen(false);
      return true;
    }
    if (editing) {
      setEditing(false);
      return true;
    }
    if (publishMode) {
      setPublishMode(null);
      setMcpCandidate(null);
      return true;
    }
    if (selectedToolId) {
      onSelectTool(null);
      return true;
    }
    return false;
  }, 220);

  useEffect(() => {
    if (!selectedToolId) return;
    setDetailMode("entry");
    setReplaceConflict(false);
    void actions.refreshToolDetail(selectedToolId, {
      maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS,
    });
  }, [actions, selectedToolId]);

  const publishMcp = async (input: McpToolFormInput) => {
    setBusy(true);
    try {
      const result = await actions.publishMcpTool({
        spaceId,
        name: input.name,
        description: input.description,
        portableMcpManifest: input.portableMcpManifest,
        iconFilePath: input.iconFilePath,
      });
      setPublishMode(null);
      setMcpCandidate(null);
      onSelectTool(result.tool.id);
      toast.success(t("space.tools.published"));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const publishCustom = async (input: {
    name: string;
    description: string;
    instruction: string;
    iconFilePath: string | null;
  }) => {
    setBusy(true);
    try {
      const result = await actions.publishCustomTool({
        spaceId,
        name: input.name,
        description: input.description,
        customInstallInstruction: input.instruction,
        iconFilePath: input.iconFilePath,
      });
      setPublishMode(null);
      onSelectTool(result.tool.id);
      toast.success(t("space.tools.published"));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const updateMcp = async (input: McpToolFormInput) => {
    if (!detail || editBaseLatestRevision === null) return;
    setBusy(true);
    try {
      await actions.updateMcpTool({
        toolId: detail.tool.id,
        name: input.name,
        description: input.description,
        portableMcpManifest: input.portableMcpManifest,
        expectedLatestRevision: editBaseLatestRevision,
        iconFilePath: input.iconFilePath,
        resetIcon: input.resetIcon,
      });
      setEditing(false);
      setEditBaseLatestRevision(null);
      toast.success(t("space.tools.updated"));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const updateCustom = async (input: {
    name: string;
    description: string;
    instruction: string;
    iconFilePath: string | null;
    resetIcon: boolean;
  }) => {
    if (!detail || editBaseLatestRevision === null) return;
    setBusy(true);
    try {
      await actions.updateCustomTool({
        toolId: detail.tool.id,
        name: input.name,
        description: input.description,
        customInstallInstruction: input.instruction,
        expectedLatestRevision: editBaseLatestRevision,
        iconFilePath: input.iconFilePath,
        resetIcon: input.resetIcon,
      });
      setEditing(false);
      setEditBaseLatestRevision(null);
      toast.success(t("space.tools.updated"));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const installMcp = async (allowReplace: boolean) => {
    if (!detail?.revision.portableMcpManifest) return;
    setBusy(true);
    try {
      let outcome: "identical" | "installed" | "replaced" | "conflict" =
        "conflict";
      await withSpaceStoreMutationMetric(
        "tool.install",
        () =>
          atomicModifyConfig((latest) => {
            const result = applyPortableMcpInstall(
              latest,
              detail.revision.portableMcpManifest,
              {
                name: detail.revision.name,
                description: detail.revision.description,
              },
              allowReplace,
            );
            outcome = result.outcome;
            return result.config;
          }),
        {
          toolKind: "mcp",
          toolResult: () =>
            outcome === "installed"
              ? "new"
              : outcome === "replaced"
                ? "replace"
                : outcome,
        },
      );
      if (outcome === "conflict") {
        setReplaceConflict(true);
        return;
      }
      setReplaceConflict(false);
      toast.success(t("space.tools.installed"));
      window.dispatchEvent(
        new CustomEvent(CUSTOM_EVENTS.OPEN_SETTINGS, {
          detail: {
            section: "mcp",
            mcpServerId: detail.revision.portableMcpManifest.serverId,
          },
        }),
      );
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const installCustom = () => {
    if (!detail?.revision.customInstallInstruction) return;
    dispatchHelperRequest({
      scenario: "space_tool_install",
      description: buildSpaceToolInstallPrompt({
        toolName: detail.revision.name,
        toolDescription: detail.revision.description,
        spaceName,
        instruction: detail.revision.customInstallInstruction,
      }),
    });
  };

  const installSelected = () => {
    if (detail?.tool.kind === "mcp") void installMcp(false);
    else installCustom();
  };

  const rollback = async (revision: number) => {
    if (!detail) return;
    setBusy(true);
    try {
      await actions.rollbackTool({
        toolId: detail.tool.id,
        revision,
        expectedCurrentRevision: detail.tool.currentRevision,
        toolKind: detail.tool.kind,
      });
      toast.success(t("space.tools.rolledBack"));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await actions.deleteTool({
        toolId: detail.tool.id,
        toolKind: detail.tool.kind,
      });
      onSelectTool(null);
      toast.success(t("space.tools.deleted"));
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
      <section className="flex min-h-12 items-center gap-2.5 border-b border-[var(--line)] bg-[var(--paper-elevated)]/60 px-5 py-1.5 backdrop-blur-md">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
          <Wrench className="h-4 w-4 shrink-0" />
          <span>{t("space.tools.title")}</span>
          <span className="rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">
            {toolsState.items.length}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {admin ? (
            <div className="relative">
              <button
                type="button"
                onClick={() => setPublishMenuOpen((open) => !open)}
                className={SPACE_PRIMARY_TOOL_BUTTON_CLASS}
              >
                <UploadCloud className="h-4 w-4" />
                {t("space.tools.publishTool")}
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {publishMenuOpen ? (
                <div className="absolute right-0 top-full z-20 mt-2 w-72 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 shadow-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setPublishMenuOpen(false);
                      setPublishMode("mcp");
                    }}
                    className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold text-[var(--ink)] hover:bg-[var(--hover-bg)]"
                  >
                    <PackagePlus className="h-4 w-4" />
                    {t("space.tools.publishInstalledMcp")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setPublishMenuOpen(false);
                      setPublishMode("custom");
                    }}
                    className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold text-[var(--ink)] hover:bg-[var(--hover-bg)]"
                  >
                    <Pencil className="h-4 w-4" />
                    {t("space.tools.publishCustomPrompt")}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => void onRefresh().catch(() => undefined)}
            className={SPACE_REFRESH_TOOL_BUTTON_CLASS}
            aria-label={t("space.common.refresh")}
          >
            {toolsState.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
          </button>
        </div>
      </section>

      <main className="min-h-0 overflow-y-auto px-6 pb-10 pt-5">
        <section
          className={SPACE_COLLECTION_FRAME_CLASS}
          aria-label={t("space.tools.listLabel")}
        >
          {toolsState.error && toolsState.items.length ? (
            <div className="mb-3 flex items-center gap-2 rounded-xl border border-[var(--warning)]/20 bg-[var(--warning-bg)] p-3 text-sm text-[var(--warning)]">
              <CircleAlert className="h-4 w-4" />
              {t("space.common.listRefreshFailed")}
            </div>
          ) : null}
          {toolsState.isLoading && !toolsState.items.length ? (
            <div className="grid min-h-48 place-items-center">
              <Loader2 className="h-5 w-5 animate-spin text-[var(--ink-muted)]" />
            </div>
          ) : toolsState.items.length ? (
            <div className={SPACE_TWO_COLUMN_GRID_CLASS}>
              {toolsState.items.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  onClick={() => onSelectTool(tool.id)}
                  className="grid min-h-20 grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3 text-left transition-shadow hover:shadow-sm"
                >
                  <ToolIcon name={tool.name} iconUrl={tool.iconUrl} />
                  <span className="min-w-0">
                    <strong className="block truncate text-sm font-semibold text-[var(--ink)]">
                      {tool.name}
                    </strong>
                    <span className="mt-1 block truncate text-xs text-[var(--ink-muted)]">
                      {tool.description || t("space.tools.noDescription")}
                    </span>
                  </span>
                  <ToolTag kind={tool.kind} />
                </button>
              ))}
            </div>
          ) : (
            <div className="grid min-h-48 place-items-center text-center text-sm text-[var(--ink-muted)]">
              {toolsState.error
                ? spaceErrorMessage(toolsState.error)
                : t("space.tools.empty")}
            </div>
          )}
          {toolsState.hasMore ? (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                disabled={toolsState.isLoadingMore}
                onClick={() => void actions.loadMoreTools()}
                className="flex h-9 items-center gap-2 rounded-lg border border-[var(--line)] px-4 text-sm font-semibold text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
              >
                {toolsState.isLoadingMore ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                {t("space.common.loadMore")}
              </button>
            </div>
          ) : null}
        </section>
      </main>

      {publishMode === "mcp" ? (
        mcpCandidate ? (
          <McpToolFormOverlay
            candidate={mcpCandidate}
            busy={busy}
            onClose={() => {
              setPublishMode(null);
              setMcpCandidate(null);
            }}
            onSubmit={publishMcp}
          />
        ) : (
          <McpPublishOverlay
            config={config}
            busy={busy}
            onClose={() => setPublishMode(null)}
            onContinue={setMcpCandidate}
          />
        )
      ) : null}
      {publishMode === "custom" ? (
        <CustomToolFormOverlay
          busy={busy}
          onClose={() => setPublishMode(null)}
          onSubmit={publishCustom}
        />
      ) : null}

      {selectedToolId && !editing ? (
        <ToolOverlay
          onClose={() => onSelectTool(null)}
          busy={busy}
          size="detail"
        >
          <header className="flex min-h-20 shrink-0 items-center gap-3 border-b border-[var(--line-subtle)] px-5">
            <ToolIcon
              name={detail?.revision.name ?? selectedSummary?.name ?? "Tool"}
              iconUrl={detail?.revision.iconUrl ?? selectedSummary?.iconUrl}
              size={44}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold text-[var(--ink)]">
                  {detail?.revision.name ?? selectedSummary?.name}
                </h2>
                {(detail?.tool ?? selectedSummary) ? (
                  <ToolTag kind={(detail?.tool ?? selectedSummary)!.kind} />
                ) : null}
              </div>
              {detail ? (
                <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
                  {t("space.tools.revision", {
                    revision: detail.tool.currentRevision,
                  })}
                </p>
              ) : null}
            </div>
            {detailMode === "entry" && detail ? (
              <button
                type="button"
                disabled={busy}
                onClick={installSelected}
                className={SPACE_PRIMARY_TOOL_BUTTON_CLASS}
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <PackagePlus className="h-4 w-4" />
                )}
                {t("space.tools.install")}
              </button>
            ) : null}
            {admin && detail ? (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setAdminMenuOpen((open) => !open)}
                  aria-label={t("space.tools.moreActions")}
                  className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
                {adminMenuOpen ? (
                  <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 shadow-lg">
                    <button
                      type="button"
                      onClick={() => {
                        setAdminMenuOpen(false);
                        setEditBaseLatestRevision(detail.tool.latestRevision);
                        setEditing(true);
                      }}
                      className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm font-semibold hover:bg-[var(--hover-bg)]"
                    >
                      <Pencil className="h-4 w-4" />
                      {t("space.common.edit")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAdminMenuOpen(false);
                        setDetailMode("history");
                        void actions.refreshToolRevisions(detail.tool.id, {
                          force: true,
                        });
                      }}
                      className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm font-semibold hover:bg-[var(--hover-bg)]"
                    >
                      <History className="h-4 w-4" />
                      {t("space.tools.history")}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAdminMenuOpen(false);
                        setDetailMode("delete");
                      }}
                      className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm font-semibold text-[var(--danger)] hover:bg-[var(--danger-bg)]"
                    >
                      <Trash2 className="h-4 w-4" />
                      {t("space.common.delete")}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => onSelectTool(null)}
              disabled={busy}
              aria-label={t("space.tools.close")}
              className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="h-4 w-4" />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            {detailState?.isLoading && !detail ? (
              <div className="grid min-h-48 place-items-center">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : detailState?.error && !detail ? (
              <div className="grid min-h-48 place-items-center text-center text-sm text-[var(--danger)]">
                <div>
                  <p>{spaceErrorMessage(detailState.error)}</p>
                  <button
                    type="button"
                    onClick={() =>
                      void actions
                        .refreshToolDetail(selectedToolId, { force: true })
                        .catch(() => undefined)
                    }
                    className="mt-3 h-8 rounded-lg px-3 text-xs font-semibold text-[var(--accent-warm)] hover:bg-[var(--hover-bg)]"
                  >
                    {t("space.common.retry")}
                  </button>
                </div>
              </div>
            ) : detailMode === "history" && detail ? (
              <div>
                <button
                  type="button"
                  onClick={() => setDetailMode("entry")}
                  className="mb-4 text-sm font-semibold text-[var(--accent-warm)] hover:underline"
                >
                  {t("space.tools.backToDetail")}
                </button>
                {revisionState?.error ? (
                  <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-[var(--danger)]/25 bg-[var(--danger-bg)] p-3 text-sm text-[var(--danger)]">
                    <span>{spaceErrorMessage(revisionState.error)}</span>
                    <button
                      type="button"
                      onClick={() =>
                        void actions
                          .refreshToolRevisions(detail.tool.id, { force: true })
                          .catch(() => undefined)
                      }
                      className="shrink-0 font-semibold hover:underline"
                    >
                      {t("space.common.retry")}
                    </button>
                  </div>
                ) : null}
                {revisionState?.isLoading && !revisionState.history ? (
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                ) : (
                  <div className="grid gap-2">
                    {(revisionState?.history?.items ?? []).map((revision) => (
                      <div
                        key={revision.id}
                        className="flex items-center gap-3 rounded-xl border border-[var(--line)] p-3"
                      >
                        <span className="min-w-0 flex-1">
                          <strong className="block text-sm text-[var(--ink)]">
                            {t("space.tools.revision", {
                              revision: revision.revision,
                            })}
                          </strong>
                          <span className="text-xs text-[var(--ink-muted)]">
                            {revision.name} ·{" "}
                            {revision.uploader?.name ??
                              revision.uploader?.id ??
                              t("space.tools.unknownUploader")}{" "}
                            · {formatDate(revision.createdAt)}
                          </span>
                        </span>
                        {revision.revision === detail.tool.currentRevision ? (
                          <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">
                            {t("space.tools.currentRevision")}
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void rollback(revision.revision)}
                            className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            {t("space.tools.rollback")}
                          </button>
                        )}
                      </div>
                    ))}
                    {revisionState?.history?.hasMore ? (
                      <button
                        type="button"
                        disabled={revisionState.isLoadingMore}
                        onClick={() =>
                          void actions
                            .loadMoreToolRevisions(detail.tool.id)
                            .catch(() => undefined)
                        }
                        className="mt-1 flex h-9 items-center justify-center gap-2 rounded-lg text-sm font-semibold text-[var(--accent-warm)] hover:bg-[var(--hover-bg)] disabled:opacity-60"
                      >
                        {revisionState.isLoadingMore ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : null}
                        {t("space.common.loadMore")}
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            ) : detailMode === "delete" && detail ? (
              <div className="mx-auto max-w-md py-10 text-center">
                <Trash2 className="mx-auto h-8 w-8 text-[var(--danger)]" />
                <h3 className="mt-4 text-base font-semibold text-[var(--ink)]">
                  {t("space.tools.deleteConfirmTitle")}
                </h3>
                <p className="mt-2 text-sm text-[var(--ink-muted)]">
                  {t("space.tools.deleteConfirmDescription", {
                    name: detail.revision.name,
                  })}
                </p>
                <div className="mt-5 flex justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => setDetailMode("entry")}
                    className="h-9 rounded-lg px-3 text-sm font-semibold hover:bg-[var(--hover-bg)]"
                  >
                    {t("space.common.cancel")}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove()}
                    className="flex h-9 items-center gap-2 rounded-lg bg-[var(--danger)] px-3 text-sm font-semibold text-[var(--on-danger)] disabled:opacity-60"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {t("space.common.delete")}
                  </button>
                </div>
              </div>
            ) : detail ? (
              <div className="space-y-5">
                {detailState?.error ? (
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--danger)]/25 bg-[var(--danger-bg)] p-3 text-sm text-[var(--danger)]">
                    <span>{spaceErrorMessage(detailState.error)}</span>
                    <button
                      type="button"
                      onClick={() =>
                        void actions
                          .refreshToolDetail(detail.tool.id, { force: true })
                          .catch(() => undefined)
                      }
                      className="shrink-0 font-semibold hover:underline"
                    >
                      {t("space.common.retry")}
                    </button>
                  </div>
                ) : null}
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                    {t("space.tools.introduction")}
                  </h3>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-[var(--ink-secondary)]">
                    {detail.revision.description ||
                      t("space.tools.noDescription")}
                  </p>
                </section>
                {replaceConflict ? (
                  <section className="rounded-xl border border-[var(--warning)]/30 bg-[var(--warning-bg)] p-4">
                    <h3 className="text-sm font-semibold text-[var(--warning)]">
                      {t("space.tools.replaceConflictTitle")}
                    </h3>
                    <p className="mt-1 text-sm text-[var(--ink-secondary)]">
                      {t("space.tools.replaceConflictDescription")}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setReplaceConflict(false);
                          trackSpaceToolMutation({
                            operation: "install",
                            toolKind: "mcp",
                            result: "cancel",
                            ok: true,
                          });
                        }}
                        className="h-8 rounded-lg px-2 text-xs font-semibold hover:bg-[var(--paper-elevated)]"
                      >
                        {t("space.common.cancel")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void installMcp(true)}
                        className="h-8 rounded-lg bg-[var(--warning)] px-3 text-xs font-semibold text-[var(--on-warning)]"
                      >
                        {t("space.tools.replace")}
                      </button>
                    </div>
                  </section>
                ) : null}
                {detail.tool.kind === "custom_install_prompt" ? (
                  <section className="border-t border-[var(--line-subtle)] pt-5">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                      {t("space.tools.customInstruction")}
                    </h3>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-xl border border-[var(--line)] bg-[var(--paper-inset)] p-4 text-sm leading-6 text-[var(--ink-secondary)]">
                      <code>{detail.revision.customInstallInstruction}</code>
                    </pre>
                  </section>
                ) : detail.revision.portableMcpManifest ? (
                  <section className="border-t border-[var(--line-subtle)] pt-5">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--ink-muted)]">
                      {t("space.tools.mcpConfiguration")}
                    </h3>
                    <pre className="mt-2 max-h-80 overflow-auto whitespace-pre rounded-xl border border-[var(--line)] bg-[var(--paper-inset)] p-4 font-mono text-xs leading-5 text-[var(--ink-secondary)]">
                      <code>
                        {JSON.stringify(
                          detail.revision.portableMcpManifest,
                          null,
                          2,
                        )}
                      </code>
                    </pre>
                  </section>
                ) : null}
              </div>
            ) : null}
          </div>
        </ToolOverlay>
      ) : null}

      {editing && detail?.tool.kind === "mcp" ? (
        <McpToolFormOverlay
          existing={detail}
          busy={busy}
          onClose={() => {
            setEditing(false);
            setEditBaseLatestRevision(null);
          }}
          onSubmit={updateMcp}
        />
      ) : null}
      {editing && detail?.tool.kind === "custom_install_prompt" ? (
        <CustomToolFormOverlay
          existing={detail}
          busy={busy}
          onClose={() => {
            setEditing(false);
            setEditBaseLatestRevision(null);
          }}
          onSubmit={updateCustom}
        />
      ) : null}
    </div>
  );
}
