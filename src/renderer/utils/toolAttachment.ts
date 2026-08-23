/**
 * Frontend helper for resolving ToolAttachment refPath to an absolute URL.
 *
 * PRD 0.2.15 §4.8 — replaces ad-hoc `readLocalFileAsBlobUrl(savedPath, ...)`
 * usage that mis-fits the new endpoint shape and bypasses attachment-aware
 * permission checks.
 *
 * Browser dev fetches `/api/attachment/tool/<sid>/<tid>/<file>` through the
 * Vite proxy. Tauri uses the app-owned attachment protocol
 * (`myagents-resource://tool-attachment/...` on macOS/Linux,
 * `http://myagents-resource.localhost/tool-attachment/...` on Windows) so WebView
 * subresource loading stays inside the configured img/media allow-list.
 */

import { useEffect, useState } from 'react';
import { resolveMyAgentsResourceUrl } from '@/utils/myagentsProtocol';
import { isTauriEnvironment } from '@/utils/browserMock';
import type { ToolAttachment } from '../../shared/types/tool-attachment';

const TOOL_ATTACHMENT_API_PREFIX = '/api/attachment/tool/';
const TOOL_ATTACHMENT_PROTOCOL_PATH_PREFIX = '/tool-attachment/';

function sanitizeAttachmentScopeSegment(segment: string): string {
  // Mirrors server/runtimes/tool-attachments.ts::sanitizeSessionTurnSegment.
  return segment.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function parseToolAttachmentRefPath(refPath: string): { sessionId: string; relativePath: string } | null {
  if (!refPath.startsWith(TOOL_ATTACHMENT_API_PREFIX)) return null;
  const relativePath = refPath.slice(TOOL_ATTACHMENT_API_PREFIX.length);
  const segments = relativePath.split('/');
  if (segments.length !== 3) return null;
  const [encodedSessionId, encodedTurnId, encodedFilename] = segments;
  if (!encodedSessionId || !encodedTurnId || !encodedFilename) return null;

  const sessionId = decodePathSegment(encodedSessionId);
  if (!sessionId || sessionId !== sanitizeAttachmentScopeSegment(sessionId)) return null;

  return { sessionId, relativePath };
}

function getToolAttachmentRefError(refPath: string, expectedSessionId: string | null): string | null {
  const parsed = parseToolAttachmentRefPath(refPath);
  if (!parsed) return 'invalid_ref';
  if (!expectedSessionId) return 'missing_session';
  if (parsed.sessionId !== sanitizeAttachmentScopeSegment(expectedSessionId)) return 'session_mismatch';
  return null;
}

export function resolveTauriToolAttachmentUrl(refPath: string, expectedSessionId?: string | null): string | null {
  const parsed = parseToolAttachmentRefPath(refPath);
  if (!parsed) return null;
  if (expectedSessionId !== undefined && getToolAttachmentRefError(refPath, expectedSessionId)) return null;
  return resolveMyAgentsResourceUrl(`${TOOL_ATTACHMENT_PROTOCOL_PATH_PREFIX}${parsed.relativePath}`);
}

/**
 * Resolve a refPath to a fetchable URL for the current session.
 *
 * - Tauri: myagents-resource://tool-attachment/<sid>/<tid>/<file> on macOS/Linux;
 *   http://myagents-resource.localhost/tool-attachment/<sid>/<tid>/<file> on Windows
 * - Browser dev: relative refPath (vite proxy handles it)
 *
 * Returns null while resolving (caller shows a loading skeleton).
 */
export async function resolveToolAttachmentUrl(
  attachment: ToolAttachment,
  sessionId: string | null,
): Promise<string | null> {
  // Placeholder still pending — caller renders skeleton.
  if (attachment.pendingId && !attachment.refPath) return null;
  // Error sentinel.
  if (attachment.refPath.startsWith('error://')) return attachment.refPath;
  if (getToolAttachmentRefError(attachment.refPath, sessionId)) return null;

  if (!isTauriEnvironment()) {
    // Browser dev: vite proxies /api/* to the sidecar by default; refPath is
    // already in /api/attachment/tool/... form.
    return attachment.refPath;
  }

  const protocolUrl = resolveTauriToolAttachmentUrl(attachment.refPath, sessionId);
  if (protocolUrl) return protocolUrl;

  return null;
}

/**
 * React hook variant: resolves an attachment URL for use in <img src=…>.
 * Returns:
 *   - { state: 'loading' } while port lookup is in flight
 *   - { state: 'ready', url } when resolved
 *   - { state: 'pending' } when the attachment is a placeholder (async save in flight)
 *   - { state: 'error', reason } when refPath is an error sentinel
 */
export type AttachmentUrlState =
  | { state: 'loading' }
  | { state: 'ready'; url: string }
  | { state: 'pending' }
  | { state: 'error'; reason: string };

function computeSyncState(attachment: ToolAttachment, sessionId: string | null): AttachmentUrlState | null {
  if (attachment.pendingId && !attachment.refPath) return { state: 'pending' };
  if (attachment.refPath.startsWith('error://')) {
    return { state: 'error', reason: attachment.refPath.slice('error://'.length) };
  }
  const refError = getToolAttachmentRefError(attachment.refPath, sessionId);
  if (refError) return { state: 'error', reason: refError };
  return null;
}

interface ResolverEntry {
  refPath: string;
  sessionId: string | null;
  url: string | null;
}

export function useAttachmentUrl(
  attachment: ToolAttachment,
  sessionId: string | null,
): AttachmentUrlState {
  const syncState = computeSyncState(attachment, sessionId);

  // Derived-state-from-props pattern (React docs): reset resolvedUrl during
  // render when the input attachment changes — avoids the
  // react-hooks/set-state-in-effect lint hit for "manually re-syncing state".
  const [entry, setEntry] = useState<ResolverEntry>({ refPath: attachment.refPath, sessionId, url: null });
  if (entry.refPath !== attachment.refPath || entry.sessionId !== sessionId) {
    setEntry({ refPath: attachment.refPath, sessionId, url: null });
  }

  useEffect(() => {
    if (syncState !== null) return;
    let cancelled = false;
    void resolveToolAttachmentUrl(attachment, sessionId).then(url => {
      if (cancelled) return;
      setEntry(prev =>
        prev.refPath === attachment.refPath && prev.sessionId === sessionId
          ? { ...prev, url }
          : prev,
      );
    });
    return () => { cancelled = true; };
  }, [attachment, sessionId, syncState]);

  if (syncState !== null) return syncState;
  if (entry.refPath !== attachment.refPath || entry.url === null) {
    return { state: 'loading' };
  }
  return { state: 'ready', url: entry.url };
}
