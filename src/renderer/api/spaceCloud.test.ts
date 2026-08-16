import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

async function loadSpaceCloud() {
  vi.resetModules();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: {} },
  });
  const mod = await import('./spaceCloud');
  const { i18n } = await import('@/i18n');
  await i18n.changeLanguage('zh-CN');
  return mod;
}

beforeEach(() => {
  mocks.invoke.mockReset();
});

describe('spaceCloud API errors', () => {
  it('normalizes issue comment transport errors without leaking the raw URL', async () => {
    const { spaceCommentIssue, spaceErrorMessage } = await loadSpaceCloud();
    mocks.invoke.mockRejectedValueOnce(
      new Error(
        'Space API request failed: error sending request for url (https://space.myagents.io/api/issues/iss_123/comments)',
      ),
    );

    let thrown: unknown;
    try {
      await spaceCommentIssue('iss_123', 'hello');
    } catch (error) {
      thrown = error;
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toBe('评论发送失败，请检查网络或稍后重试');
    expect(spaceErrorMessage(thrown)).toBe('评论发送失败，请检查网络或稍后重试');
    expect(message).not.toContain('https://space.myagents.io');
  });

  it('redacts URLs, bearer tokens, and local paths from debug details', async () => {
    const { normalizeSpaceError } = await loadSpaceCloud();
    const normalized = normalizeSpaceError(
      new Error(
        'Space API request failed: Bearer secret.token /Users/ethan/.myagents/space/session.json https://space.myagents.io/api/issues',
      ),
      { method: 'POST', path: '/api/issues/iss_123/comments' },
    );

    expect(normalized.userMessage).toBe('评论发送失败，请检查网络或稍后重试');
    expect(normalized.debugMessage).not.toContain('secret.token');
    expect(normalized.debugMessage).not.toContain('/Users/ethan');
    expect(normalized.debugMessage).not.toContain('https://space.myagents.io');
  });

  it('normalizes issue comment business errors from the Space envelope', async () => {
    const { spaceCommentIssue } = await loadSpaceCloud();
    mocks.invoke.mockRejectedValueOnce('permission denied');

    await expect(spaceCommentIssue('iss_123', 'hello')).rejects.toThrow('评论发送失败：permission denied');
  });

  it('uses structured Space error envelopes when available', async () => {
    const { spaceCommentIssue, normalizeSpaceError } = await loadSpaceCloud();
    const envelope = {
      success: false,
      error: 'Not authenticated',
      code: 'NOT_AUTHENTICATED',
      requestId: 'req_123',
      recoveryHint: { message: 'Login with Google from MyAgents Cloud Space.' },
    };
    mocks.invoke.mockRejectedValueOnce(envelope);

    await expect(spaceCommentIssue('iss_123', 'hello')).rejects.toThrow('评论发送失败：请重新登录 MyAgents 社区');

    const normalized = normalizeSpaceError(envelope, { method: 'POST', path: '/api/issues/iss_123/comments' });
    expect(normalized.userMessage).toBe('评论发送失败：请重新登录 MyAgents 社区');
    expect(normalized.debugMessage).toContain('NOT_AUTHENTICATED');
    expect(normalized.debugMessage).toContain('req_123');
  });

  it('preserves the Rust reauth code and binding for the store transition fence', async () => {
    const {
      spaceErrorCode,
      spaceErrorSessionBindingId,
      spaceGetOfficial,
    } = await loadSpaceCloud();
    mocks.invoke.mockRejectedValueOnce({
      code: 'SPACE_REAUTH_REQUIRED',
      message: 'MyAgents Space login is required.',
      cloudCode: 'SESSION_EXPIRED',
      httpStatus: 401,
      retryable: false,
      credentialKind: 'user_session',
      sessionBindingId: 'binding-old',
      requestId: 'req_expired',
    });

    let thrown: unknown;
    try {
      await spaceGetOfficial('official');
    } catch (error) {
      thrown = error;
    }

    expect(spaceErrorCode(thrown)).toBe('SPACE_REAUTH_REQUIRED');
    expect(spaceErrorSessionBindingId(thrown)).toBe('binding-old');
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(
      'Space 请求失败：请重新登录 MyAgents 社区',
    );
    expect(thrown).toMatchObject({
      spaceCode: 'SPACE_REAUTH_REQUIRED',
      cloudCode: 'SESSION_EXPIRED',
      httpStatus: 401,
      requestId: 'req_expired',
      retryable: false,
      sessionBindingId: 'binding-old',
    });
  });

  it('preserves Space business error codes for field-level handling', async () => {
    const { spaceCreateSpace, spaceErrorCode, spaceErrorMessage } = await loadSpaceCloud();
    mocks.invoke.mockResolvedValueOnce({
      success: false,
      error: 'Space slug already exists',
      code: 'SPACE_SLUG_CONFLICT',
      requestId: 'req_slug',
    });

    let thrown: unknown;
    try {
      await spaceCreateSpace({ name: 'Duplicate Lab', slug: 'duplicate-lab' });
    } catch (error) {
      thrown = error;
    }

    expect(spaceErrorCode(thrown)).toBe('SPACE_SLUG_CONFLICT');
    expect(spaceErrorMessage(thrown)).toBe('Space 创建失败：这个 Space slug 已被占用，请换一个');
  });

  it('projects an old Cloud without Tool routes as a recoverable unavailable state', async () => {
    const { spaceErrorCode, spaceListTools } = await loadSpaceCloud();
    mocks.invoke.mockResolvedValueOnce({
      success: false,
      error: 'Route not found',
      code: 'NOT_FOUND',
      requestId: 'req_old_cloud',
    });

    let thrown: unknown;
    try {
      await spaceListTools({ spaceId: 'official' });
    } catch (error) {
      thrown = error;
    }
    expect(spaceErrorCode(thrown)).toBe('SPACE_TOOLS_UNAVAILABLE');
    expect(thrown).toMatchObject({ httpStatus: 404, retryable: true });
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('当前服务暂不可用，请稍后重试。');
  });

  it('returns Space data from successful envelopes', async () => {
    const { spaceCommentIssue } = await loadSpaceCloud();
    const comment = {
      id: 'cmt_1',
      author: { id: 'user-1', type: 'user' },
      body: 'hello',
      createdAt: '2026-06-24T00:00:00.000Z',
    };
    mocks.invoke.mockResolvedValueOnce({ comment });

    await expect(spaceCommentIssue('iss_123', 'hello')).resolves.toEqual({
      comment: { ...comment, attachments: [] },
    });
  });

  it('sends create and comment files through atomic Rust mutation commands', async () => {
    const { spaceCommentIssue, spaceCreateIssue } = await loadSpaceCloud();
    mocks.invoke
      .mockResolvedValueOnce({ issue: { id: 'iss_1' } })
      .mockResolvedValueOnce({
        comment: {
          id: 'cmt_1',
          author: { id: 'user-1', type: 'user' },
          body: '',
          attachments: [{ id: 'att_1', name: 'trace.log', sizeBytes: 4, createdAt: '2026-07-12T00:00:00Z' }],
          createdAt: '2026-07-12T00:00:00Z',
        },
      });

    await spaceCreateIssue({ title: 'Issue', body: 'Body', filePaths: ['/tmp/a.png'] }, 'official');
    await spaceCommentIssue('iss_1', '', ['/tmp/trace.log']);

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'cmd_space_create_issue_with_attachments', {
      input: expect.objectContaining({ spaceId: 'official', filePaths: ['/tmp/a.png'] }),
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'cmd_space_comment_issue_with_attachments', {
      input: { issueId: 'iss_1', body: '', filePaths: ['/tmp/trace.log'] },
    });
  });

  it('normalizes legacy comment attachment fields without merging them into top attachments', async () => {
    const { spaceGetIssue } = await loadSpaceCloud();
    mocks.invoke.mockResolvedValueOnce({
      success: true,
      data: {
        issue: { id: 'iss_1' },
        attachments: [{ id: 'att_top', name: 'top.pdf', sizeBytes: 1, createdAt: '2026-07-12T00:00:00Z' }],
        comments: {
          items: [{ id: 'cmt_1', author: { id: 'u-1', type: 'user' }, body: 'legacy', createdAt: '2026-07-12T00:00:00Z' }],
          hasMore: false,
          limit: 5,
        },
      },
    });

    const detail = await spaceGetIssue('iss_1');
    expect(detail.attachments.map(item => item.id)).toEqual(['att_top']);
    expect(detail.comments.items[0]?.attachments).toEqual([]);
  });

  it('routes Tool reads and MCP mutations through the typed Space facade', async () => {
    const {
      spaceDeleteTool,
      spaceGetTool,
      spaceListToolRevisions,
      spaceListTools,
      spacePublishMcpTool,
      spaceRollbackTool,
      spaceUpdateMcpTool,
    } = await loadSpaceCloud();
    mocks.invoke.mockResolvedValue({ success: true, data: {} });
    const manifest = {
      schemaVersion: 1 as const,
      serverId: 'team-mcp',
      transport: 'stdio' as const,
      stdio: { command: 'npx', args: ['-y', '@example/team-mcp'], envTemplates: {} },
      requiredConfigKeys: [],
    };

    await spaceListTools({ spaceId: 'space 1', cursor: 'next/cursor', limit: 30 });
    await spaceGetTool('tool/1');
    await spaceListToolRevisions({ toolId: 'tool/1', cursor: 'rev/cursor', limit: 20 });
    await spacePublishMcpTool({ spaceId: 'space 1', name: 'Team MCP', portableMcpManifest: manifest });
    await spaceUpdateMcpTool({
      toolId: 'tool/1',
      name: 'Team MCP',
      portableMcpManifest: manifest,
      expectedLatestRevision: 3,
    });
    await spaceRollbackTool({ toolId: 'tool/1', revision: 2, expectedCurrentRevision: 3 });
    await spaceDeleteTool('tool/1');

    const calls = mocks.invoke.mock.calls.map(([, args]) => args.input);
    expect(calls).toEqual([
      { method: 'GET', path: '/api/spaces/space%201/tools?cursor=next%2Fcursor&limit=30', body: null },
      { method: 'GET', path: '/api/tools/tool%2F1', body: null },
      { method: 'GET', path: '/api/tools/tool%2F1/revisions?cursor=rev%2Fcursor&limit=20', body: null },
      {
        method: 'POST',
        path: '/api/spaces/space%201/tools',
        body: {
          kind: 'mcp',
          name: 'Team MCP',
          description: '',
          portableMcpManifest: manifest,
        },
      },
      {
        method: 'POST',
        path: '/api/tools/tool%2F1/revisions',
        body: {
          kind: 'mcp',
          name: 'Team MCP',
          description: '',
          portableMcpManifest: manifest,
          expectedLatestRevision: 3,
        },
      },
      {
        method: 'POST',
        path: '/api/tools/tool%2F1/rollback',
        body: { revision: 2, expectedCurrentRevision: 3 },
      },
      { method: 'DELETE', path: '/api/tools/tool%2F1', body: null },
    ]);
  });

  it('routes custom Tool icon mutations through Rust instead of renderer file reads', async () => {
    const { spacePublishCustomTool, spaceUpdateCustomTool } = await loadSpaceCloud();
    mocks.invoke.mockResolvedValue({});

    await spacePublishCustomTool({
      spaceId: 'official',
      name: 'FFmpeg',
      description: 'Video tools',
      customInstallInstruction: 'brew install ffmpeg',
      iconFilePath: '/tmp/icon.png',
    });
    await spaceUpdateCustomTool({
      toolId: 'tool-1',
      name: 'FFmpeg',
      description: 'Video tools',
      customInstallInstruction: 'brew install ffmpeg',
      expectedLatestRevision: 1,
      resetIcon: true,
    });

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'cmd_space_publish_custom_tool', {
      input: {
        spaceId: 'official',
        name: 'FFmpeg',
        description: 'Video tools',
        customInstallInstruction: 'brew install ffmpeg',
        iconFilePath: '/tmp/icon.png',
      },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'cmd_space_update_custom_tool', {
      input: {
        toolId: 'tool-1',
        name: 'FFmpeg',
        description: 'Video tools',
        customInstallInstruction: 'brew install ffmpeg',
        expectedLatestRevision: 1,
        resetIcon: true,
      },
    });
  });
});
