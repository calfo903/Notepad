import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AIPanel } from '../components/AIPanel';
import type { AIMemory } from '../types';

const MEMORY: AIMemory = {
  userPreferences: {},
  conversationHistory: [],
  noteContext: { recentNotes: [], commonTags: [] },
};

const NOTE = 'Draft of the quarterly plan';

function setup(overrides: Partial<React.ComponentProps<typeof AIPanel>> = {}) {
  // Params must be declared: vi.fn infers an empty tuple from a bare
  // zero-argument async function, and mock.calls[0][1] then does not typecheck.
  const onChat = vi.fn(
    async (
      _message: string,
      _options?: { noteContent?: string; noteTitle?: string; stream?: boolean }
    ): Promise<string> => 'a reply'
  );
  const onToggleExcludeFromAi = vi.fn();

  render(
    <AIPanel
      isOpen
      memory={MEMORY}
      isLoading={false}
      error={null}
      streamingResponse=""
      noteContent={NOTE}
      noteTitle="Quarterly"
      onClose={() => {}}
      onChat={onChat}
      onQuickAction={vi.fn(async () => '')}
      onGenerateContent={vi.fn(async () => '')}
      onStopGeneration={() => {}}
      onClearHistory={() => {}}
      onSetPreference={() => {}}
      onToggleExcludeFromAi={onToggleExcludeFromAi}
      {...overrides}
    />
  );

  return { onChat, onToggleExcludeFromAi };
}

async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
  const box = screen.getByPlaceholderText('Ask AI anything...');
  await user.type(box, `${text}{Enter}`);
}

describe('AI panel — note exclusion', () => {
  beforeEach(() => localStorage.clear());

  it('sends the note content by default', async () => {
    const user = userEvent.setup();
    const { onChat } = setup();

    await ask(user, 'summarise this');

    expect(onChat).toHaveBeenCalledTimes(1);
    expect(onChat.mock.calls[0][1]?.noteContent).toBe(NOTE);
  });

  it('withholds the note content when the note is excluded', async () => {
    const user = userEvent.setup();
    const { onChat } = setup({ noteExcludedFromAi: true });

    await ask(user, 'summarise this');

    expect(onChat).toHaveBeenCalledTimes(1);
    // The message still goes; the note does not.
    expect(onChat.mock.calls[0][0]).toBe('summarise this');
    expect(onChat.mock.calls[0][1]?.noteContent).toBeUndefined();
  });

  it('says what the exclusion means instead of showing a warning', () => {
    setup({ noteExcludedFromAi: true });

    expect(screen.getByRole('status')).toHaveTextContent(/excluded/i);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reflects the exclusion in the toggle', () => {
    setup({ noteExcludedFromAi: true });

    expect(screen.getByRole('switch', { name: /exclude this note/i })).toBeChecked();
  });

  it('reports the toggle back to the parent', async () => {
    const user = userEvent.setup();
    const { onToggleExcludeFromAi } = setup({ noteExcludedFromAi: false });

    await user.click(screen.getByRole('switch', { name: /exclude this note/i }));

    expect(onToggleExcludeFromAi).toHaveBeenCalledWith(true);
  });
});

describe('AI panel — sensitive content warning', () => {
  beforeEach(() => localStorage.clear());

  it('warns when the note looks like it holds a secret', () => {
    setup({ noteContent: 'my key is AKIAIOSFODNN7EXAMPLE' });

    expect(screen.getByRole('alert')).toHaveTextContent(/AWS access key/);
  });

  it('does not echo the secret back into the warning', () => {
    setup({ noteContent: 'my key is AKIAIOSFODNN7EXAMPLE' });

    expect(screen.getByRole('alert').textContent).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('stays quiet for ordinary prose', () => {
    setup({ noteContent: 'The review is on Thursday at 3pm.' });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('superseded by the exclusion notice', () => {
    setup({ noteContent: 'my key is AKIAIOSFODNN7EXAMPLE', noteExcludedFromAi: true });

    // Nothing is being sent, so warning about sending it would be noise.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
