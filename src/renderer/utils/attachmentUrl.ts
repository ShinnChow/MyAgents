// Resolve a persisted attachment to a URL the WebView can render.
//
// Production (Tauri): `resolveMyAgentsResourceUrl('/attachment/<rel>')` hits
// the async URI scheme handler in `src-tauri/src/attachment_protocol.rs`
// (`myagents-resource://...` on macOS/Linux,
// `http://myagents-resource.localhost/...` on
// Windows). The handler serves bytes from `~/.myagents/attachments/<rel>`
// through the WebView resource pipeline. Zero JSON round-trip, zero base64
// bloat, zero main-thread read.
//
// Browser dev (vite): the scheme isn't registered, so we fall back to
// `/api/attachment/<rel>` served by the Node Sidecar. proxyFetch on the global sidecar
// handles the routing; using an absolute path here lets <img src> go through
// the vite dev server proxy without needing a Tauri bridge.

import { isTauri } from '@/api/tauriClient';
import { resolveMyAgentsResourceUrl } from '@/utils/myagentsProtocol';

function encodeRelative(rel: string): string {
  return rel.split('/').map(encodeURIComponent).join('/');
}

export function resolveAttachmentUrl(att: {
  savedPath?: string;
  relativePath?: string;
  previewUrl?: string;
}): string | undefined {
  const rel = att.savedPath || att.relativePath;
  if (!rel) {
    // Local upload not yet persisted — keep the blob/data URL that ChatInput set.
    return att.previewUrl;
  }
  const encoded = encodeRelative(rel);
  if (isTauri()) {
    return resolveMyAgentsResourceUrl(`/attachment/${encoded}`);
  }
  return `/api/attachment/${encoded}`;
}
