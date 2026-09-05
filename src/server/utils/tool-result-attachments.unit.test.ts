import { describe, expect, it } from 'vitest';

import {
  appendOmittedImageNote,
  classifyToolAttachmentPresentation,
  extractToolResultRenderParts,
  extractSdkToolResultRenderParts,
  normalizeSdkToolUseResult,
} from './tool-result-attachments';

describe('SDK result ingress projection', () => {
  it.each(['image', 'pdf'] as const)('keeps %s side-data bytes out of text with existing media presentation', (kind) => {
    const mime = kind === 'pdf' ? 'application/pdf' : 'image/png';
    const data = 'c3ludGhldGljLWJ5dGVz';
    const block = { type: kind === 'pdf' ? 'document' : 'image', source: { type: 'base64', media_type: mime, data } };
    const raw = { type: kind, file: { filePath: `/tmp/test.${kind}`, base64: data } };
    const result = extractSdkToolResultRenderParts([block], raw);
    expect(result.text).not.toContain(data);
    expect(JSON.parse(result.text).file.filePath).toBe(`/tmp/test.${kind}`);
    expect(result.attachments).toEqual(kind === 'image'
      ? [{ kind, mimeType: mime, source: { kind: 'base64', data } }]
      : []); // Full PDF stays a Read result; this upgrade does not add cards.
  });

  it('handles emitted page reads without inventing pages in side data', () => {
    const result = extractSdkToolResultRenderParts([
      { type: 'text', text: 'Page 3' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'cGFnZQ==' } },
    ], { type: 'parts', firstPage: 3, file: { filePath: '/tmp/test.pdf', count: 1, outputDir: '/tmp/pages' } });
    expect(result.attachments).toHaveLength(1);
    expect(JSON.parse(result.text).firstPage).toBe(3);
    expect(result.text).not.toContain('cGFnZQ==');
  });

  it('redacts nested side-data payloads and preserves structured search results', () => {
    const result = extractSdkToolResultRenderParts([], { images: [{ base64: 'aW1hZ2U=', mediaType: 'image/png' }], documents: [{ base64: 'cGRm' }] });
    expect(result.text).not.toContain('aW1hZ2U=');
    expect(result.text).not.toContain('cGRm');
    const search = { query: 'news', results: [{ title: 'Title', url: 'https://example.com' }] };
    expect(JSON.parse(extractSdkToolResultRenderParts('fallback', search).text)).toEqual(search);
  });

  it('preserves ordinary Read, Bash and structured text even when it resembles binary data', () => {
    const file = { type: 'text', file: { filePath: '/tmp/config.yml', content: 'data:\n  mode: production\n' } };
    const sequence = { type: 'text', file: { filePath: '/tmp/sequence.txt', content: 'ACGT'.repeat(75) } };
    const bash = { stdout: 'data: no records', stderr: 'A'.repeat(300), interrupted: false };
    const structured = { data: 'business value', results: [{ text: 'data: search result' }] };
    for (const raw of [file, sequence, bash, structured]) {
      expect(extractSdkToolResultRenderParts('fallback', raw).text).toBe(JSON.stringify(raw));
    }
  });

  it('redacts typed media data and image stdout without hiding neighboring prose', () => {
    const raw = {
      content: [{ type: 'image', source: { type: 'base64', data: 'aW1hZ2U=' } }],
      stdout: 'aW1hZ2U=', isImage: true, stderr: 'data: diagnostic',
    };
    const result = JSON.parse(extractSdkToolResultRenderParts([], raw).text);
    expect(result.content[0].source.data).toBe('[8 bytes omitted]');
    expect(result.stdout).toBe('[8 bytes omitted]');
    expect(result.stderr).toBe(raw.stderr);
  });

  it('preserves legacy text and metadata envelopes without rendering private metadata', () => {
    expect(extractSdkToolResultRenderParts('plain text', undefined).text).toBe('plain text');
    const result = extractSdkToolResultRenderParts('fallback', {
      content: [{ type: 'text', text: 'visible' }, { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
      _meta: { token: 'private' },
    });
    expect(result.text).toBe('visible');
    expect(result.attachments).toHaveLength(1);
  });
});

describe('normalizeSdkToolUseResult', () => {
  it('unwraps SDK 0.3.232+ subagent MCP metadata envelopes', () => {
    const metadata = { traceId: 'private-metadata' };
    expect(normalizeSdkToolUseResult({
      content: [{ type: 'text', text: 'visible result' }],
      _meta: metadata,
    })).toEqual({
      content: [{ type: 'text', text: 'visible result' }],
      metadata,
      isMetadataEnvelope: true,
    });
  });

  it('preserves legacy structured and scalar tool_use_result values', () => {
    const legacy = { query: 'sdk upgrade', results: [{ title: 'result' }] };
    expect(normalizeSdkToolUseResult(legacy)).toEqual({
      content: legacy,
      metadata: undefined,
      isMetadataEnvelope: false,
    });
    expect(normalizeSdkToolUseResult('plain result')).toEqual({
      content: 'plain result',
      metadata: undefined,
      isMetadataEnvelope: false,
    });
  });

  it('does not mistake an ordinary content-bearing result for an SDK envelope', () => {
    const ordinary = { content: 'visible result', status: 'ok' };
    expect(normalizeSdkToolUseResult(ordinary).isMetadataEnvelope).toBe(false);
  });
});

describe('extractToolResultRenderParts', () => {
  it('extracts MCP image content blocks without leaking base64 into text (#293)', () => {
    const result = extractToolResultRenderParts([
      { type: 'text', text: 'screenshot captured' },
      { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
    ]);

    expect(result.text).toBe('screenshot captured');
    expect(result.attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        source: { kind: 'base64', data: 'aGVsbG8=' },
      },
    ]);
  });

  it('extracts Anthropic base64 image source blocks', () => {
    const result = extractToolResultRenderParts([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'ZmFrZQ==' },
      },
    ]);

    expect(result.text).toBe('');
    expect(result.attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/jpeg',
        source: { kind: 'base64', data: 'ZmFrZQ==' },
      },
    ]);
  });

  it('extracts data-URL payloads and prefers the embedded mime type', () => {
    const result = extractToolResultRenderParts([
      { type: 'image', data: 'data:image/webp;base64,Zm9v' },
    ]);

    expect(result.attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/webp',
        source: { kind: 'base64', data: 'Zm9v' },
      },
    ]);
  });

  it('maps file-path image refs to externalPath sources (allow-list enforced at save layer)', () => {
    const result = extractToolResultRenderParts([
      { type: 'image', file: { path: '/Users/x/.myagents/generated/shot.png', mimeType: 'image/png' } },
    ]);

    expect(result.attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        source: { kind: 'externalPath', sourcePath: '/Users/x/.myagents/generated/shot.png' },
      },
    ]);
  });

  it('maps remote urls to url sources (SSRF guard enforced at save layer)', () => {
    const result = extractToolResultRenderParts([
      { type: 'image', url: 'https://example.com/img.png' },
    ]);

    expect(result.attachments).toEqual([
      {
        kind: 'image',
        mimeType: 'image/png',
        source: { kind: 'url', url: 'https://example.com/img.png' },
      },
    ]);
  });

  it('redacts unknown base64-like fields when falling back to JSON text', () => {
    const payload = 'a'.repeat(300);
    const result = extractToolResultRenderParts({ type: 'unknown', data: payload });

    expect(result.attachments).toEqual([]);
    expect(result.text).toContain('[300 bytes omitted]');
    expect(result.text).not.toContain(payload);
  });

  it('passes string content through untouched', () => {
    const result = extractToolResultRenderParts('plain result');
    expect(result).toEqual({ text: 'plain result', attachments: [] });
  });

  it('extracts a bare data-URL image STRING so base64 never reaches text (finding 2)', () => {
    const result = extractToolResultRenderParts('data:image/png;base64,aGVsbG8=');
    expect(result.text).toBe('');
    expect(result.attachments).toEqual([
      { kind: 'image', mimeType: 'image/png', source: { kind: 'base64', data: 'aGVsbG8=' } },
    ]);
  });

  it('extracts a data-URL image carried inside a text block (finding 2)', () => {
    const result = extractToolResultRenderParts([
      { type: 'text', text: '  data:image/jpeg;base64,ZmFrZQ==  ' },
    ]);
    expect(result.text).toBe('');
    expect(result.attachments).toEqual([
      { kind: 'image', mimeType: 'image/jpeg', source: { kind: 'base64', data: 'ZmFrZQ==' } },
    ]);
  });

  it('does NOT treat a non-image data URL or prose-with-url as an image', () => {
    const pdf = extractToolResultRenderParts('data:application/pdf;base64,JVBER');
    expect(pdf.attachments).toEqual([]);
    expect(pdf.text).toBe('data:application/pdf;base64,JVBER');
    const prose = extractToolResultRenderParts('see data:image/png;base64,xx inline');
    expect(prose.attachments).toEqual([]); // not a standalone data URL
    expect(prose.text).toContain('see data:image/png');
  });

  it('handles null/undefined content', () => {
    expect(extractToolResultRenderParts(null)).toEqual({ text: '', attachments: [] });
    expect(extractToolResultRenderParts(undefined)).toEqual({ text: '', attachments: [] });
  });
});

