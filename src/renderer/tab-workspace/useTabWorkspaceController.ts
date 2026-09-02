import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TabBase, TabModuleDefinition, TabMountPolicy } from '@/tab-workspace/contracts';
import { resolveRestoreMount } from '@/tab-workspace/registry';
import {
  assertWorkspaceState,
  createWorkspaceState,
  focusWorkspaceTab,
  reorderWorkspaceTabs,
  revealWorkspaceTab,
  type CapturedTabIdentity,
  type TabWorkspaceState,
} from '@/tab-workspace/workspaceState';
import { runAfterNextPaint } from '@/utils/afterPaint';

type KindOf<TTab extends TabBase<string>> = TTab['view'];
type TabOfKind<TTab extends TabBase<string>, K extends KindOf<TTab>> = Extract<TTab, { view: K }>;

type ModuleShape<TTab extends TabBase<string>> = {
  readonly [K in KindOf<TTab>]: { readonly kind: K };
};

type ModuleIntent<TModule> = TModule extends {
  readonly open: {
    create(intent: infer TIntent, context: unknown): TabBase<string>;
  };
}
  ? TIntent
  : never;

export type OpenTabResult<TTab extends TabBase<string>> =
  | { kind: 'created'; tab: TTab }
  | { kind: 'focused'; tab: TTab }
  | { kind: 'reopened'; tab: TTab }
  | { kind: 'rejected'; reason: 'capacity' | 'unregistered' | 'invalid' };

export type ReplaceTabResult<TTab extends TabBase<string>> =
  | { kind: 'replaced'; tab: TTab; replaced: TTab }
  | { kind: 'rejected'; reason: 'stale' | 'invalid' };

export type DetachTabResult<TTab extends TabBase<string>> =
  | {
      kind: 'detached';
      tab: TTab;
      replacement: TTab | null;
      tabCount: number;
    }
  | { kind: 'no-op'; reason: 'missing' | 'stale' | 'protected' };

export type RestoreTabsResult<TTab extends TabBase<string>> =
  | { kind: 'applied'; addedTabs: readonly TTab[]; previousActiveTabId: string }
  | { kind: 'no-op' };

export interface ReplacePlan<TTab extends TabBase<string>> {
  captured: CapturedTabIdentity;
  replacement: TTab;
  mount: TabMountPolicy;
}

export interface RemovePlan {
  captured: CapturedTabIdentity;
}

export interface TabWorkspaceController<TTab extends TabBase<string>, TModules extends ModuleShape<TTab>> {
  readonly getSnapshot: () => TabWorkspaceState<TTab>;
  readonly nextIntentGeneration: () => number;
  readonly capture: (tabId: string) => CapturedTabIdentity | null;
  readonly focus: (tabId: string) => boolean;
  readonly append: (
    tab: TTab,
    options?: {
      mount?: TabMountPolicy;
      allowOverCapacity?: boolean;
      activate?: boolean;
    },
  ) => OpenTabResult<TTab>;
  readonly open: <K extends KindOf<TTab>>(
    kind: K,
    intent: ModuleIntent<TModules[K]>,
    options?: { allowOverCapacity?: boolean; source?: 'open' | 'restore' },
  ) => OpenTabResult<TabOfKind<TTab, K>>;
  readonly update: <K extends KindOf<TTab>>(
    tabId: string,
    expectedKind: K,
    updater: (tab: TabOfKind<TTab, K>) => TabOfKind<TTab, K>,
  ) => TabOfKind<TTab, K> | null;
  readonly replaceWith: <K extends KindOf<TTab>>(
    captured: CapturedTabIdentity,
    kind: K,
    intent: ModuleIntent<TModules[K]>,
    options?: { mount?: TabMountPolicy },
  ) => ReplaceTabResult<TTab>;
  readonly replaceMany: (plans: readonly ReplacePlan<TTab>[]) => number;
  readonly removeMany: (
    plans: readonly RemovePlan[],
    createFallback: () => TTab,
    preferredActiveTabId?: string,
  ) => number;
  readonly detach: (
    captured: CapturedTabIdentity,
    createFallback: () => TTab,
    onAccepted?: (tab: TTab) => void,
  ) => DetachTabResult<TTab>;
  readonly reorder: (activeId: string, overId: string) => void;
  readonly reveal: (tabId: string) => void;
  readonly restoreWithPolicy: (
    candidate: { tabs: readonly TTab[]; activeTabId: string | null },
    planner: (
      currentTabs: readonly TTab[],
      candidate: { tabs: readonly TTab[]; activeTabId: string | null },
    ) => { tabs: readonly TTab[]; activeTabId: string } | null,
  ) => RestoreTabsResult<TTab>;
}

