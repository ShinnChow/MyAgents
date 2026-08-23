import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dialogSource = readFileSync(
  resolve(import.meta.dirname, 'TemplateLibraryDialog.tsx'),
  'utf8',
);

describe('TemplateLibraryDialog layout contract', () => {
  it('contains long form values inside the fixed-width details pane', () => {
    expect(dialogSource).toContain(
      'flex min-h-[420px] min-w-0 flex-1 flex-col overflow-hidden',
    );
    expect(dialogSource).toContain(
      'min-w-0 truncate text-sm font-medium text-[var(--ink)]',
    );
  });

  it('keeps the Create Agent action outside the scrollable form content', () => {
    const scrollableForm = dialogSource.indexOf(
      'min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain',
    );
    const fixedFooter = dialogSource.indexOf(
      'flex shrink-0 justify-end px-6 pb-6 pt-2',
    );
    const createAction = dialogSource.indexOf(
      "{t('templateLibrary.createAgent')}",
    );

    expect(scrollableForm).toBeGreaterThan(-1);
    expect(fixedFooter).toBeGreaterThan(scrollableForm);
    expect(createAction).toBeGreaterThan(fixedFooter);
  });
});
