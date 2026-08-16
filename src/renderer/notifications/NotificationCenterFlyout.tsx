import {
  Bell,
  CheckCheck,
  Copy,
  ExternalLink,
  Loader2,
  Megaphone,
  MessageSquareText,
  RefreshCw,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { copyPlainText } from '@/utils/clipboard';
import type { AppRoute } from '../../shared/appRoute';
import {
  markNotificationRead,
  openNotificationExternal,
  type NotificationItem,
  type NotificationSnapshot,
} from './notificationCenter';

function formatNotificationTime(value: string, locale: string, now = Date.now()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '';
  const deltaSeconds = Math.round((timestamp - now) / 1_000);
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(deltaSeconds) < 60) return relative.format(deltaSeconds, 'second');
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (Math.abs(deltaMinutes) < 60) return relative.format(deltaMinutes, 'minute');
  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) return relative.format(deltaHours, 'hour');
  const deltaDays = Math.round(deltaHours / 24);
  if (Math.abs(deltaDays) < 7) return relative.format(deltaDays, 'day');
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(timestamp);
}

function localizedAnnouncement(item: Extract<NotificationItem, { kind: 'announcement' }>, language: string) {
  return language.toLowerCase().startsWith('zh')
    ? item.summaryZh
    : (item.summaryOther?.trim() || item.summaryZh);
}

interface NotificationCenterFlyoutProps {
  snapshot: NotificationSnapshot;
  onRefresh: () => void;
  onLoadMore: () => Promise<void>;
  onMarkAllRead: () => Promise<void>;
  onOpenAppRoute: (route: AppRoute) => Promise<boolean> | boolean;
  onClose: () => void;
}

