export type WorkspacePanelMode = 'inline' | 'overlay';

export type WorkspacePanelMotion = 'expand' | 'collapse' | null;

export interface WorkspacePanelDisclosureState {
  visible: boolean;
  mounted: boolean;
  motion: WorkspacePanelMotion;
}

export type WorkspacePanelDisclosureAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'settle-close' };

export function createWorkspacePanelDisclosureState(
  visible: boolean,
): WorkspacePanelDisclosureState {
  return {
    visible,
    mounted: visible,
    motion: null,
  };
}

/**
 * Owns the workspace panel's visibility and paint-only transition as one state
 * machine. `open` is intentionally idempotent: navigation can require an
 * already-visible tree without inventing another expand lifecycle edge.
 */
export function reduceWorkspacePanelDisclosure(
  state: WorkspacePanelDisclosureState,
  action: WorkspacePanelDisclosureAction,
): WorkspacePanelDisclosureState {
  switch (action.type) {
    case 'open':
      if (state.visible) return state;
      return { visible: true, mounted: true, motion: 'expand' };
    case 'close':
      if (!state.visible) return state;
      return { visible: false, mounted: true, motion: 'collapse' };
    case 'settle-close':
      if (state.visible || state.motion !== 'collapse' || !state.mounted) return state;
      return { ...state, mounted: false };
  }
}

export const DEFAULT_WORKSPACE_LAYOUT_METRICS = {
  contentMinWidthPx: 640,
  sidebarMinWidthPx: 320,
} as const;

export interface WorkspacePanelModeInput {
  viewportWidthPx: number;
  splitPanelVisible: boolean;
  splitRatio: number;
  contentMinWidthPx: number;
  sidebarMinWidthPx: number;
}

export function resolveWorkspacePanelMode(input: WorkspacePanelModeInput): WorkspacePanelMode {
  const splitRatio = input.splitPanelVisible
    ? Math.min(Math.max(input.splitRatio, 0), 1)
    : 1;
  const leftPaneWidthPx = input.viewportWidthPx * splitRatio;
  const chatWidthWithInlineWorkspacePx = leftPaneWidthPx - input.sidebarMinWidthPx;
  return chatWidthWithInlineWorkspacePx >= input.contentMinWidthPx ? 'inline' : 'overlay';
}

/** The actively presented Chat-owned browser fills Chat when no split lane exists. */
export function shouldPresentBrowserFullscreen(input: {
  browserPresented: boolean;
  splitViewEnabled: boolean;
  narrowLayout: boolean;
}): boolean {
  return input.browserPresented && (!input.splitViewEnabled || input.narrowLayout);
}

/** Select the surviving split view after the browser resource is destroyed. */
export function nextSplitViewAfterBrowserClose(input: {
  terminalVisible: boolean;
  fileVisible: boolean;
}): 'terminal' | 'file' | null {
  if (input.terminalVisible) return 'terminal';
  if (input.fileVisible) return 'file';
  return null;
}
