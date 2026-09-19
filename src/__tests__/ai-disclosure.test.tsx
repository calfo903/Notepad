import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AiDisclosure } from '../components/AiDisclosure';

/**
 * The disclosure is a compliance control, not decoration: it is the only place
 * the user is told a model is involved and that note content leaves the device.
 * These tests pin that it renders, that it survives a reload once dismissed, and
 * that it does not nag forever.
 */

describe('AiDisclosure', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders on first use', () => {
    render(<AiDisclosure providerLabel="NoteFlow AI" />);

    expect(screen.getByRole('note')).toBeInTheDocument();
  });

  it('names the provider the content is actually sent to', () => {
    render(<AiDisclosure providerLabel="NoteFlow AI" />);

    expect(screen.getByRole('note').textContent).toContain('NoteFlow AI');
  });

  it('states that output may be wrong', () => {
    render(<AiDisclosure providerLabel="NoteFlow AI" />);

    expect(screen.getByRole('note').textContent).toMatch(/may be inaccurate/i);
  });

  it('hides when dismissed', async () => {
    const user = userEvent.setup();
    render(<AiDisclosure providerLabel="NoteFlow AI" />);

    await user.click(screen.getByLabelText('Dismiss AI notice'));

    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('stays hidden after a reload, so dismissal is not per-session nagging', async () => {
    const user = userEvent.setup();
    const first = render(<AiDisclosure providerLabel="NoteFlow AI" />);
    await user.click(screen.getByLabelText('Dismiss AI notice'));
    first.unmount();

    render(<AiDisclosure providerLabel="NoteFlow AI" />);

    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('shows again for a user who has never dismissed it', () => {
    window.localStorage.setItem('noteflow-ai-disclosure-dismissed', 'false');

    render(<AiDisclosure providerLabel="NoteFlow AI" />);

    expect(screen.getByRole('note')).toBeInTheDocument();
  });

  it('treats corrupt persisted state as not-dismissed rather than crashing', () => {
    window.localStorage.setItem('noteflow-ai-disclosure-dismissed', '{not json');

    expect(() => render(<AiDisclosure providerLabel="X" />)).not.toThrow();
    expect(screen.getByRole('note')).toBeInTheDocument();
  });
});