export default function NotificationCenterFlyout({
  snapshot,
  onRefresh,
  onLoadMore,
  onMarkAllRead,
  onOpenAppRoute,
  onClose,
}: NotificationCenterFlyoutProps) {
  const { t, i18n } = useTranslation('app');
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [activationError, setActivationError] = useState<{
    id: string;
    url?: string;
  } | null>(null);
  const hasUnreadItems = useMemo(
    () => snapshot.hasUnread || snapshot.items.some((item) => !item.isRead),
    [snapshot.hasUnread, snapshot.items],
  );

  const activate = async (item: NotificationItem) => {
    if (activatingId) return;
    setActivatingId(item.id);
    setActivationError(null);
    try {
      const activation = await markNotificationRead(item.id);
      if (activation.target.kind === 'external_url') {
        try {
          await openNotificationExternal(activation.target.url);
          onClose();
        } catch {
          setActivationError({ id: item.id, url: activation.target.url });
        }
        return;
      }
      const opened = await onOpenAppRoute(activation.target.route);
      if (opened) onClose();
      else setActivationError({ id: item.id });
    } catch {
      setActivationError({
        id: item.id,
        url: item.target.kind === 'external_url' ? item.target.url : undefined,
      });
    } finally {
      setActivatingId(null);
    }
  };

  const markAll = async () => {
    if (markingAll || !hasUnreadItems) return;
    setMarkingAll(true);
    try {
      await onMarkAllRead();
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <section
      aria-label={t('notificationCenter.title')}
      className="flex h-full min-h-0 flex-col"
      data-notification-center-flyout
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--line)] px-4">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-[var(--ink)]">
            {t('notificationCenter.title')}
          </h2>
          <p className="mt-0.5 text-xs text-[var(--ink-muted)]">
            {snapshot.authState === 'authenticated'
              ? t('notificationCenter.accountScope')
              : t('notificationCenter.publicScope')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void markAll()}
          disabled={!hasUnreadItems || markingAll || !snapshot.feedCutoff}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-35"
        >
          {markingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
          {t('notificationCenter.markAllRead')}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" role="feed">
        {snapshot.loadState === 'loading' && snapshot.items.length === 0 ? (
          <div className="flex h-52 items-center justify-center text-[var(--ink-muted)]">
            <Loader2 className="h-5 w-5 animate-spin" aria-label={t('notificationCenter.loading')} />
          </div>
        ) : snapshot.items.length === 0 && snapshot.loadState === 'ready' ? (
          <div className="flex h-60 flex-col items-center justify-center px-8 text-center">
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--hover-bg)] text-[var(--ink-muted)]">
              <Bell className="h-[18px] w-[18px]" />
            </span>
            <p className="text-sm font-medium text-[var(--ink)]">{t('notificationCenter.empty')}</p>
            <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">{t('notificationCenter.emptyHint')}</p>
          </div>
        ) : snapshot.items.length === 0 && ['error', 'unavailable'].includes(snapshot.loadState) ? (
          <div className="flex h-60 flex-col items-center justify-center px-8 text-center">
            <p className="text-sm font-medium text-[var(--ink)]">{t('notificationCenter.loadFailed')}</p>
            <p className="mt-1 text-xs leading-5 text-[var(--ink-muted)]">
              {snapshot.authState === 'reauth_required'
                ? t('notificationCenter.reauthHint')
                : t('notificationCenter.loadFailedHint')}
            </p>
            <button
              type="button"
              onClick={onRefresh}
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md bg-[var(--button-secondary-bg)] px-3 text-xs font-semibold text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)]"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t('notificationCenter.retry')}
            </button>
          </div>
        ) : (
          <div className="divide-y divide-[var(--line)]">
            {snapshot.items.map((item) => {
              const isActivating = activatingId === item.id;
              const failed = activationError?.id === item.id;
              const headline = item.kind === 'announcement'
                ? localizedAnnouncement(item, i18n.language)
                : t('notificationCenter.commentHeadline', {
                  actor: item.actor.displayName,
                  issue: item.issue.number ? `#${item.issue.number} ${item.issue.title}` : item.issue.title,
                });
              const detail = item.kind === 'space_issue_comment'
                ? (item.excerpt?.trim() || t('notificationCenter.attachmentOnly'))
                : null;
              return (
                <article key={item.id} aria-label={item.isRead ? t('notificationCenter.read') : t('notificationCenter.unread')}>
                  <button
                    type="button"
                    onClick={() => void activate(item)}
                    disabled={Boolean(activatingId)}
                    className="group relative flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--hover-bg)] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)] disabled:cursor-wait"
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--paper)] text-[var(--ink-muted)] shadow-sm">
                      {item.kind === 'announcement'
                        ? <Megaphone className="h-3.5 w-3.5" />
                        : <MessageSquareText className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start gap-2">
                        <span className={`min-w-0 flex-1 text-sm leading-5 ${item.isRead ? 'font-normal text-[var(--ink-muted)]' : 'font-medium text-[var(--ink)]'}`}>
                          {headline}
                        </span>
                        {isActivating
                          ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-[var(--ink-muted)]" />
                          : item.target.kind === 'external_url'
                            ? <ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ink-faint)] opacity-0 transition-opacity group-hover:opacity-100" />
                            : null}
                      </span>
                      {detail && (
                        <span className="mt-0.5 line-clamp-2 block text-xs leading-[18px] text-[var(--ink-muted)]">
                          {detail}
                        </span>
                      )}
                      <span className="mt-1 block text-xs tabular-nums text-[var(--ink-faint)]">
                        {formatNotificationTime(item.createdAt, i18n.language)}
                      </span>
                    </span>
                    {!item.isRead && (
                      <span className="absolute left-2 top-[18px] h-1.5 w-1.5 rounded-full bg-[var(--accent-warm)]" aria-hidden="true" />
                    )}
                  </button>
                  {failed && (
                    <div className="flex items-center justify-between gap-3 bg-[var(--hover-bg)] px-4 py-2 text-xs text-[var(--ink-muted)]">
                      <span>{activationError.url ? t('notificationCenter.openFailed') : t('notificationCenter.routeFailed')}</span>
                      {activationError.url && (
                        <button
                          type="button"
                          onClick={() => void copyPlainText(activationError.url ?? '')}
                          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-[var(--ink)] hover:bg-[var(--paper)]"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          {t('notificationCenter.copyLink')}
                        </button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>

      {(snapshot.hasMore || snapshot.isLoadingMore || (snapshot.errorCode && snapshot.items.length > 0)) && (
        <footer className="shrink-0 border-t border-[var(--line)] p-2">
          <button
            type="button"
            onClick={() => snapshot.errorCode ? onRefresh() : void onLoadMore()}
            disabled={snapshot.isLoadingMore}
            className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md text-xs font-medium text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] disabled:opacity-50"
          >
            {snapshot.isLoadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {snapshot.errorCode ? t('notificationCenter.retry') : t('notificationCenter.loadMore')}
          </button>
        </footer>
      )}
    </section>
  );
}

export { formatNotificationTime, localizedAnnouncement };