interface UseTabWorkspaceOptions<TTab extends TabBase<string>, TModules extends ModuleShape<TTab>> {
  modules: TModules;
  initialTabs: readonly TTab[];
  initialActiveTabId: string;
  maxTabs: number;
  createId: () => string;
  isLastTabProtected: (tab: TTab) => boolean;
}

function isSameCapture<TTab extends TabBase<string>>(
  tab: TTab,
  captured: CapturedTabIdentity,
  identity: (tab: TTab) => string,
): boolean {
  return tab.id === captured.id && tab.view === captured.view && identity(tab) === captured.structuralIdentity;
}

export function useTabWorkspaceController<TTab extends TabBase<string>, const TModules extends ModuleShape<TTab>>({
  modules,
  initialTabs,
  initialActiveTabId,
  maxTabs,
  createId,
  isLastTabProtected,
}: UseTabWorkspaceOptions<TTab, TModules>): {
  state: TabWorkspaceState<TTab>;
  controller: TabWorkspaceController<TTab, TModules>;
} {
  const [state, setState] = useState(() => createWorkspaceState(initialTabs, initialActiveTabId));
  const stateRef = useRef(state);
  const intentGenerationRef = useRef(0);

  const identityFor = useCallback(
    (tab: TTab): string => {
      const definition = modules[tab.view as KindOf<TTab>] as unknown as TabModuleDefinition<
        TTab,
        unknown,
        unknown,
        unknown
      >;
      return definition.identity(tab);
    },
    [modules],
  );

  const commit = useCallback(
    (transition: (current: TabWorkspaceState<TTab>) => TabWorkspaceState<TTab>): TabWorkspaceState<TTab> => {
      const current = stateRef.current;
      const next = transition(current);
      if (next === current) return current;
      assertWorkspaceState(next);
      stateRef.current = next;
      setState(next);
      return next;
    },
    [],
  );

  const getSnapshot = useCallback(() => stateRef.current, []);
  const nextIntentGeneration = useCallback(() => {
    intentGenerationRef.current += 1;
    return intentGenerationRef.current;
  }, []);
  const capture = useCallback(
    (tabId: string): CapturedTabIdentity | null => {
      const tab = stateRef.current.tabs.find((candidate) => candidate.id === tabId);
      return tab
        ? {
            id: tab.id,
            view: tab.view,
            structuralIdentity: identityFor(tab),
          }
        : null;
    },
    [identityFor],
  );

  const focus = useCallback(
    (tabId: string): boolean => {
      const before = stateRef.current;
      const next = commit((current) => focusWorkspaceTab(current, tabId));
      return next !== before || next.activeTabId === tabId;
    },
    [commit],
  );

  const append = useCallback(
    (
      tab: TTab,
      options: {
        mount?: TabMountPolicy;
        allowOverCapacity?: boolean;
        activate?: boolean;
      } = {},
    ): OpenTabResult<TTab> => {
      let result: OpenTabResult<TTab> = {
        kind: 'rejected',
        reason: 'invalid',
      };
      commit((current) => {
        const existing = current.tabs.find((candidate) => candidate.id === tab.id);
        if (existing) {
          result = { kind: 'focused', tab: existing };
          return options.activate === false ? current : focusWorkspaceTab(current, existing.id);
        }
        if (!options.allowOverCapacity && current.tabs.length >= maxTabs) {
          result = { kind: 'rejected', reason: 'capacity' };
          return current;
        }
        const deferredMountTabIds = new Set(current.deferredMountTabIds);
        if (options.mount === 'deferred-content') deferredMountTabIds.add(tab.id);
        else deferredMountTabIds.delete(tab.id);
        result = { kind: 'created', tab };
        return {
          tabs: [...current.tabs, tab],
          activeTabId: options.activate === false ? current.activeTabId : tab.id,
          deferredMountTabIds,
        };
      });
      return result;
    },
    [commit, maxTabs],
  );

  const open = useCallback(
    <K extends KindOf<TTab>>(
      kind: K,
      intent: ModuleIntent<TModules[K]>,
      options: {
        allowOverCapacity?: boolean;
        source?: 'open' | 'restore';
      } = {},
    ): OpenTabResult<TabOfKind<TTab, K>> => {
      const definition = modules[kind] as unknown as TabModuleDefinition<
        TabOfKind<TTab, K>,
        ModuleIntent<TModules[K]>,
        unknown,
        unknown
      >;
      if (!definition) return { kind: 'rejected', reason: 'unregistered' };

      let result: OpenTabResult<TabOfKind<TTab, K>> = {
        kind: 'rejected',
        reason: 'invalid',
      };
      commit((current) => {
        const sameKindTabs = current.tabs.filter((tab): tab is TabOfKind<TTab, K> => tab.view === kind);
        const existing = definition.open.findExisting(sameKindTabs, intent);
        if (existing) {
          const reopened = definition.open.reopen?.(existing, intent) ?? existing;
          const changed = reopened !== existing;
          const tabs = changed
            ? current.tabs.map((tab) => (tab.id === existing.id ? (reopened as TTab) : tab))
            : current.tabs;
          result = changed ? { kind: 'reopened', tab: reopened } : { kind: 'focused', tab: existing };
          if (tabs === current.tabs && current.activeTabId === existing.id) {
            return current;
          }
          return { ...current, tabs, activeTabId: existing.id };
        }
        if (!options.allowOverCapacity && current.tabs.length >= maxTabs) {
          result = { kind: 'rejected', reason: 'capacity' };
          return current;
        }
        const tab = definition.open.create(intent, { id: createId() });
        const mount =
          options.source === 'restore'
            ? definition.initialMount({ source: 'restore', tab })
            : definition.initialMount({ source: 'open', intent });
        const deferredMountTabIds = new Set(current.deferredMountTabIds);
        if (mount === 'deferred-content') deferredMountTabIds.add(tab.id);
        else deferredMountTabIds.delete(tab.id);
        result = { kind: 'created', tab };
        return {
          tabs: [...current.tabs, tab as TTab],
          activeTabId: tab.id,
          deferredMountTabIds,
        };
      });
      return result;
    },
    [commit, createId, maxTabs, modules],
  );

  const update = useCallback(
    <K extends KindOf<TTab>>(
      tabId: string,
      expectedKind: K,
      updater: (tab: TabOfKind<TTab, K>) => TabOfKind<TTab, K>,
    ): TabOfKind<TTab, K> | null => {
      let accepted: TabOfKind<TTab, K> | null = null;
      commit((current) => {
        const index = current.tabs.findIndex((tab) => tab.id === tabId);
        const currentTab = current.tabs[index];
        if (!currentTab || currentTab.view !== expectedKind) return current;
        const nextTab = updater(currentTab as TabOfKind<TTab, K>);
        if (nextTab.id !== tabId || nextTab.view !== expectedKind) return current;
        accepted = nextTab;
        if (nextTab === currentTab) return current;
        const tabs = [...current.tabs];
        tabs[index] = nextTab as TTab;
        return { ...current, tabs };
      });
      return accepted;
    },
    [commit],
  );

  const replaceWith = useCallback(
    <K extends KindOf<TTab>>(
      captured: CapturedTabIdentity,
      kind: K,
      intent: ModuleIntent<TModules[K]>,
      options: { mount?: TabMountPolicy } = {},
    ): ReplaceTabResult<TTab> => {
      const definition = modules[kind] as unknown as TabModuleDefinition<
        TabOfKind<TTab, K>,
        ModuleIntent<TModules[K]>,
        unknown,
        unknown
      >;
      let result: ReplaceTabResult<TTab> = {
        kind: 'rejected',
        reason: 'stale',
      };
      commit((current) => {
        const index = current.tabs.findIndex((tab) => tab.id === captured.id);
        const previous = current.tabs[index];
        if (!previous || !isSameCapture(previous, captured, identityFor)) {
          return current;
        }
        const replacement = definition.open.create(intent, { id: previous.id });
        const tabs = [...current.tabs];
        tabs[index] = replacement as TTab;
        const deferredMountTabIds = new Set(current.deferredMountTabIds);
        const mount = options.mount ?? definition.initialMount({ source: 'open', intent });
        if (mount === 'deferred-content') deferredMountTabIds.add(previous.id);
        else deferredMountTabIds.delete(previous.id);
        result = {
          kind: 'replaced',
          tab: replacement as TTab,
          replaced: previous,
        };
        return {
          tabs,
          activeTabId: replacement.id,
          deferredMountTabIds,
        };
      });
      return result;
    },
    [commit, identityFor, modules],
  );

  const replaceMany = useCallback(
    (plans: readonly ReplacePlan<TTab>[]): number => {
      let replaced = 0;
      commit((current) => {
        const byId = new Map(plans.map((plan) => [plan.captured.id, plan]));
        const deferredMountTabIds = new Set(current.deferredMountTabIds);
        let changed = false;
        const tabs = current.tabs.map((tab) => {
          const plan = byId.get(tab.id);
          if (!plan || !isSameCapture(tab, plan.captured, identityFor)) return tab;
          changed = true;
          replaced += 1;
          if (plan.mount === 'deferred-content') deferredMountTabIds.add(tab.id);
          else deferredMountTabIds.delete(tab.id);
          return plan.replacement;
        });
        return changed ? { ...current, tabs, deferredMountTabIds } : current;
      });
      return replaced;
    },
    [commit, identityFor],
  );

  const removeMany = useCallback(
    (plans: readonly RemovePlan[], createFallback: () => TTab, preferredActiveTabId?: string): number => {
      let removed = 0;
      commit((current) => {
        const byId = new Map(plans.map((plan) => [plan.captured.id, plan]));
        const tabs = current.tabs.filter((tab) => {
          const plan = byId.get(tab.id);
          if (!plan || !isSameCapture(tab, plan.captured, identityFor)) return true;
          removed += 1;
          return false;
        });
        if (removed === 0) return current;
        const nextTabs = tabs.length > 0 ? tabs : [createFallback()];
        const liveIds = new Set(nextTabs.map((tab) => tab.id));
        const deferredMountTabIds = new Set([...current.deferredMountTabIds].filter((id) => liveIds.has(id)));
        return {
          tabs: nextTabs,
          activeTabId: liveIds.has(current.activeTabId)
            ? current.activeTabId
            : preferredActiveTabId && liveIds.has(preferredActiveTabId)
              ? preferredActiveTabId
              : nextTabs.at(-1)!.id,
          deferredMountTabIds,
        };
      });
      return removed;
    },
    [commit, identityFor],
  );

  const detach = useCallback(
    (
      captured: CapturedTabIdentity,
      createFallback: () => TTab,
      onAccepted?: (tab: TTab) => void,
    ): DetachTabResult<TTab> => {
      let result: DetachTabResult<TTab> = { kind: 'no-op', reason: 'missing' };
      commit((current) => {
        const index = current.tabs.findIndex((tab) => tab.id === captured.id);
        const tab = current.tabs[index];
        if (!tab) return current;
        if (!isSameCapture(tab, captured, identityFor)) {
          result = { kind: 'no-op', reason: 'stale' };
          return current;
        }
        if (current.tabs.length === 1 && isLastTabProtected(tab)) {
          result = { kind: 'no-op', reason: 'protected' };
          return current;
        }
        const remaining = current.tabs.filter((candidate) => candidate.id !== tab.id);
        const replacement = remaining.length === 0 ? createFallback() : null;
        const tabs = replacement ? [replacement] : remaining;
        const deferredMountTabIds = new Set(current.deferredMountTabIds);
        deferredMountTabIds.delete(tab.id);
        const activeTabId = current.activeTabId === tab.id ? tabs.at(-1)!.id : current.activeTabId;
        result = {
          kind: 'detached',
          tab,
          replacement,
          tabCount: tabs.length,
        };
        onAccepted?.(tab);
        return { tabs, activeTabId, deferredMountTabIds };
      });
      return result;
    },
    [commit, identityFor, isLastTabProtected],
  );

  const reorder = useCallback(
    (activeId: string, overId: string) => {
      commit((current) => reorderWorkspaceTabs(current, activeId, overId));
    },
    [commit],
  );
  const reveal = useCallback(
    (tabId: string) => {
      commit((current) => revealWorkspaceTab(current, tabId));
    },
    [commit],
  );
  const restoreWithPolicy = useCallback(
    (
      candidate: { tabs: readonly TTab[]; activeTabId: string | null },
      planner: (
        currentTabs: readonly TTab[],
        candidate: { tabs: readonly TTab[]; activeTabId: string | null },
      ) => { tabs: readonly TTab[]; activeTabId: string } | null,
    ): RestoreTabsResult<TTab> => {
      let result: RestoreTabsResult<TTab> = { kind: 'no-op' };
      commit((current) => {
        const plan = planner(current.tabs, candidate);
        if (!plan) return current;
        const currentIds = new Set(current.tabs.map((tab) => tab.id));
        const addedTabs = plan.tabs.filter((tab) => !currentIds.has(tab.id));
        if (addedTabs.length === 0) return current;
        const deferredMountTabIds = new Set(current.deferredMountTabIds);
        for (const tab of addedTabs) {
          if (resolveRestoreMount(modules, tab) === 'deferred-content') {
            deferredMountTabIds.add(tab.id);
          } else {
            deferredMountTabIds.delete(tab.id);
          }
        }
        result = {
          kind: 'applied',
          addedTabs,
          previousActiveTabId: current.activeTabId,
        };
        return {
          tabs: plan.tabs,
          activeTabId: plan.activeTabId,
          deferredMountTabIds,
        };
      });
      return result;
    },
    [commit, modules],
  );
  useEffect(() => {
    const activeTabId = state.activeTabId;
    if (!state.deferredMountTabIds.has(activeTabId)) return;
    runAfterNextPaint(() => {
      if (stateRef.current.activeTabId !== activeTabId) return;
      reveal(activeTabId);
    });
  }, [reveal, state.activeTabId, state.deferredMountTabIds]);

  const controller = useMemo<TabWorkspaceController<TTab, TModules>>(
    () => ({
      getSnapshot,
      nextIntentGeneration,
      capture,
      focus,
      append,
      open,
      update,
      replaceWith,
      replaceMany,
      removeMany,
      detach,
      reorder,
      reveal,
      restoreWithPolicy,
    }),
    [
      append,
      capture,
      detach,
      focus,
      getSnapshot,
      nextIntentGeneration,
      open,
      removeMany,
      reorder,
      replaceMany,
      replaceWith,
      restoreWithPolicy,
      reveal,
      update,
    ],
  );

  return { state, controller };
}
