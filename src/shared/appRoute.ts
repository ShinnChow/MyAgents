export interface SpaceIssueAppRoute {
  version: 1;
  name: 'space.issue';
  params: {
    spaceId: string;
    issueId: string;
  };
}

export interface TaskCommentAppRoute {
  version: 1;
  name: 'task.comment';
  params: {
    taskId: string;
    commentId: string;
  };
}

export type AppRoute = SpaceIssueAppRoute | TaskCommentAppRoute;

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

export function createTaskCommentAppRoute(taskId: string, commentId: string): TaskCommentAppRoute {
  if (!isAppRouteId(taskId) || !isAppRouteId(commentId)) {
    throw new Error('App route contains an invalid identifier');
  }
  return {
    version: 1,
    name: 'task.comment',
    params: { taskId, commentId },
  };
}

export function serializeAppRoute(route: AppRoute): string {
  if (route.version !== 1) {
    throw new Error('Unsupported app route');
  }
  if (route.name === 'space.issue') {
    if (!isAppRouteId(route.params.spaceId) || !isAppRouteId(route.params.issueId)) {
      throw new Error('Unsupported app route');
    }
    return `myagents://open/v1/spaces/${encodeURIComponent(route.params.spaceId)}/issues/${encodeURIComponent(route.params.issueId)}`;
  }
  if (!isAppRouteId(route.params.taskId) || !isAppRouteId(route.params.commentId)) {
    throw new Error('Unsupported app route');
  }
  return `myagents://open/v1/tasks/${encodeURIComponent(route.params.taskId)}/comments/${encodeURIComponent(route.params.commentId)}`;
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
  if (segments.length !== 5 || segments[0] !== 'v1') {
    return null;
  }
  try {
    const parentId = decodeURIComponent(segments[2]);
    const childId = decodeURIComponent(segments[4]);
    if (!isAppRouteId(parentId) || !isAppRouteId(childId)) return null;
    if (segments[1] === 'spaces' && segments[3] === 'issues') {
      return createSpaceIssueAppRoute(parentId, childId);
    }
    if (segments[1] === 'tasks' && segments[3] === 'comments') {
      return createTaskCommentAppRoute(parentId, childId);
    }
    return null;
  } catch {
    return null;
  }
}
