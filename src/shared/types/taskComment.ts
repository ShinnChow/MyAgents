export type TaskCommentAuthor =
  | { kind: "user"; label?: string }
  | { kind: "agent"; label?: string; sessionId: string };

export type TaskCommentAdmissionState =
  | "pending_session"
  | "sending"
  | "accepted"
  | "failed"
  | "unknown";

export interface TaskCommentAdmission {
  state: TaskCommentAdmissionState;
  targetSessionId?: string;
  attemptId?: string;
  acceptedAt?: number;
  error?: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  body: string;
  author: TaskCommentAuthor;
  createdAt: number;
  replyToCommentId?: string;
  conversationSessionId?: string;
  admission?: TaskCommentAdmission;
}

export interface TaskCommentPage {
  items: TaskComment[];
  nextBefore?: string;
  nextAfter?: string;
  replyParents?: TaskCommentReplySummary[];
}

export interface TaskCommentReplySummary {
  commentId: string;
  author: TaskCommentAuthor;
  createdAt: number;
  quote: string;
}

export interface TaskCommentContextPage extends TaskCommentPage {
  targetCommentId: string;
  previousBefore?: string;
  nextAfter?: string;
}

export const TASK_COMMENT_BODY_MAX_BYTES = 64 * 1024;
export const TASK_COMMENT_QUOTE_CODE_POINTS = 30;

export function taskCommentQuote(body: string): string {
  const points = Array.from(body.trim());
  if (points.length <= TASK_COMMENT_QUOTE_CODE_POINTS) return points.join("");
  return `${points.slice(0, TASK_COMMENT_QUOTE_CODE_POINTS).join("")}…`;
}
