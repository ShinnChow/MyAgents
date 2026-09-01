import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getSessions: vi.fn(),
    getSessionUserTags: vi.fn(),
    mutateSessionUserTagAssignment: vi.fn(),
    mutateGlobalSessionUserTag: vi.fn(),
}));

vi.mock('@/api/sessionClient', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/api/sessionClient')>();
    return { ...actual, ...mocks };
});

import { i18n } from '@/i18n';
import { SessionUserTagApiError } from '@/api/sessionClient';
import SessionTagMenuItem from './SessionTagMenuItem';

describe('SessionTagMenuItem', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await i18n.changeLanguage('zh-CN');
        mocks.getSessionUserTags.mockResolvedValue([
            { name: 'Alpha', count: 2 },
            { name: 'Beta', count: 1 },
        ]);
        mocks.getSessions.mockResolvedValue([]);
    });

    it('keeps the checkbox picker open while adding and removing canonical Tags', async () => {
        const onSessionUpdated = vi.fn().mockReturnValue(true);
        mocks.mutateSessionUserTagAssignment
            .mockResolvedValueOnce({
                action: 'updated', affectedSessionCount: 1,
                tags: [{ name: 'Alpha', count: 2 }, { name: 'Beta', count: 2 }],
                session: { id: 'session-1', userTags: ['Alpha', 'Beta'] },
            })
            .mockResolvedValueOnce({
                action: 'updated', affectedSessionCount: 1,
                tags: [{ name: 'Beta', count: 2 }],
                session: { id: 'session-1', userTags: ['Beta'] },
            });
        render(
            <SessionTagMenuItem
                session={{ id: 'session-1', userTags: ['Alpha'] }}
                onMutationStart={vi.fn().mockReturnValue(1)}
                onSessionUpdated={onSessionUpdated}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: i18n.t('common:sessionTags.addTag') }));
        await screen.findByRole('menuitemcheckbox', { name: /Beta/ });
        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Beta/ }));
        await waitFor(() => expect(mocks.mutateSessionUserTagAssignment).toHaveBeenCalledWith(
            'session-1', { kind: 'add', name: 'Beta' },
        ));
        expect(screen.getByRole('menuitemcheckbox', { name: /Beta/ })).toHaveAttribute('aria-checked', 'true');

        fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /Alpha/ }));
        await waitFor(() => expect(mocks.mutateSessionUserTagAssignment).toHaveBeenLastCalledWith(
            'session-1', { kind: 'remove', name: 'Alpha' },
        ));
        expect(onSessionUpdated).toHaveBeenCalledTimes(2);
        expect(screen.getByPlaceholderText(i18n.t('common:sessionTags.searchTags'))).toBeInTheDocument();
    });

    it('offers creation and disables additional assignments at the five-Tag cap', async () => {
        mocks.getSessionUserTags.mockResolvedValue([
            { name: 'A', count: 1 }, { name: 'B', count: 1 }, { name: 'C', count: 1 },
            { name: 'D', count: 1 }, { name: 'E', count: 1 }, { name: 'Free', count: 1 },
        ]);
        render(
            <SessionTagMenuItem
                session={{ id: 'session-1', userTags: ['A', 'B', 'C', 'D', 'E'] }}
                onMutationStart={vi.fn().mockReturnValue(1)}
                onSessionUpdated={vi.fn().mockReturnValue(true)}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: i18n.t('common:sessionTags.addTag') }));
        const input = await screen.findByPlaceholderText(i18n.t('common:sessionTags.searchTags'));
        await screen.findByRole('menuitemcheckbox', { name: /Free/ });
        expect(screen.getByRole('menuitemcheckbox', { name: /Free/ })).toBeDisabled();
        expect(screen.getByRole('menuitemcheckbox', { name: /A/ })).not.toBeDisabled();

        fireEvent.change(input, { target: { value: 'New Tag' } });
        expect(screen.getByRole('menuitem', { name: /创建「New Tag」/ })).toBeDisabled();
        expect(screen.getByText(i18n.t('common:sessionTags.limitHint', { count: 5 }))).toBeInTheDocument();
    });

    it('opens global management and renames every assignment through one batch mutation', async () => {
        const onGlobalTagChange = vi.fn();
        mocks.mutateGlobalSessionUserTag.mockResolvedValue({
            action: 'updated',
            affectedSessionCount: 2,
            tags: [{ name: 'Gamma', count: 2 }, { name: 'Beta', count: 1 }],
            session: { id: 'session-1', userTags: ['Gamma'] },
        });
        render(
            <SessionTagMenuItem
                session={{ id: 'session-1', userTags: ['Alpha'] }}
                onMutationStart={vi.fn().mockReturnValue(1)}
                onSessionUpdated={vi.fn().mockReturnValue(true)}
                onGlobalTagChange={onGlobalTagChange}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: i18n.t('common:sessionTags.addTag') }));
        await screen.findByRole('button', { name: i18n.t('common:sessionTags.manageTags') });
        fireEvent.click(screen.getByRole('button', { name: i18n.t('common:sessionTags.manageTags') }));
        fireEvent.click(await screen.findByRole('button', { name: i18n.t('common:sessionTags.manager.rename', { name: 'Alpha' }) }));
        const renameInput = screen.getByRole('textbox', { name: i18n.t('common:sessionTags.manager.renameInput', { name: 'Alpha' }) });
        fireEvent.change(renameInput, { target: { value: 'Gamma' } });
        fireEvent.click(screen.getByRole('button', { name: i18n.t('common:sessionTags.manager.save') }));

        await waitFor(() => expect(mocks.mutateGlobalSessionUserTag).toHaveBeenCalledWith({
            kind: 'rename', name: 'Alpha', newName: 'Gamma', merge: false,
        }, 'session-1'));
        expect(onGlobalTagChange).toHaveBeenCalledWith({ kind: 'rename', name: 'Alpha', newName: 'Gamma' });
    });

    it('normalizes the candidate query so decomposed Unicode finds an existing Tag', async () => {
        mocks.getSessionUserTags.mockResolvedValue([{ name: 'Café', count: 1 }]);
        render(
            <SessionTagMenuItem
                session={{ id: 'session-1', userTags: [] }}
                onMutationStart={vi.fn().mockReturnValue(1)}
                onSessionUpdated={vi.fn().mockReturnValue(true)}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: i18n.t('common:sessionTags.addTag') }));
        const input = await screen.findByPlaceholderText(i18n.t('common:sessionTags.searchTags'));
        fireEvent.change(input, { target: { value: 'Cafe\u0301' } });

        expect(screen.getByRole('menuitemcheckbox', { name: /Café/ })).toBeInTheDocument();
        expect(screen.queryByText(/创建「/)).not.toBeInTheDocument();
    });

    it('keeps the mutation error while reconciling the target Session from fresh authority', async () => {
        const onSessionUpdated = vi.fn().mockReturnValue(true);
        mocks.mutateSessionUserTagAssignment.mockRejectedValue(
            new SessionUserTagApiError('limit-reached', 'limit', 409),
        );
        mocks.getSessions.mockResolvedValue([{
            id: 'session-1',
            agentDir: '/workspace',
            title: 'Session',
            createdAt: '2026-09-02T00:00:00.000Z',
            lastActiveAt: '2026-09-02T00:00:00.000Z',
            userTags: ['Alpha'],
        }]);
        render(
            <SessionTagMenuItem
                session={{ id: 'session-1', userTags: ['Alpha'] }}
                onMutationStart={vi.fn().mockReturnValue(8)}
                onSessionUpdated={onSessionUpdated}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: i18n.t('common:sessionTags.addTag') }));
        fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: /Beta/ }));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            i18n.t('common:sessionTags.errors.limitReached'),
        );
        expect(onSessionUpdated).toHaveBeenCalledWith(expect.objectContaining({ userTags: ['Alpha'] }), 8);
    });

    it('focuses and traps the manager dialog, then restores the menu anchor on Escape', async () => {
        render(
            <SessionTagMenuItem
                session={{ id: 'session-1', userTags: ['Alpha'] }}
                onMutationStart={vi.fn().mockReturnValue(1)}
                onSessionUpdated={vi.fn().mockReturnValue(true)}
            />,
        );
        const anchor = screen.getByRole('button', { name: i18n.t('common:sessionTags.addTag') });
        fireEvent.click(anchor);
        fireEvent.click(await screen.findByRole('button', { name: i18n.t('common:sessionTags.manageTags') }));
        const dialog = await screen.findByRole('dialog');
        await waitFor(() => expect(within(dialog).getByRole('button', { name: i18n.t('common:sessionTags.close') })).toHaveFocus());

        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(anchor).toHaveFocus();
    });
});
