import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import {
  isBrowserResourceReady,
  selectLatestBrowserResourceStatus,
  type BrowserResourceStatus,
} from '../../shared/browserTools';
import { isTauriEnvironment } from '@/utils/browserMock';
import { listenWithCleanup } from '@/utils/tauriListen';

/** Read-only renderer projection of the Rust-owned Browser resource state. */
export function useBrowserResourceReady(): boolean {
  const [status, setStatus] = useState<BrowserResourceStatus | null>(null);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    const controller = new AbortController();
    const accept = (incoming: BrowserResourceStatus) => {
      setStatus(current => selectLatestBrowserResourceStatus(current, incoming));
    };
    void listenWithCleanup<BrowserResourceStatus>(
      'browser-resource-status',
      event => accept(event.payload),
      controller.signal,
    );
    void invoke<BrowserResourceStatus>('cmd_browser_resource_status')
      .then(accept)
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return isBrowserResourceReady(status);
}
