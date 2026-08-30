export interface SettingsUpdaterBinding {
  updateReady: boolean;
  updateVersion: string | null;
  updateChecking: boolean;
  updateDownloading: boolean;
  updateInstalling: boolean;
  updatePreparing: boolean;
  onCheckForUpdate: () => Promise<'up-to-date' | 'downloading' | 'error'>;
  onRestartAndUpdate: () => void;
}
