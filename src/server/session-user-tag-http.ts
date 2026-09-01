import type { SessionUserTagMutationFailureReason } from './SessionStore';

/** Stable HTTP contract shared by both global Session Tag mutation routes. */
export function sessionUserTagFailureStatus(reason: SessionUserTagMutationFailureReason): number {
    switch (reason) {
        case 'session-not-found':
        case 'tag-not-found':
            return 404;
        case 'protected-session':
            return 403;
        case 'limit-reached':
        case 'merge-required':
        case 'conflict':
            return 409;
        case 'io-error':
            return 500;
        case 'invalid-name':
            return 400;
    }
}
