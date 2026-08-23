import { useCallback, useEffect, useState } from 'react';

import { isTauriEnvironment } from '@/utils/browserMock';
import { listenWithCleanup } from '@/utils/tauriListen';
import {
  EMPTY_NOTIFICATION_SNAPSHOT,
  getNotificationSnapshot,
  loadMoreNotifications,
  markAllNotificationsRead,
  requestNotificationRefresh,
  type NotificationSnapshot,
} from './notificationCenter';

export interface NotificationCenterController {
  snapshot: NotificationSnapshot;
  refresh: () => void;
  loadMore: () => Promise<void>;
  markAllRead: () => Promise<void>;
}

export function useNotificationCenter(): NotificationCenterController {
  const [snapshot, setSnapshot] = useState<NotificationSnapshot>(EMPTY_NOTIFICATION_SNAPSHOT);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    let cancelled = false;
    const ac = new AbortController();
    void getNotificationSnapshot()
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch(() => {
        if (!cancelled) {
          setSnapshot((current) => ({
            ...current,
            loadState: 'error',
            errorCode: 'unavailable',
          }));
        }
      });
    void listenWithCleanup<NotificationSnapshot>(
      'notification-center:updated',
      (event) => {
        if (!cancelled) setSnapshot(event.payload);
      },
      ac.signal,
    );

    const wake = () => { void requestNotificationRefresh(); };
    const wakeWhenVisible = () => {
      if (document.visibilityState === 'visible') wake();
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wakeWhenVisible);
    return () => {
      cancelled = true;
      ac.abort();
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wakeWhenVisible);
    };
  }, []);

  const refresh = useCallback(() => {
    if (!isTauriEnvironment()) return;
    void requestNotificationRefresh();
  }, []);

  const loadMore = useCallback(async () => {
    if (!isTauriEnvironment()) return;
    setSnapshot(await loadMoreNotifications());
  }, []);

  const markAllRead = useCallback(async () => {
    if (!isTauriEnvironment()) return;
    setSnapshot(await markAllNotificationsRead());
  }, []);

  return { snapshot, refresh, loadMore, markAllRead };
}
