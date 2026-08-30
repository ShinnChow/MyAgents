import type { TabBase } from '@/tab-workspace/contracts';

export interface LauncherTab extends TabBase<'launcher'> {
  /** Runtime-only projection of the selected workspace. */
  launcherWorkspacePath?: string | null;
}
