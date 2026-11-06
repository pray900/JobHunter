import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { fetchDocuments, fetchJobs } from '../api/client';
import { JobsPage } from './JobsPage';
import { job } from './jobFixtures';

vi.mock('../api/client', () => ({ fetchJobs: vi.fn(), fetchDocuments: vi.fn() }));
const mockDocs = vi.mocked(fetchDocuments);
const mockFetch = vi.mocked(fetchJobs);

beforeEach(() => {
  mockFetch.mockReset();
  mockDocs.mockReset();
  mockDocs.mockResolvedValue({ cv: null, coverLetter: null });
});

describe('JobsPage', () => {
  test('renders chips with counts and filters on click', async () => {
    mockFetch.mockResolvedValue([
      job({ id: '1', title: 'Alpha Role', status: 'new' }),
      job({ id: '2', title: 'Beta Role', status: 'applied' }),
    ]);
    render(<JobsPage />, { wrapper: MemoryRouter });
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
    render(<JobsPage />, { wrapper: MemoryRouter });
    await screen.findByText('Alpha Role');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search jobs' }), 'beta');
    expect(screen.queryByText('Alpha Role')).not.toBeInTheDocument();
    expect(screen.getByText('Beta Role')).toBeInTheDocument();
  });

  test('shows error with retry', async () => {
    mockFetch.mockRejectedValueOnce(new Error('boom'));
    mockFetch.mockResolvedValueOnce([job({ id: '1', title: 'Alpha Role' })]);
    render(<JobsPage />, { wrapper: MemoryRouter });
    expect(await screen.findByText("Couldn't load jobs. Is the backend running?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Alpha Role')).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('shows empty state', async () => {
    mockFetch.mockResolvedValue([]);
    render(<JobsPage />, { wrapper: MemoryRouter });
    expect(await screen.findByText('No jobs yet. Add a Word file to your Joblisting folder.')).toBeInTheDocument();
  });

  test('shows loading first', async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<JobsPage />, { wrapper: MemoryRouter });
    expect(screen.getByText('Loading jobs…')).toBeInTheDocument();
  });

  test('skips a refresh tick while a request is still in flight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockFetch.mockReturnValue(new Promise(() => {}));
      render(<JobsPage />, { wrapper: MemoryRouter });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('auto-refreshes every 15 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockFetch.mockResolvedValue([job({ id: '1', title: 'Alpha Role' })]);
      render(<JobsPage />, { wrapper: MemoryRouter });
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

  test('hint to add a CV only appears when no ready CV exists', async () => {
    mockFetch.mockResolvedValue([job({ id: '1', title: 'Alpha Role' })]);
    const { unmount } = render(<JobsPage />, { wrapper: MemoryRouter });
    expect(await screen.findByText('Add a base CV to get match scores')).toBeInTheDocument();
    unmount();
    mockDocs.mockResolvedValue({
      cv: {
        id: 'c',
        kind: 'cv',
        sourceRef: 'cv.pdf',
        analysisStatus: 'done',
        analysisError: null,
        warnings: [],
        updatedAt: '',
      },
      coverLetter: null,
    });
    render(<JobsPage />, { wrapper: MemoryRouter });
    await screen.findByText('Alpha Role');
    await waitFor(() => expect(mockDocs).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Add a base CV to get match scores')).not.toBeInTheDocument();
  });
});
