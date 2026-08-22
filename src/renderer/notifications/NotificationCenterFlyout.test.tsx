import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  copy: vi.fn(async () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@/utils/clipboard', () => ({ copyPlainText: mocks.copy }));

import { i18n } from '@/i18n';
import NotificationCenterFlyout, {
  formatNotificationTime,
  localizedAnnouncement,
} from './NotificationCenterFlyout';
import type { NotificationSnapshot } from './notificationCenter';

const announcement = {
  id: 'notice-1',
  kind: 'announcement' as const,
  createdAt: '2026-08-16T08:00:00.000Z',
  isRead: false,
  summaryZh: '中文公告',
  summaryOther: 'English announcement',
  target: { kind: 'external_url' as const, url: 'http://example.com/detail' },
};

const comment = {
  id: 'notice-2',
  kind: 'space_issue_comment' as const,
  createdAt: '2026-08-16T08:01:00.000Z',
  isRead: false,
  commentId: 'comment-1',
  actor: { type: 'user' as const, id: 'user-2', displayName: 'Ethan' },
  spaceId: 'space-1',
  issue: { id: 'issue-7', number: 7, title: '通知链路' },
  excerpt: '我补充了一条评论',
  target: {
    kind: 'app_route' as const,
    route: { version: 1 as const, name: 'space.issue' as const, params: { spaceId: 'space-1', issueId: 'issue-7' } },
  },
};

const taskComment = {
  id: 'task-comment:comment-9',
  kind: 'task_agent_comment' as const,
  createdAt: '2026-08-16T08:03:00.000Z',
  isRead: false,
  taskId: 'task-3',
  taskName: '升级依赖',
  commentId: 'comment-9',
  agent: { type: 'registered_agent' as const, id: 'session-3', displayName: 'Agent' },
  excerpt: '发现两个高危依赖，建议先升级解析器。',
  target: {
    kind: 'app_route' as const,
    route: { version: 1 as const, name: 'task.comment' as const, params: { taskId: 'task-3', commentId: 'comment-9' } },
  },
};

function snapshot(overrides: Partial<NotificationSnapshot> = {}): NotificationSnapshot {
  return {
    loadState: 'ready',
    authState: 'authenticated',
    items: [announcement, comment],
    hasUnread: true,
    hasMore: false,
    isLoadingMore: false,
    feedCutoff: { createdAt: comment.createdAt, id: comment.id },
    lastSyncedAt: '2026-08-16T08:02:00.000Z',
    errorCode: null,
    ...overrides,
  };
}

function renderFlyout(overrides: Partial<Parameters<typeof NotificationCenterFlyout>[0]> = {}) {
  const props = {
    snapshot: snapshot(),
    onRefresh: vi.fn(),
    onLoadMore: vi.fn(async () => undefined),
    onMarkAllRead: vi.fn(async () => undefined),
    onOpenAppRoute: vi.fn(async () => true),
    onClose: vi.fn(),
    ...overrides,
  };
  return { ...render(<NotificationCenterFlyout {...props} />), props };
}

describe('NotificationCenterFlyout', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('zh-CN');
  });

  it('uses the configured locale fallback and stable relative time buckets', () => {
    expect(localizedAnnouncement(announcement, 'zh-CN')).toBe('中文公告');
    expect(localizedAnnouncement(announcement, 'en-US')).toBe('English announcement');
    expect(localizedAnnouncement({ ...announcement, summaryOther: ' ' }, 'fr-FR')).toBe('中文公告');
    expect(formatNotificationTime('2026-08-16T07:59:00.000Z', 'en-US', Date.parse('2026-08-16T08:00:00.000Z')))
      .toBe('1 minute ago');
  });

  it('marks an announcement read only on click, then opens its HTTP URL', async () => {
    mocks.invoke
      .mockResolvedValueOnce({ notificationId: announcement.id, target: announcement.target })
      .mockResolvedValueOnce(undefined);
    const { props } = renderFlyout();

    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /中文公告/ }));

    await waitFor(() => expect(mocks.invoke).toHaveBeenNthCalledWith(
      1,
      'cmd_notification_mark_read',
      { notificationId: announcement.id },
    ));
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      2,
      'cmd_notification_open_external',
      { url: announcement.target.url },
    );
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('keeps the panel open and offers copy when the system browser handoff fails', async () => {
    mocks.invoke
      .mockResolvedValueOnce({ notificationId: announcement.id, target: announcement.target })
      .mockRejectedValueOnce(new Error('shell unavailable'));
    const { props } = renderFlyout();

    fireEvent.click(screen.getByRole('button', { name: /中文公告/ }));
    const copy = await screen.findByRole('button', { name: String(i18n.t('app:notificationCenter.copyLink')) });
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(copy);
    expect(mocks.copy).toHaveBeenCalledWith(announcement.target.url);
  });

  it('opens the exact Space issue route after recording the click-read', async () => {
    mocks.invoke.mockResolvedValueOnce({ notificationId: comment.id, target: comment.target });
    const onOpenAppRoute = vi.fn(async () => true);
    const { props } = renderFlyout({ onOpenAppRoute });

    fireEvent.click(screen.getByRole('button', { name: /Ethan/ }));
    await waitFor(() => expect(onOpenAppRoute).toHaveBeenCalledWith(comment.target.route));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('renders a local Agent task comment and opens its exact typed route', async () => {
    mocks.invoke.mockResolvedValueOnce({ notificationId: taskComment.id, target: taskComment.target });
    const onOpenAppRoute = vi.fn(async () => true);
    renderFlyout({
      snapshot: snapshot({ items: [taskComment], feedCutoff: { createdAt: taskComment.createdAt, id: taskComment.id } }),
      onOpenAppRoute,
    });

    expect(screen.queryByText(String(i18n.t('app:notificationCenter.accountScope')))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Agent.*升级依赖/ }));
    await waitFor(() => expect(onOpenAppRoute).toHaveBeenCalledWith(taskComment.target.route));
    expect(screen.getByText(taskComment.excerpt)).toBeInTheDocument();
  });

  it('uses text tone alone for read state and clamps comment excerpts to three lines', () => {
    const readTaskComment = { ...taskComment, id: 'task-comment:read', isRead: true };
    renderFlyout({
      snapshot: snapshot({
        items: [taskComment, readTaskComment],
        feedCutoff: { createdAt: readTaskComment.createdAt, id: readTaskComment.id },
      }),
    });

    const unreadItem = screen.getByLabelText(String(i18n.t('app:notificationCenter.unread')));
    const readItem = screen.getByLabelText(String(i18n.t('app:notificationCenter.read')));
    expect(unreadItem.querySelector('[data-notification-headline]')).toHaveClass(
      'font-medium',
      'text-[var(--ink)]',
    );
    expect(readItem.querySelector('[data-notification-headline]')).toHaveClass(
      'font-normal',
      'text-[var(--ink-muted)]',
    );
    expect(unreadItem.querySelector('[data-notification-detail]')).toHaveClass(
      'line-clamp-3',
      'text-[var(--ink-secondary)]',
    );
    expect(readItem.querySelector('[data-notification-detail]')).toHaveClass(
      'line-clamp-3',
      'text-[var(--ink-muted)]/75',
    );
    expect(unreadItem.querySelector('[aria-hidden="true"]')).not.toBeInTheDocument();
    expect(unreadItem.querySelector('svg')).not.toBeInTheDocument();
  });

  it('marks all read against the loaded feed cutoff without activating a row', async () => {
    const onMarkAllRead = vi.fn(async () => undefined);
    renderFlyout({ onMarkAllRead });

    fireEvent.click(screen.getByRole('button', { name: String(i18n.t('app:notificationCenter.markAllRead')) }));
    await waitFor(() => expect(onMarkAllRead).toHaveBeenCalledOnce());
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
