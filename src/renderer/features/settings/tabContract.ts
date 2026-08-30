import type { TabBase } from '@/tab-workspace/contracts';

export interface SettingsNavigationIntent {
  generation: number;
  section?: string;
}

export interface SettingsTab extends TabBase<'settings'> {
  navigationIntent?: SettingsNavigationIntent;
}
