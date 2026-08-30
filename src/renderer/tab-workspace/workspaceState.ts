import { arrayMove } from '@dnd-kit/sortable';

import type { TabBase } from '@/tab-workspace/contracts';

export interface TabWorkspaceState<TTab extends TabBase<string>> {
  readonly tabs: readonly TTab[];
  readonly activeTabId: string;
  readonly deferredMountTabIds: ReadonlySet<string>;
}

export interface CapturedTabIdentity {
  readonly id: string;
  readonly view: string;
  readonly structuralIdentity: string;
}

export function assertWorkspaceState<TTab extends TabBase<string>>(state: TabWorkspaceState<TTab>): void {
  if (state.tabs.length === 0) {
    throw new Error('Tab workspace must contain at least one tab');
  }
  const ids = new Set(state.tabs.map((tab) => tab.id));
  if (ids.size !== state.tabs.length) {
    throw new Error('Tab workspace contains duplicate tab ids');
  }
  if (!ids.has(state.activeTabId)) {
    throw new Error('Tab workspace activeTabId must reference a live tab');
  }
  for (const id of state.deferredMountTabIds) {
    if (!ids.has(id)) {
      throw new Error('Tab workspace deferred ids must reference live tabs');
    }
  }
}

export function createWorkspaceState<TTab extends TabBase<string>>(
  tabs: readonly TTab[],
  activeTabId: string,
  deferredMountTabIds: ReadonlySet<string> = new Set(),
): TabWorkspaceState<TTab> {
  const state = { tabs, activeTabId, deferredMountTabIds };
  assertWorkspaceState(state);
  return state;
}

export function focusWorkspaceTab<TTab extends TabBase<string>>(
  state: TabWorkspaceState<TTab>,
  tabId: string,
): TabWorkspaceState<TTab> {
  if (state.activeTabId === tabId) return state;
  if (!state.tabs.some((tab) => tab.id === tabId)) return state;
  return { ...state, activeTabId: tabId };
}

export function revealWorkspaceTab<TTab extends TabBase<string>>(
  state: TabWorkspaceState<TTab>,
  tabId: string,
): TabWorkspaceState<TTab> {
  if (!state.deferredMountTabIds.has(tabId)) return state;
  const deferredMountTabIds = new Set(state.deferredMountTabIds);
  deferredMountTabIds.delete(tabId);
  return { ...state, deferredMountTabIds };
}

export function reorderWorkspaceTabs<TTab extends TabBase<string>>(
  state: TabWorkspaceState<TTab>,
  activeId: string,
  overId: string,
): TabWorkspaceState<TTab> {
  const oldIndex = state.tabs.findIndex((tab) => tab.id === activeId);
  const newIndex = state.tabs.findIndex((tab) => tab.id === overId);
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return state;
  return { ...state, tabs: arrayMove([...state.tabs], oldIndex, newIndex) };
}
