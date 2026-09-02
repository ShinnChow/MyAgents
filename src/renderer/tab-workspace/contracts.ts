import type { ComponentType } from 'react';

/** Shell-owned minimum contract. Feature payloads extend this leaf type; the
 * generic workspace must never import an edition's closed Tab union. */
export interface TabBase<K extends string> {
  readonly id: string;
  readonly view: K;
  readonly title: string;
}

export type TabMountPolicy = 'immediate' | 'deferred-content';

export interface TabChromeModel {
  title: string;
  subtitle?: string;
  /** Include subtitle even when it equals title (Chat workspace context). */
  contextualSubtitle?: boolean;
  isGenerating?: boolean;
  hasUnread?: boolean;
  recordingState?: 'recording' | 'paused';
}

export interface TabChromeContext {
  t: (key: string, options?: Record<string, unknown>) => string;
}

export interface TabCreateContext {
  id: string;
}

export type TabMountContext<TTab extends TabBase<string>, TIntent> =
  | { source: 'open'; intent: TIntent }
  | { source: 'restore'; tab: TTab };

export interface TabRenderProps<TTab extends TabBase<string>, TBinding> {
  tab: TTab;
  isActive: boolean;
  isDeferred: boolean;
  binding: TBinding;
}

export interface StructuralOpenPolicy<TTab extends TabBase<string>, TIntent> {
  findExisting(sameKindTabs: readonly TTab[], intent: TIntent): TTab | undefined;
  create(intent: TIntent, context: TabCreateContext): TTab;
  reopen?(current: TTab, intent: TIntent): TTab;
}

export interface TabPersistenceCodec<TTab extends TabBase<string>, TWire> {
  serialize(tab: TTab): TWire | null;
  parse(value: unknown): TWire | null;
  hydrate(value: TWire): TTab;
  resourceIdentity(value: TWire): string;
}

export interface TabModuleDefinition<TTab extends TabBase<string>, TIntent, TBinding, TWire = never> {
  readonly kind: TTab['view'];
  readonly render: ComponentType<TabRenderProps<TTab, TBinding>>;
  readonly chrome: (tab: TTab, context: TabChromeContext) => TabChromeModel;
  readonly identity: (tab: TTab) => string;
  readonly open: StructuralOpenPolicy<TTab, TIntent>;
  readonly initialMount: (context: TabMountContext<TTab, TIntent>) => TabMountPolicy;
  readonly persistence?: TabPersistenceCodec<TTab, TWire>;
}

export type TabOfKind<TTab extends TabBase<string>, K extends TTab['view']> = Extract<TTab, { view: K }>;

export type ModuleKinds<TModules> = keyof TModules & string;

export type ModuleTab<TModule> =
  TModule extends TabModuleDefinition<infer TTab, infer _TIntent, infer _TBinding, infer _TWire> ? TTab : never;

export type ModuleIntent<TModule> =
  TModule extends TabModuleDefinition<infer _TTab, infer TIntent, infer _TBinding, infer _TWire> ? TIntent : never;

export type ModuleBinding<TModule> =
  TModule extends TabModuleDefinition<infer _TTab, infer _TIntent, infer TBinding, infer _TWire> ? TBinding : never;

export type ModulePersistenceWire<TModule> =
  TModule extends TabModuleDefinition<infer _TTab, infer _TIntent, infer _TBinding, infer TWire> ? TWire : never;