describe('classifyToolAttachmentPresentation (#293 artifact/process split)', () => {
  it('classifies playwright / computer-use screenshots as process media', () => {
    expect(classifyToolAttachmentPresentation('mcp__playwright__browser_take_screenshot')).toBe('process');
    expect(classifyToolAttachmentPresentation('mcp__computer-use__screenshot')).toBe('process');
    expect(classifyToolAttachmentPresentation('mcp__cuse__click')).toBe('process');
    // generic screenshot-named tools err toward process (flood prevention)
    expect(classifyToolAttachmentPresentation('mcp__my-browser__take_screenshot')).toBe('process');
  });

  it('classifies generator tools (and unknown/missing names) as artifact', () => {
    expect(classifyToolAttachmentPresentation('mcp__gemini-image__generate_image')).toBe('artifact');
    expect(classifyToolAttachmentPresentation('mcp__edge-tts__synthesize')).toBe('artifact');
    expect(classifyToolAttachmentPresentation('some_random_tool')).toBe('artifact');
    expect(classifyToolAttachmentPresentation(undefined)).toBe('artifact');
    expect(classifyToolAttachmentPresentation(null)).toBe('artifact');
  });
});

describe('appendOmittedImageNote', () => {
  it('appends a count note when images were dropped', () => {
    expect(appendOmittedImageNote('done', 2)).toBe('done\n[2 image attachment(s) omitted]');
    expect(appendOmittedImageNote('', 1)).toBe('[1 image attachment(s) omitted]');
  });
  it('is a no-op when no images were dropped', () => {
    expect(appendOmittedImageNote('done', 0)).toBe('done');
    expect(appendOmittedImageNote('done', -1)).toBe('done');
  });
});
