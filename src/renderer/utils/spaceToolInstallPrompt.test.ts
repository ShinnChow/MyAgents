import { describe, expect, it } from "vitest";

import { buildSpaceToolInstallPrompt } from "./spaceToolInstallPrompt";

describe("buildSpaceToolInstallPrompt", () => {
  it("uses the Tool install skill and an unlabeled instruction fence", () => {
    expect(
      buildSpaceToolInstallPrompt({
        toolName: "FFmpeg",
        toolDescription: "视频处理工具",
        spaceName: "Video Team",
        instruction: "brew install ffmpeg",
      }),
    ).toBe(
      [
        "## 工具安装请求",
        "",
        "**工具**：FFmpeg",
        "**简介**：视频处理工具",
        "**来源**：Space「Video Team」",
        "",
        "请使用 /tool-install skill，在当前设备上安装这个工具。请结合本机实际环境执行，并以该 Skill 的安全与安装规范为准。",
        "",
        "```",
        "brew install ffmpeg",
        "```",
        "",
        "完成后，请在当前对话中简要说明安装结果和实际验证情况。",
      ].join("\n"),
    );
  });

  it("chooses a fence longer than backticks in an instruction", () => {
    const prompt = buildSpaceToolInstallPrompt({
      toolName: "Example",
      toolDescription: "Example",
      spaceName: "Team",
      instruction: "run ```quoted``` command",
    });
    expect(prompt).toContain("````\nrun ```quoted``` command\n````");
  });

  it("preserves instruction whitespace byte-for-byte inside the fence", () => {
    const instruction = "  first line  \n\n\tsecond line\n";
    const prompt = buildSpaceToolInstallPrompt({
      toolName: "Whitespace",
      toolDescription: "Preserve it",
      spaceName: "Team",
      instruction,
    });

    expect(prompt).toContain(`\n\n\`\`\`\n${instruction}\`\`\`\n\n`);
  });
});
