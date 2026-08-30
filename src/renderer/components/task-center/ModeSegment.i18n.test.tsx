import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import ModeSegment from './ModeSegment';

describe('ModeSegment i18n', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US');
  });

  it('renders mode labels and tab hints in English', () => {
    const onChange = vi.fn();
    render(<ModeSegment value="chat" onChange={onChange} tabSwitchHint />);

    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute(
      'title',
      'Press Tab to switch to Records',
    );
    expect(screen.getByRole('button', { name: 'Records' })).toHaveAttribute(
      'title',
      'Press Tab to switch to Chat',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Records' }));
    expect(onChange).toHaveBeenCalledWith('record');
  });
});
