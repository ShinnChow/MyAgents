/**
 * Pending Surface Registry
 *
 * 跨组件传递"下一个 session_new 事件应该带哪个入口上下文"。模型：
 *  - Caller（如 App.tsx::handleLaunchProject）在创建新 session 之前调用
 *    `setPendingSessionBirth(tabId, { surface, entryIntent, hasInitialMessage })`。
 *  - Consumer（TabProvider::resetSession 或 chat:system-init handler）在
 *    track session_new 时调用 `consumePendingSessionBirth(tabId, fallback)`。
 *  - 消费即清空——避免 stale birth context 流入下一个 session_new。
 *
 * 为什么不用 React Context？session_new 的触发点跨组件（App ↔ TabProvider），
 * 而且有时是 SSE 事件回调里同步触发（不在 React 渲染循环里）。Module-level
 * Map 是最简单的"边界 IPC"——读写都是 O(1)，无 re-render 副作用。
 *
 * 设计要点：
 *  1. 默认值由 consumer 决定（不同 consumer 默认不同：resetSession 默认
 *     new_chat；chat:system-init 默认 launcher send_message）
 *  2. tabId 隔离——Tab A 的 pending surface 不会被 Tab B 消费
 *  3. 消费即清空——避免泄漏到下一个 session_new
 *  4. 只在"即将创建新 session"前 set，不要在切换历史会话前 set（那条路径
 *     不触发 session_new，会让 context 滞留）
 */

import type { AssistantEntry, EntryIntent, Surface } from './types';

export interface PendingSessionBirthContext {
  surface: Surface;
  entryIntent: EntryIntent;
  hasInitialMessage: boolean;
  assistantEntry?: AssistantEntry;
}

const pendingByTab = new Map<string, PendingSessionBirthContext>();

export function birthContextForSurface(surface: Surface): PendingSessionBirthContext {
  switch (surface) {
    case 'launcher_input':
      return { surface, entryIntent: 'send_message', hasInitialMessage: true };
    case 'agent_card':
      return { surface, entryIntent: 'open_workspace', hasInitialMessage: false };
    case 'history_click':
      return { surface, entryIntent: 'open_history', hasInitialMessage: false };
    case 'new_chat_button':
      return { surface, entryIntent: 'new_chat', hasInitialMessage: false };
    case 'task_center':
      return { surface, entryIntent: 'thought_alignment', hasInitialMessage: true };
    case 'bug_report':
      return { surface, entryIntent: 'support_diagnostics', hasInitialMessage: true, assistantEntry: 'support_diagnostics' };
    case 'space_tools':
      return { surface, entryIntent: 'tool_install', hasInitialMessage: true, assistantEntry: 'space_tool_install' };
    case 'agent_setup':
      return { surface, entryIntent: 'workspace_init', hasInitialMessage: true };
    default:
      return { surface, entryIntent: 'unknown', hasInitialMessage: false };
  }
}

/**
 * 在 caller 即将创建新 session 之前打完整出生上下文。
 */
export function setPendingSessionBirth(tabId: string, context: PendingSessionBirthContext): void {
  pendingByTab.set(tabId, context);
}

/**
 * Read the next birth context without consuming it. Use this only when a
 * request must carry the birth fact before `session_new` has the real id.
 */
export function peekPendingSessionBirth(
  tabId: string,
  fallback: PendingSessionBirthContext,
): PendingSessionBirthContext {
  return pendingByTab.get(tabId) ?? fallback;
}

/**
 * Consumer 在 track session_new 之前消费出生上下文。如未 set 则返回 fallback。
 * 消费即清空，避免 stale 值流到下一个 session_new。
 */
export function consumePendingSessionBirth(
  tabId: string,
  fallback: PendingSessionBirthContext,
): PendingSessionBirthContext {
  const v = pendingByTab.get(tabId);
  if (v !== undefined) {
    pendingByTab.delete(tabId);
    return v;
  }
  return fallback;
}

/**
 * 兼容旧调用：在 caller 即将创建新 session 之前打 surface。
 * 新代码应优先使用 setPendingSessionBirth()，避免从 surface 猜 intent。
 */
export function setPendingSurface(tabId: string, surface: Surface): void {
  setPendingSessionBirth(tabId, birthContextForSurface(surface));
}

/**
 * Consumer 在 track session_new 之前消费 surface。如未 set 则返回 fallback。
 * 消费即清空，避免 stale 值流到下一个 session_new。
 */
export function consumePendingSurface(tabId: string, fallback: Surface): Surface {
  return consumePendingSessionBirth(tabId, birthContextForSurface(fallback)).surface;
}

/**
 * Tab 关闭时调用，清掉残留。
 */
export function clearPendingSurface(tabId: string): void {
  pendingByTab.delete(tabId);
}

export const clearPendingSessionBirth = clearPendingSurface;
