import { describe, expect, it } from "vitest";

import type { AppConfig } from "@/config/types";
import {
  applyVisionToolSettings,
  planVisionToolToggle,
} from "./visionToolSettingsPolicy";

describe("image-understanding settings transaction policy", () => {
  it("requires configuration before persisting the first enable intent", () => {
    expect(planVisionToolToggle(true, true)).toBe("configure-before-enable");
    expect(planVisionToolToggle(true, false)).toBe("persist-toggle");
    expect(planVisionToolToggle(false, true)).toBe("persist-toggle");
  });

  it("saves the selected model and pending enable intent in one config mutation", () => {
    const current = {
      enabledOfficialToolIds: [],
      officialToolSettings: {},
    } as unknown as AppConfig;

    const next = applyVisionToolSettings(
      current,
      { providerId: "xiaomi-mimo", model: "mimo-v2.5" },
      true,
    );

    expect(next.officialToolSettings?.imageUnderstanding).toEqual({
      providerId: "xiaomi-mimo",
      model: "mimo-v2.5",
    });
    expect(next.enabledOfficialToolIds).toContain("image-understanding");
  });

  it("does not enable the tool when settings were opened independently", () => {
    const current = {
      enabledOfficialToolIds: [],
      officialToolSettings: {},
    } as unknown as AppConfig;

    const next = applyVisionToolSettings(
      current,
      { providerId: "xiaomi-mimo", model: "mimo-v2.5" },
      false,
    );

    expect(next.enabledOfficialToolIds).toEqual([]);
  });
});
