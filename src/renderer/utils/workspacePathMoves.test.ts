import { describe, expect, it } from 'vitest';
import { remapWorkspacePath } from './workspacePathMoves';

describe('committed workspace path moves', () => {
  it('maps exact files and descendants without touching neighboring names', () => {
    const moves = [{ oldPath: 'docs', newPath: 'archive/docs' }];
    expect(remapWorkspacePath('docs/nested/a.md', moves)).toBe('archive/docs/nested/a.md');
    expect(remapWorkspacePath('docs-old/a.md', moves)).toBe('docs-old/a.md');
    expect(remapWorkspacePath('docs.md', moves)).toBe('docs.md');
    expect(remapWorkspacePath('a.md', [{ oldPath: 'a.md', newPath: 'b.txt' }])).toBe('b.txt');
  });
  it('normalizes Windows separators and applies successive moves and undo', () => {
    const moves = [{ oldPath: 'docs', newPath: 'archive/docs' }, { oldPath: 'archive/docs', newPath: 'final' }];
    expect(remapWorkspacePath('docs\\nested\\a.md', moves)).toBe('final/nested/a.md');
    expect(remapWorkspacePath('final/nested/a.md', [{ oldPath: 'final', newPath: 'docs' }])).toBe('docs/nested/a.md');
    expect(remapWorkspacePath('final/nested/a.md', moves)).toBe('final/nested/a.md');
  });
});
