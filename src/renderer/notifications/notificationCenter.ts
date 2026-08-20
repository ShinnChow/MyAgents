import { invoke } from '@tauri-apps/api/core';

import type { AppRoute } from '../../shared/appRoute';

export type NotificationTarget =
  | { kind: 'external_url'; url: string }
  | { kind: 'app_route'; route: AppRoute };

export interface NotificationSortPoint {
  createdAt: string;
  id: string;
}

export interface AnnouncementNotificationItem {
  id: string;
  kind: 'announcement';
  createdAt: string;
  isRead: boolean;
  summaryZh: string;
  summaryOther: string | null;
  target: NotificationTarget;
}

export interface CommentNotificationItem {
  id: string;
  kind: 'space_issue_comment';
  createdAt: string;
  isRead: boolean;
  commentId: string;
  actor: {
    type: 'user' | 'registered_agent';
    id: string;
    displayName: string;
  };
  spaceId: string;
  issue: { id: string; number: number | null; title: string };
  excerpt: string | null;
  target: NotificationTarget;
}

export interface TaskAgentCommentNotificationItem {
  id: string;
  kind: 'task_agent_comment';
  createdAt: string;
  isRead: boolean;
  taskId: string;
  taskName: string;
  commentId: string;
  agent: {
    type: 'registered_agent';
    id: string;
    displayName: string;
  };
  excerpt: string;
  target: NotificationTarget;
}

export type NotificationItem =
  | AnnouncementNotificationItem
  | CommentNotificationItem
  | TaskAgentCommentNotificationItem;

export type NotificationLoadState = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';
export type NotificationAuthState = 'signed_out' | 'authenticated' | 'reauth_required';

export interface NotificationSnapshot {
  loadState: NotificationLoadState;
  authState: NotificationAuthState;
  items: NotificationItem[];
  hasUnread: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  feedCutoff: NotificationSortPoint | null;
  lastSyncedAt: string | null;
  errorCode: string | null;
}

export interface NotificationActivation {
  notificationId: string;
  target: NotificationTarget;
}

export const EMPTY_NOTIFICATION_SNAPSHOT: NotificationSnapshot = {
  loadState: 'idle',
  authState: 'signed_out',
  items: [],
  hasUnread: false,
  hasMore: false,
  isLoadingMore: false,
  feedCutoff: null,
  lastSyncedAt: null,
  errorCode: null,
};

export function getNotificationSnapshot(): Promise<NotificationSnapshot> {
  return invoke<NotificationSnapshot>('cmd_notification_get_snapshot');
}

export function requestNotificationRefresh(): Promise<void> {
  return invoke<void>('cmd_notification_refresh');
}

export function loadMoreNotifications(): Promise<NotificationSnapshot> {
  return invoke<NotificationSnapshot>('cmd_notification_load_more');
}

export function markNotificationRead(notificationId: string): Promise<NotificationActivation> {
  return invoke<NotificationActivation>('cmd_notification_mark_read', { notificationId });
}

export function markAllNotificationsRead(): Promise<NotificationSnapshot> {
  return invoke<NotificationSnapshot>('cmd_notification_mark_all_read');
}

export function openNotificationExternal(url: string): Promise<void> {
  return invoke<void>('cmd_notification_open_external', { url });
}
