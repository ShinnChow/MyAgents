import { describe, expect, it } from 'vitest';
import { hasLegacyVerifySection, mergeTaskMarkdown } from './taskDocuments';

describe('mergeTaskMarkdown', () => {
  it('appends non-empty legacy verification content using the compatibility heading', () => {
    expect(mergeTaskMarkdown('Do the work.  \n', '  - run tests\n'))
      .toBe('Do the work.\n\n# verify.md\n\n- run tests');
  });

  it('leaves a task unchanged when verification is empty', () => {
    expect(mergeTaskMarkdown('Do the work.\n', '  ')).toBe('Do the work.');
  });

  it('is idempotent once the compatibility heading exists', () => {
    const merged = mergeTaskMarkdown('Do the work.', '- run tests');
    expect(mergeTaskMarkdown(merged, '- run tests')).toBe(merged);
    expect(hasLegacyVerifySection(merged)).toBe(true);
  });
});
