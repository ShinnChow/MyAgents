import { describe, expect, it } from 'vitest';

import {
  createSpaceIssueAppRoute,
  parseAppRouteUrl,
  serializeAppRoute,
} from './appRoute';

describe('AppRoute', () => {
  it('round-trips the only supported v1 route', () => {
    const route = createSpaceIssueAppRoute('space_1', 'issue-2');
    expect(serializeAppRoute(route)).toBe(
      'myagents://open/v1/spaces/space_1/issues/issue-2',
    );
    expect(parseAppRouteUrl(serializeAppRoute(route))).toEqual(route);
  });

  it.each([
    'myagents://attachment/session/file.png',
    'myagents://tool-attachment/session/turn/file.png',
    'myagents-resource://attachment/session/file.png',
    'myagents://evil/v1/spaces/a/issues/b',
    'myagents://open/v2/spaces/a/issues/b',
    'myagents://open/v1/spaces/a/issues/b/extra',
    'myagents://open/v1/spaces/a/issues/b?prompt=run',
    'myagents://open/v1/spaces/a/issues/b#fragment',
    'myagents://open/v1/spaces/a%2Fb/issues/c',
    'myagents://open/v1/spaces/a/issues/%ZZ',
    'myagents://user@open/v1/spaces/a/issues/b',
    'myagents://open:42/v1/spaces/a/issues/b',
  ])('rejects unsupported or ambiguous input: %s', (value) => {
    expect(parseAppRouteUrl(value)).toBeNull();
  });

  it('bounds identifiers before serialization', () => {
    expect(() => createSpaceIssueAppRoute('', 'issue')).toThrow();
    expect(() => createSpaceIssueAppRoute('space', 'x'.repeat(201))).toThrow();
  });
});
