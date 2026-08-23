const LEGACY_VERIFY_HEADING = '# verify.md';

/**
 * Preserve the user's Task body verbatim apart from trailing whitespace, then
 * append the legacy verification document using the intentionally-simple
 * compatibility shape agreed for v0.4.10.
 */
export function mergeTaskMarkdown(taskMarkdown: string, verifyMarkdown?: string | null): string {
  const task = taskMarkdown.trimEnd();
  const verify = verifyMarkdown?.trim();
  if (!verify) return task;
  if (hasLegacyVerifySection(task)) return task;
  return `${task}\n\n${LEGACY_VERIFY_HEADING}\n\n${verify}`;
}

export function hasLegacyVerifySection(taskMarkdown: string): boolean {
  return taskMarkdown
    .split(/\r?\n/u)
    .some(line => line.trim() === LEGACY_VERIFY_HEADING);
}
