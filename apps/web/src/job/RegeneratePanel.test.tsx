import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as client from '../api/client';
import { RegeneratePanel } from './RegeneratePanel';

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return { ...actual, generate: vi.fn() };
});
const m = vi.mocked(client);

beforeEach(() => vi.resetAllMocks());

const setup = (over: Partial<React.ComponentProps<typeof RegeneratePanel>> = {}) => {
  const onStarted = vi.fn();
  render(<RegeneratePanel jobId="j1" fromVersionId="v3" running={false} onStarted={onStarted} {...over} />);
  return { onStarted };
};

describe('RegeneratePanel', () => {
  test('regenerate sends instruction and the shown version', async () => {
    m.generate.mockResolvedValue({ runId: 'r1' });
    const { onStarted } = setup();
    await userEvent.type(screen.getByLabelText(/instruction/i), '  Lead with Apex  ');
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(m.generate).toHaveBeenCalledWith('j1', { instruction: 'Lead with Apex', fromVersionId: 'v3' }));
    expect(onStarted).toHaveBeenCalled();
    expect(screen.getByText("Claude keeps your edits exactly as you wrote them. It will never add facts that aren't in your base CV.")).toBeInTheDocument();
  });

  test('M9: the counter counts characters of the trimmed text, as the server does', () => {
    setup();
    fireEvent.change(screen.getByLabelText(/instruction/i), { target: { value: '   hi   ' } });
    expect(screen.getByText('2 / 1000')).toBeInTheDocument();
    // An emoji is one character, not two.
    fireEvent.change(screen.getByLabelText(/instruction/i), { target: { value: '😀'.repeat(1000) } });
    expect(screen.getByText('1000 / 1000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeEnabled();
  });

  test('instruction over 1000 chars is blocked', () => {
    setup();
    fireEvent.change(screen.getByLabelText(/instruction/i), { target: { value: 'x'.repeat(1001) } });
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled();
    expect(screen.getByText(/1001 \/ 1000/)).toBeInTheDocument();
    expect(screen.getByText(/too long/i)).toBeInTheDocument();
  });

  test('empty instruction is blocked', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled();
  });

  test('regenerate disabled while running', () => {
    setup({ running: true });
    expect(screen.getByLabelText(/instruction/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeDisabled();
  });

  test('shows 400 and 409 messages', async () => {
    m.generate.mockRejectedValueOnce(new client.ApiError(400, 'x', 'bad_instruction'));
    setup();
    await userEvent.type(screen.getByLabelText(/instruction/i), 'hi');
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/1 to 1000/);
    m.generate.mockRejectedValueOnce(new client.ApiError(409, 'x', 'generation_in_progress'));
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/already running/i));
  });
});
