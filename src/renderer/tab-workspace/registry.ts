import type {
  TabBase,
  TabChromeContext,
  TabChromeModel,
  TabModuleDefinition,
  TabMountPolicy,
  ModuleTab,
  TabPersistenceCodec,
} from '@/tab-workspace/contracts';

type DefinitionKeyShape<TTab extends TabBase<string>> = {
  readonly [K in TTab['view']]: { readonly kind: K };
};

type ValidateDefinitions<TTab extends TabBase<string>, TModules extends DefinitionKeyShape<TTab>> = {
  readonly [K in TTab['view']]: ModuleTab<TModules[K]> extends Extract<TTab, { view: K }>
    ? Extract<TTab, { view: K }> extends ModuleTab<TModules[K]>
      ? TModules[K]
      : never
    : never;
};

type RejectExtraDefinitions<TTab extends TabBase<string>, TModules> = {
  readonly [K in Exclude<keyof TModules, TTab['view']>]: never;
};

export type RegisteredPersistenceWire<TModules> = {
  [K in keyof TModules]: TModules[K] extends {
    readonly persistence: TabPersistenceCodec<infer _TTab, infer TWire>;
  }
    ? TWire
    : never;
}[keyof TModules];

export interface TabPersistenceProjection<TWire> {
  value: TWire;
  resourceIdentity: string;
}

/**
 * Close a source edition's Tab union over exactly one immutable module per
 * kind. Object keys make duplicates impossible; the mapped constraint makes a
 * missing kind or key/definition mismatch a type error.
 */
export function defineTabModules<TTab extends TabBase<string>>() {
  return <const TModules extends DefinitionKeyShape<TTab>>(
    modules: TModules & ValidateDefinitions<TTab, TModules> & RejectExtraDefinitions<TTab, TModules>,
  ): Readonly<TModules> => {
    for (const key of Object.keys(modules) as Array<keyof TModules & string>) {
      const definition = modules[key] as { readonly kind: string; readonly open?: object; readonly persistence?: object };
      if (definition.kind !== key) {
        throw new Error(`Tab module key "${key}" does not match definition kind "${definition.kind}"`);
      }
      const open = definition.open;
      const persistence = definition.persistence;
      if (open) Object.freeze(open);
      if (persistence) Object.freeze(persistence);
      Object.freeze(definition);
    }
    return Object.freeze(modules);
  };
}

export function getTabModule<TModules extends Record<string, { readonly kind: string }>, K extends keyof TModules>(
  modules: TModules,
  kind: K,
): TModules[K] {
  return modules[kind];
}

/** The registry construction above proves key/kind/payload correlation. This
 * helper is the single erased boundary needed to call a definition selected by
 * a runtime discriminant. Callers never cast feature payloads themselves. */
function definitionForTab<TTab extends TabBase<string>>(
  modules: Record<string, { readonly kind: string }>,
  tab: TTab,
): TabModuleDefinition<TTab, unknown, unknown, unknown> {
  return modules[tab.view] as unknown as TabModuleDefinition<TTab, unknown, unknown, unknown>;
}

export function resolveTabChrome<TTab extends TabBase<string>>(
  modules: Record<TTab['view'], { readonly kind: TTab['view'] }>,
  tab: TTab,
  context: TabChromeContext,
): TabChromeModel {
  return definitionForTab(modules, tab).chrome(tab, context);
}

export function resolveInitialMount<TTab extends TabBase<string>>(
  modules: Record<TTab['view'], { readonly kind: TTab['view'] }>,
  tab: TTab,
  intent: unknown,
): TabMountPolicy {
  return definitionForTab(modules, tab).initialMount({ source: 'open', intent });
}

export function resolveRestoreMount<TTab extends TabBase<string>>(
  modules: Record<TTab['view'], { readonly kind: TTab['view'] }>,
  tab: TTab,
): TabMountPolicy {
  return definitionForTab(modules, tab).initialMount({ source: 'restore', tab });
}

export function resolveTabIdentity<TTab extends TabBase<string>>(
  modules: Record<TTab['view'], { readonly kind: TTab['view'] }>,
  tab: TTab,
): string {
  return definitionForTab(modules, tab).identity(tab);
}

type ErasedPersistenceCodec = TabPersistenceCodec<TabBase<string>, unknown>;

function persistenceCodecForTab<TTab extends TabBase<string>>(
  modules: Record<TTab['view'], { readonly kind: TTab['view'] }>,
  tab: TTab,
): ErasedPersistenceCodec | null {
  return (definitionForTab(modules, tab).persistence as ErasedPersistenceCodec | undefined) ?? null;
}

/** Project through the selected module's opt-in codec while keeping wire
 * versioning, validation, deduplication and storage policy outside the registry. */
export function serializeRegisteredTab<
  TTab extends TabBase<string>,
  TModules extends Record<TTab['view'], { readonly kind: TTab['view'] }>,
>(modules: TModules, tab: TTab): TabPersistenceProjection<RegisteredPersistenceWire<TModules>> | null {
  const codec = persistenceCodecForTab(modules, tab);
  if (!codec) return null;
  const value = codec.serialize(tab);
  if (value === null) return null;
  return {
    value: value as RegisteredPersistenceWire<TModules>,
    resourceIdentity: codec.resourceIdentity(value),
  };
}

/** Parse untrusted wire input only through codecs explicitly present in this
 * edition's closed composition. Unknown or non-persistent kinds fail closed. */
export function parseRegisteredTab<
  TTab extends TabBase<string>,
  TModules extends Record<TTab['view'], { readonly kind: TTab['view'] }>,
>(modules: TModules, value: unknown): TabPersistenceProjection<RegisteredPersistenceWire<TModules>> | null {
  for (const definition of Object.values(modules) as Array<{ readonly persistence?: ErasedPersistenceCodec }>) {
    const codec = definition.persistence;
    if (!codec) continue;
    const parsed = codec.parse(value);
    if (parsed === null) continue;
    return {
      value: parsed as RegisteredPersistenceWire<TModules>,
      resourceIdentity: codec.resourceIdentity(parsed),
    };
  }
  return null;
}

export function hydrateRegisteredTab<
  TTab extends TabBase<string>,
  TModules extends Record<TTab['view'], { readonly kind: TTab['view'] }>,
>(modules: TModules, value: unknown): TTab | null {
  for (const definition of Object.values(modules) as Array<{ readonly persistence?: ErasedPersistenceCodec }>) {
    const codec = definition.persistence;
    if (!codec) continue;
    const parsed = codec.parse(value);
    if (parsed !== null) return codec.hydrate(parsed) as TTab;
  }
  return null;
}
