import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = resolve(import.meta.dirname, '..');

function source(relativePath: string): string {
  return readFileSync(resolve(rendererRoot, relativePath), 'utf8');
}

describe('Tab workspace dependency direction', () => {
  it('keeps generic shell contracts independent from builtin edition and features, including type-only imports', () => {
    const genericShellFiles = [
      'tab-workspace/contracts.ts',
      'tab-workspace/registry.ts',
      'tab-workspace/workspaceState.ts',
      'tab-workspace/useTabWorkspaceController.ts',
      'tab-workspace/useTabCloseController.ts',
    ];

    for (const file of genericShellFiles) {
      const contents = source(file);
      expect(contents, file).not.toMatch(/from ['"]@\/(?:types\/tab|features\/)/);
    }
  });

  it('keeps feature Tab contracts and implementations independent from the builtin Tab aggregator', () => {
    const featureFiles = [
      'features/launcher/tabContract.ts',
      'features/launcher/tabModule.tsx',
      'features/chat/tabContract.ts',
      'features/chat/tabModule.tsx',
      'features/chat/tabLifecycle.ts',
      'features/chat/tabPersistence.ts',
      'features/settings/tabContract.ts',
      'features/settings/tabModule.tsx',
      'features/capabilities/tabContract.ts',
      'features/capabilities/tabModule.tsx',
      'features/task-center/tabContract.ts',
      'features/task-center/tabModule.tsx',
      'features/space/tabContract.ts',
      'features/space/tabModule.tsx',
      'features/record/tabContract.ts',
      'features/record/tabModule.tsx',
      'features/record/tabPersistence.ts',
      'features/record/tabProjection.ts',
      'features/record/useRecordTabLifecycle.tsx',
    ];

    for (const file of featureFiles) {
      expect(source(file), file).not.toContain("from '@/types/tab'");
    }
  });

  it('derives binding and lifecycle composition from the one builtin module map', () => {
    const composition = source('tab-workspace/builtinComposition.ts');
    const slot = source('tab-workspace/BuiltinTabSlot.tsx');

    expect(composition).toContain('[K in keyof BuiltinTabModules]');
    expect(composition).toContain('composeBuiltinTabBindings');
    expect(composition).toContain('composeBuiltinTabLifecycle');
    expect(slot).not.toMatch(/from ['"]@\/features\//);
  });
});
