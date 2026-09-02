import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import SessionRenameDialog from './SessionRenameDialog';

describe('SessionRenameDialog', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh-CN');
  });

  it('prefills and selects the current title, then trims an Enter submission', async () => {
    const onConfirm = vi.fn(async () => undefined);
    render(
      <SessionRenameDialog
        currentTitle="Current title"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const input = screen.getByLabelText(i18n.t('launcher:rightRail.renameDialogLabel')) as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Current title'.length);
    expect(input).toHaveAttribute('maxlength', '100');

    fireEvent.change(input, { target: { value: '  Renamed title  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Renamed title'));
  });

  it('disables empty submissions and preserves the draft after a failed save', async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error('disk unavailable');
    });
    render(
      <SessionRenameDialog
        currentTitle="Current title"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const input = screen.getByLabelText(i18n.t('launcher:rightRail.renameDialogLabel'));
    const save = screen.getByRole('button', { name: i18n.t('common:actions.save') });
    fireEvent.change(input, { target: { value: '   ' } });
    expect(save).toBeDisabled();

    fireEvent.change(input, { target: { value: 'Keep this draft' } });
    fireEvent.click(save);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      i18n.t('launcher:rightRail.renameFailedRetry'),
    );
    expect(input).toHaveValue('Keep this draft');
    expect(save).not.toBeDisabled();
  });

  it('closes on Escape and keeps keyboard focus inside the dialog', () => {
    const onCancel = vi.fn();
    render(
      <SessionRenameDialog
        currentTitle="Current title"
        onConfirm={vi.fn(async () => undefined)}
        onCancel={onCancel}
      />,
    );

    const close = screen.getByRole('button', { name: i18n.t('common:actions.close') });
    const save = screen.getByRole('button', { name: i18n.t('common:actions.save') });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(save).toHaveFocus();

    fireEvent.keyDown(save, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
