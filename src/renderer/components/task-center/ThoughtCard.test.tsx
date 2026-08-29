import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Thought } from '@/../shared/types/thought';
import { ThoughtCard } from './ThoughtCard';

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({ projects: [] }),
}));

const THOUGHT: Thought = {
  id: 'thought-1',
  content: '单击进入编辑',
  tags: [],
  images: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  convertedTaskIds: [],
};

describe('ThoughtCard', () => {
  it('enters inline editing from the whole card with one click', async () => {
    const user = userEvent.setup();
    render(<ThoughtCard thought={THOUGHT} onChanged={vi.fn()} />);

    await user.click(
      screen.getByRole('button', { name: `编辑: ${THOUGHT.content}` }),
    );

    expect(screen.getByRole('textbox')).toHaveValue(THOUGHT.content);
  });

  it('keeps floating controls independent from the card edit action', async () => {
    const user = userEvent.setup();
    render(<ThoughtCard thought={THOUGHT} onChanged={vi.fn()} />);

    await user.click(screen.getByTitle('更多操作'));

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument();
  });

  it('keeps AI discussion out of the More menu', async () => {
    const user = userEvent.setup();
    render(
      <ThoughtCard
        thought={THOUGHT}
        onChanged={vi.fn()}
        onDiscuss={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'AI 讨论' })).toBeInTheDocument();
    await user.click(screen.getByTitle('更多操作'));
    expect(screen.getAllByRole('button', { name: 'AI 讨论' })).toHaveLength(1);
  });
});
