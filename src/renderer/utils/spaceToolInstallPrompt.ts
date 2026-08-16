export interface SpaceToolInstallPromptInput {
  toolName: string;
  toolDescription: string;
  spaceName: string;
  instruction: string;
}

function markdownFenceFor(value: string): string {
  const longestRun = Math.max(
    0,
    ...[...value.matchAll(/`+/g)].map((match) => match[0].length),
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

export function buildSpaceToolInstallPrompt(
  input: SpaceToolInstallPromptInput,
): string {
  const instruction = input.instruction;
  const fence = markdownFenceFor(instruction);
  const header = [
    "## 工具安装请求",
    "",
    `**工具**：${input.toolName}`,
    `**简介**：${input.toolDescription}`,
    `**来源**：Space「${input.spaceName}」`,
    "",
    "请使用 /tool-install skill，在当前设备上安装这个工具。请结合本机实际环境执行，并以该 Skill 的安全与安装规范为准。",
    "",
  ].join("\n");
  const instructionTerminator = instruction.endsWith("\n") ? "" : "\n";
  return `${header}\n${fence}\n${instruction}${instructionTerminator}${fence}\n\n完成后，请在当前对话中简要说明安装结果和实际验证情况。`;
}
