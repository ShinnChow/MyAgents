export interface SpaceIssueAppRoute {
  version: 1;
  name: 'space.issue';
  params: {
    spaceId: string;
    issueId: string;
  };
}

export type AppRoute = SpaceIssueAppRoute;

export interface PendingAppRoute {
  generation: number;
  route: AppRoute;
}

const APP_ROUTE_ID = /^[A-Za-z0-9_-]{1,200}$/;

export function isAppRouteId(value: string): boolean {
  return APP_ROUTE_ID.test(value);
}

export function createSpaceIssueAppRoute(spaceId: string, issueId: string): SpaceIssueAppRoute {
  if (!isAppRouteId(spaceId) || !isAppRouteId(issueId)) {
    throw new Error('App route contains an invalid identifier');
  }
  return {
    version: 1,
    name: 'space.issue',
    params: { spaceId, issueId },
  };
}

export function serializeAppRoute(route: AppRoute): string {
  if (
    route.version !== 1
    || route.name !== 'space.issue'
    || !isAppRouteId(route.params.spaceId)
    || !isAppRouteId(route.params.issueId)
  ) {
    throw new Error('Unsupported app route');
  }
  return `myagents://open/v1/spaces/${encodeURIComponent(route.params.spaceId)}/issues/${encodeURIComponent(route.params.issueId)}`;
}

export function parseAppRouteUrl(raw: string): AppRoute | null {
  const value = raw.trim();
  if (!value || value.includes('?') || value.includes('#') || value.includes('\\')) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'myagents:'
    || url.hostname !== 'open'
    || url.port
    || url.username
    || url.password
  ) {
    return null;
  }
  const segments = url.pathname.split('/').slice(1);
  if (
    segments.length !== 5
    || segments[0] !== 'v1'
    || segments[1] !== 'spaces'
    || segments[3] !== 'issues'
  ) {
    return null;
  }
  try {
    const spaceId = decodeURIComponent(segments[2]);
    const issueId = decodeURIComponent(segments[4]);
    if (!isAppRouteId(spaceId) || !isAppRouteId(issueId)) return null;
    return createSpaceIssueAppRoute(spaceId, issueId);
  } catch {
    return null;
  }
}
