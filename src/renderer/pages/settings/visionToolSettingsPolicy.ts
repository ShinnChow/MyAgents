import type { AppConfig } from "@/config/types";
import {
  IMAGE_UNDERSTANDING_TOOL_ID,
  normalizeOfficialToolIds,
  type ImageUnderstandingToolSettings,
} from "../../../shared/official-tools";

export type VisionToolTogglePlan = "configure-before-enable" | "persist-toggle";

export function planVisionToolToggle(
  enabled: boolean,
  needsConfig: boolean,
): VisionToolTogglePlan {
  return enabled && needsConfig ? "configure-before-enable" : "persist-toggle";
}

export function applyVisionToolSettings(
  current: AppConfig,
  selection: ImageUnderstandingToolSettings,
  enableAfterSave: boolean,
): AppConfig {
  const enabledOfficialToolIds = enableAfterSave
    ? normalizeOfficialToolIds([
        ...(current.enabledOfficialToolIds ?? []),
        IMAGE_UNDERSTANDING_TOOL_ID,
      ])
    : current.enabledOfficialToolIds;

  return {
    ...current,
    enabledOfficialToolIds,
    officialToolSettings: {
      ...(current.officialToolSettings ?? {}),
      imageUnderstanding: selection,
    },
  };
}
