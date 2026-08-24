import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ThoughtBulkBar } from './ThoughtBulkBar';

describe('ThoughtBulkBar', () => {
  it('explains and disables merge when selection contains audio', () => {
    const onMerge = vi.fn();
    render(
      <ThoughtBulkBar
        count={2}
        onMerge={onMerge}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onCancel={vi.fn()}
        viewMode="active"
        mergeDisabledReason="语音记录不能合并；可继续归档或删除"
      />,
    );

    expect(
      screen.getByText('语音记录不能合并；可继续归档或删除'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '合并' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '归档' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '删除' })).toBeEnabled();
  });
});
