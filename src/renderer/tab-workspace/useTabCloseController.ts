import { useCallback, useEffect, useRef } from 'react';

import type { TabBase } from '@/tab-workspace/contracts';
import type { DetachTabResult, TabWorkspaceController } from '@/tab-workspace/useTabWorkspaceController';

export type TabCloseAdmission = 'allow' | 'blocked';

export interface TabLifecycleAdapter<TTab extends TabBase<string>, TReason extends string = string> {
  prepareClose?: (tab: TTab, reason: TReason) => TabCloseAdmission | Promise<TabCloseAdmission>;
  afterDetach?: (tab: TTab, reason: TReason) => void | Promise<void>;
}

export type TabLifecycleMap<TTab extends TabBase<string>, TReason extends string> = {
  readonly [K in TTab['view']]?: TabLifecycleAdapter<Extract<TTab, { view: K }>, TReason>;
};

interface CloseControllerOptions<
  TTab extends TabBase<string>,
  TModules extends { readonly [K in TTab['view']]: { readonly kind: K } },
  TReason extends string,
> {
  workspace: TabWorkspaceController<TTab, TModules>;
  lifecycle: TabLifecycleMap<TTab, TReason>;
  defaultReason: TReason;
  createFallback: () => TTab;
  onBeforeDetach?: (tab: TTab, reason: TReason) => void;
  onDetached?: (result: Extract<DetachTabResult<TTab>, { kind: 'detached' }>, reason: TReason) => void;
  onCleanupError?: (tab: TTab, error: unknown) => void;
}

export function useTabCloseController<
  TTab extends TabBase<string>,
  TModules extends { readonly [K in TTab['view']]: { readonly kind: K } },
  TReason extends string,
>({
  workspace,
  lifecycle,
  defaultReason,
  createFallback,
  onBeforeDetach,
  onDetached,
  onCleanupError,
}: CloseControllerOptions<TTab, TModules, TReason>) {
  const optionsRef = useRef({
    lifecycle,
    defaultReason,
    createFallback,
    onBeforeDetach,
    onDetached,
    onCleanupError,
  });
  useEffect(() => {
    optionsRef.current = {
      lifecycle,
      defaultReason,
      createFallback,
      onBeforeDetach,
      onDetached,
      onCleanupError,
    };
  }, [createFallback, defaultReason, lifecycle, onBeforeDetach, onCleanupError, onDetached]);
  const inFlightRef = useRef(new Set<string>());

  return useCallback(
    (tabId: string, reason?: TReason): void => {
      const closeReason = reason ?? optionsRef.current.defaultReason;
      if (inFlightRef.current.has(tabId)) return;
      const captured = workspace.capture(tabId);
      if (!captured) return;
      const tab = workspace.getSnapshot().tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      const adapter = optionsRef.current.lifecycle[tab.view as TTab['view']] as
        | TabLifecycleAdapter<TTab, TReason>
        | undefined;
      const detach = () => {
        const result = workspace.detach(captured, optionsRef.current.createFallback, (acceptedTab) =>
          optionsRef.current.onBeforeDetach?.(acceptedTab, closeReason),
        );
        if (result.kind !== 'detached') return;
        optionsRef.current.onDetached?.(result, closeReason);
        if (!adapter?.afterDetach) return;
        Promise.resolve(adapter.afterDetach(tab, closeReason)).catch((error) =>
          optionsRef.current.onCleanupError?.(tab, error),
        );
      };

      const admission = adapter?.prepareClose?.(tab, closeReason) ?? 'allow';
      if (!(admission instanceof Promise)) {
        if (admission === 'allow') detach();
        return;
      }

      inFlightRef.current.add(tabId);
      void admission
        .then((result) => {
          if (result === 'allow') detach();
        })
        .catch((error) => optionsRef.current.onCleanupError?.(tab, error))
        .finally(() => inFlightRef.current.delete(tabId));
    },
    [workspace],
  );
}
