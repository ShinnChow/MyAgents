export const MAX_SESSION_USER_TAGS = 5;
export const MAX_SESSION_USER_TAG_CODE_POINTS = 32;

export type SessionUserTagValidationError =
    | 'not-string'
    | 'empty'
    | 'too-long'
    | 'unpaired-surrogate'
    | 'control-character';

export interface NormalizedSessionUserTag {
    name: string;
    identity: string;
}

export interface SessionUserTagSummary {
    name: string;
    count: number;
}

export type SessionUserTagMutation =
    | { kind: 'add'; name: string }
    | { kind: 'remove'; name: string };

export type GlobalSessionUserTagMutation =
    | { kind: 'rename'; name: string; newName: string; merge?: boolean }
    | { kind: 'delete'; name: string };

export function normalizeSessionUserTag(
    input: unknown,
): { ok: true; tag: NormalizedSessionUserTag } | { ok: false; reason: SessionUserTagValidationError } {
    if (typeof input !== 'string') return { ok: false, reason: 'not-string' };
    const name = input.trim().normalize('NFC');
    if (!name) return { ok: false, reason: 'empty' };
    if (Array.from(name).length > MAX_SESSION_USER_TAG_CODE_POINTS) {
        return { ok: false, reason: 'too-long' };
    }
    if (Array.from(name).some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && codePoint >= 0xD800 && codePoint <= 0xDFFF;
    })) {
        return { ok: false, reason: 'unpaired-surrogate' };
    }
    if (Array.from(name).some((character) => /\p{Cc}/u.test(character))) {
        return { ok: false, reason: 'control-character' };
    }
    return { ok: true, tag: { name, identity: name.toLowerCase() } };
}

/**
 * Read-side tolerance for hand-edited or historical metadata. Invalid entries
 * are ignored, identity duplicates keep their first display form, and the
 * product cap is enforced without making the owning Session unreadable.
 */
export function sanitizeSessionUserTags(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    const tags: string[] = [];
    const seen = new Set<string>();
    for (const candidate of input) {
        const normalized = normalizeSessionUserTag(candidate);
        if (!normalized.ok || seen.has(normalized.tag.identity)) continue;
        seen.add(normalized.tag.identity);
        tags.push(normalized.tag.name);
        if (tags.length === MAX_SESSION_USER_TAGS) break;
    }
    return tags;
}

export function sessionHasUserTag(input: unknown, name: string): boolean {
    const normalized = normalizeSessionUserTag(name);
    if (!normalized.ok) return false;
    return sanitizeSessionUserTags(input).some((candidate) => (
        candidate.toLowerCase() === normalized.tag.identity
    ));
}

export function deriveSessionUserTagSummaries(
    sessions: readonly { userTags?: unknown }[],
): SessionUserTagSummary[] {
    const summaries = new Map<string, SessionUserTagSummary>();
    for (const session of sessions) {
        for (const name of sanitizeSessionUserTags(session.userTags)) {
            const normalized = normalizeSessionUserTag(name);
            if (!normalized.ok) continue;
            const existing = summaries.get(normalized.tag.identity);
            if (existing) existing.count += 1;
            else summaries.set(normalized.tag.identity, { name: normalized.tag.name, count: 1 });
        }
    }
    return [...summaries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function sameSessionUserTags(left: unknown, right: unknown): boolean {
    const a = sanitizeSessionUserTags(left);
    const b = sanitizeSessionUserTags(right);
    return a.length === b.length && a.every((value, index) => value === b[index]);
}
