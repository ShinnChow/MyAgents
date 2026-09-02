import { describe, expect, it } from 'vitest';

import {
    deriveSessionUserTagSummaries,
    MAX_SESSION_USER_TAG_CODE_POINTS,
    normalizeSessionUserTag,
    sanitizeSessionUserTags,
    sessionHasUserTag,
} from './session-user-tags';

describe('session user tag policy', () => {
    it('normalizes trim, NFC, and locale-independent case identity', () => {
        expect(normalizeSessionUserTag('  Cafe\u0301  ')).toEqual({
            ok: true,
            tag: { name: 'Café', identity: 'café' },
        });
        expect(normalizeSessionUserTag('待 跟进 🚀')).toEqual({
            ok: true,
            tag: { name: '待 跟进 🚀', identity: '待 跟进 🚀' },
        });
    });

    it('rejects empty, control, and over-limit names by Unicode code point', () => {
        expect(normalizeSessionUserTag(' \n ')).toEqual({ ok: false, reason: 'empty' });
        expect(normalizeSessionUserTag('line\nbreak')).toEqual({ ok: false, reason: 'control-character' });
        expect(normalizeSessionUserTag('😀'.repeat(MAX_SESSION_USER_TAG_CODE_POINTS))).toMatchObject({ ok: true });
        expect(normalizeSessionUserTag('😀'.repeat(MAX_SESSION_USER_TAG_CODE_POINTS + 1))).toEqual({
            ok: false,
            reason: 'too-long',
        });
    });

    it('rejects unpaired UTF-16 surrogates before JSON persistence', () => {
        expect(normalizeSessionUserTag(`broken-${String.fromCharCode(0xD800)}`))
            .toEqual({ ok: false, reason: 'unpaired-surrogate' });
        expect(normalizeSessionUserTag(`${String.fromCharCode(0xDC00)}-broken`))
            .toEqual({ ok: false, reason: 'unpaired-surrogate' });
    });

    it('sanitizes malformed arrays, deduplicates identity, and caps at five', () => {
        expect(sanitizeSessionUserTags([
            'Alpha', ' alpha ', 42, '', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta',
        ])).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']);
    });

    it('derives a global canonical list and assignment counts', () => {
        expect(deriveSessionUserTagSummaries([
            { userTags: ['Alpha', 'Beta'] },
            { userTags: ['alpha', 'Gamma'] },
            { userTags: 'malformed' },
        ])).toEqual([
            { name: 'Alpha', count: 2 },
            { name: 'Beta', count: 1 },
            { name: 'Gamma', count: 1 },
        ]);
        expect(sessionHasUserTag(['Alpha'], ' alpha ')).toBe(true);
    });
});
