/** Exact, ordered path transitions returned by successful workspace mutations. */
export interface WorkspacePathMove {
  oldPath: string;
  newPath: string;
}

export function remapWorkspacePath(path: string, moves: readonly WorkspacePathMove[]): string {
  let next = path.replace(/\\/g, '/');
  for (const move of moves) {
    const from = move.oldPath.replace(/\\/g, '/');
    const to = move.newPath.replace(/\\/g, '/');
    if (next === from || next.startsWith(`${from}/`)) {
      next = to + next.slice(from.length);
    }
  }
  return next;
}
