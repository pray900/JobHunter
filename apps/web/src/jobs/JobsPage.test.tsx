import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { fetchJobs } from '../api/client';
import { JobsPage } from './JobsPage';
import { job } from './jobFixtures';

vi.mock('../api/client', () => ({ fetchJobs: vi.fn() }));
const mockFetch = vi.mocked(fetchJobs);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('JobsPage', () => {
  test('renders chips with counts and filters on click', async () => {
    mockFetch.mockResolvedValue([
      job({ id: '1', title: 'Alpha Role', status: 'new' }),
      job({ id: '2', title: 'Beta Role', status: 'applied' }),
    ]);
    render(<JobsPage />);
    expect(await screen.findByText('Alpha Role')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All (2)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CV ready (0)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Applied (1)' }));
    expect(screen.queryByText('Alpha Role')).not.toBeInTheDocument();
    expect(screen.getByText('Beta Role')).toBeInTheDocument();
  });

  test('search box filters cards', async () => {
    mockFetch.mockResolvedValue([job({ id: '1', title: 'Alpha Role' }), job({ id: '2', title: 'Beta Role' })]);
    render(<JobsPage />);
    await screen.findByText('Alpha Role');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search jobs' }), 'beta');
    expect(screen.queryByText('Alpha Role')).not.toBeInTheDocument();
    expect(screen.getByText('Beta Role')).toBeInTheDocument();
  });

  test('shows error with retry', async () => {
    mockFetch.mockRejectedValueOnce(new Error('boom'));
    mockFetch.mockResolvedValueOnce([job({ id: '1', title: 'Alpha Role' })]);
    render(<JobsPage />);
    expect(await screen.findByText("Couldn't load jobs. Is the backend running?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Alpha Role')).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('shows empty state', async () => {
    mockFetch.mockResolvedValue([]);
    render(<JobsPage />);
    expect(await screen.findByText('No jobs yet. Add a Word file to your Joblisting folder.')).toBeInTheDocument();
  });

  test('shows loading first', async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<JobsPage />);
    expect(screen.getByText('Loading jobs…')).toBeInTheDocument();
  });

  test('auto-refreshes every 15 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockFetch.mockResolvedValue([job({ id: '1', title: 'Alpha Role' })]);
      render(<JobsPage />);
      await screen.findByText('Alpha Role');
      expect(mockFetch).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });
});
