import { memo, type ComponentType } from 'react';

import type { Tab, TabKind, TabOf } from '@/types/tab';
import type { TabRenderProps } from '@/tab-workspace/contracts';
import { builtinTabModules, type BuiltinTabBindings } from '@/tab-workspace/builtinComposition';

export type { BuiltinTabBindings } from '@/tab-workspace/builtinComposition';

function rendererFor<K extends TabKind>(kind: K): ComponentType<TabRenderProps<TabOf<K>, BuiltinTabBindings[K]>> {
  return builtinTabModules[kind].render as unknown as ComponentType<TabRenderProps<TabOf<K>, BuiltinTabBindings[K]>>;
}

function renderSlot<K extends TabKind>(
  tab: TabOf<K>,
  isActive: boolean,
  isDeferred: boolean,
  bindings: BuiltinTabBindings,
) {
  const Renderer = rendererFor(tab.view);
  return <Renderer tab={tab} isActive={isActive} isDeferred={isDeferred} binding={bindings[tab.view]} />;
}

export interface BuiltinTabSlotProps {
  tab: Tab;
  isActive: boolean;
  isDeferred: boolean;
  bindings: BuiltinTabBindings;
}

function sameBindingForVisibleProjection(previous: BuiltinTabSlotProps, next: BuiltinTabSlotProps): boolean {
  if (previous.tab.view !== next.tab.view) return false;
  if (next.tab.view === 'chat' && !next.isActive) {
    return previous.bindings.chat.sessionNotificationBadgeCounts === next.bindings.chat.sessionNotificationBadgeCounts;
  }
  if (next.tab.view === 'launcher') {
    return (
      previous.bindings.launcher.isStarting(next.tab.id) === next.bindings.launcher.isStarting(next.tab.id) &&
      previous.bindings.launcher.startError(next.tab.id) === next.bindings.launcher.startError(next.tab.id)
    );
  }
  return previous.bindings[previous.tab.view] === next.bindings[next.tab.view];
}

/** Runtime dispatch is centralized at the registry's proven key/kind boundary;
 * App and the individual renderer never enumerate Tab kinds. */
export const BuiltinTabSlot = memo(
  function BuiltinTabSlot({ tab, isActive, isDeferred, bindings }: BuiltinTabSlotProps) {
    return (
      <div
        className={`absolute inset-0 ${isActive ? '' : 'pointer-events-none invisible'}`}
        style={isActive ? undefined : { contentVisibility: 'hidden' }}
      >
        {renderSlot(tab, isActive, isDeferred, bindings)}
      </div>
    );
  },
  (previous, next) =>
    previous.tab === next.tab &&
    previous.isActive === next.isActive &&
    previous.isDeferred === next.isDeferred &&
    sameBindingForVisibleProjection(previous, next),
);
