import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import UserTagPills from './UserTagPills';

describe('UserTagPills', () => {
    beforeEach(async () => {
        await i18n.changeLanguage('zh-CN');
    });

    it('shows two Tags plus a read-only overflow and does not trigger the Session row', () => {
        const onRow = vi.fn();
        const onTag = vi.fn();
        render(
            <div role="button" onClick={onRow}>
                <UserTagPills tags={['Alpha', 'Beta', 'Gamma']} onTagClick={onTag} />
            </div>,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Alpha' }));
        expect(onTag).toHaveBeenCalledWith('Alpha');
        expect(onRow).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: i18n.t('common:sessionTags.showMore', { count: 1 }) }));
        fireEvent.click(screen.getByRole('button', { name: 'Gamma' }));
        expect(onTag).toHaveBeenLastCalledWith('Gamma');
        expect(onRow).not.toHaveBeenCalled();
    });

    it('returns focus to the overflow trigger when the popover is dismissed', async () => {
        render(<UserTagPills tags={['Alpha', 'Beta', 'Gamma']} onTagClick={vi.fn()} />);
        const trigger = screen.getByRole('button', {
            name: i18n.t('common:sessionTags.showMore', { count: 1 }),
        });
        fireEvent.click(trigger);
        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(trigger).toHaveFocus());
    });
});
