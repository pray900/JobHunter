import { render as rtlRender, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as client from '../api/client';
import { JobCard } from './JobCard';
import { baseJob } from './jobFixtures';

vi.mock('../api/client', async () => ({
  ...(await vi.importActual<typeof import('../api/client')>('../api/client')),
  generate: vi.fn(),
}));

// Cards link to the job page, so they always render inside a router.
const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: MemoryRouter });

beforeEach(() => {
  vi.mocked(client.generate).mockReset();
});

describe('JobCard', () => {
  test('shows title, company via advertiser, and posting link', () => {
    render(
      <JobCard
        job={{ ...baseJob, title: 'Salesforce Developer', employer: null, advertiser: 'Redwolf + Rosch', url: 'https://au.seek.com/job/1' }}
      />,
    );
    expect(screen.getByText('Salesforce Developer')).toBeInTheDocument();
    expect(screen.getByText('Redwolf + Rosch')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /open job posting/i });
    expect(link).toHaveAttribute('href', 'https://au.seek.com/job/1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('omits the link for non-http(s) or unparseable urls', () => {
    const { rerender } = render(<JobCard job={{ ...baseJob, url: 'javascript:alert(1)' }} />);
    expect(screen.queryByRole('link', { name: /open job posting/i })).not.toBeInTheDocument();
    rerender(<JobCard job={{ ...baseJob, url: 'not a url' }} />);
    expect(screen.queryByRole('link', { name: /open job posting/i })).not.toBeInTheDocument();
    rerender(<JobCard job={{ ...baseJob, url: 'https://x.io/a' }} />);
    expect(screen.getByRole('link', { name: /open job posting/i })).toBeInTheDocument();
  });

  test('employer with advertiser reads "via"', () => {
    render(<JobCard job={{ ...baseJob, employer: 'Acme', advertiser: 'Hays' }} />);
    expect(screen.getByText('Acme via Hays')).toBeInTheDocument();
  });

  test('shows match score or not-scored label, and status', () => {
    const { rerender } = render(<JobCard job={{ ...baseJob, matchScore: 82, scoreStatus: 'done', status: 'cv_ready' }} />);
    expect(screen.getByText('82% match')).toBeInTheDocument();
    expect(screen.getByText('CV ready')).toBeInTheDocument();
    rerender(<JobCard job={baseJob} />);
    expect(screen.getByText('Not scored yet')).toBeInTheDocument();
  });

  test('shows warnings, removed badge and failed state, falling back to sourceRef title', () => {
    render(
      <JobCard
        job={{
          ...baseJob,
          title: null,
          sourceRef: 'mystery.docx',
          warnings: ['missing_url', 'unreadable_file', 'empty_description'],
          sourceRemoved: true,
          extractionStatus: 'failed',
        }}
      />,
    );
    expect(screen.getByText('mystery.docx')).toBeInTheDocument();
    expect(screen.getByText('No job link found on the first line')).toBeInTheDocument();
    expect(screen.getByText("Couldn't read this file")).toBeInTheDocument();
    expect(screen.getByText('No job description found')).toBeInTheDocument();
    expect(screen.getByText('Source file removed')).toBeInTheDocument();
    expect(screen.getByText('Details unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open job posting/i })).not.toBeInTheDocument();
  });

  test('shows reading state while extraction is pending or in progress', () => {
    const { rerender } = render(<JobCard job={{ ...baseJob, extractionStatus: 'pending' }} />);
    expect(screen.getByText('Reading job…')).toBeInTheDocument();
    rerender(<JobCard job={{ ...baseJob, extractionStatus: 'in_progress' }} />);
    expect(screen.getByText('Reading job…')).toBeInTheDocument();
  });

  test('shows short description', () => {
    render(<JobCard job={{ ...baseJob, shortDescription: 'Build things.' }} />);
    expect(screen.getByText('Build things.')).toBeInTheDocument();
  });

  test('why this score toggles the explanation and lists', async () => {
    render(
      <JobCard
        job={{
          ...baseJob,
          matchScore: 82,
          scoreStatus: 'done',
          matchExplanation: 'Strong Apex fit.',
          matchBreakdown: { matched: ['Apex', 'LWC'], missing: ['CPQ'], notes: [] },
        }}
      />,
    );
    expect(screen.queryByText('Strong Apex fit.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Why this score?' }));
    expect(screen.getByText('Strong Apex fit.')).toBeInTheDocument();
    expect(screen.getByText('Matched:')).toBeInTheDocument();
    expect(screen.getByText('Apex')).toBeInTheDocument();
    expect(screen.getByText('Missing:')).toBeInTheDocument();
    expect(screen.getByText('CPQ')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Why this score?' }));
    expect(screen.queryByText('Strong Apex fit.')).not.toBeInTheDocument();
  });

  test('score is decided by scoreStatus done, not just the number', () => {
    render(<JobCard job={{ ...baseJob, matchScore: 55, scoreStatus: 'pending' }} />);
    expect(screen.queryByText('55% match')).not.toBeInTheDocument();
  });

  test('shows scoring and failed states', () => {
    const { rerender } = render(<JobCard job={{ ...baseJob, scoreStatus: 'pending' }} />);
    expect(screen.getByText('Scoring…')).toBeInTheDocument();
    rerender(<JobCard job={{ ...baseJob, scoreStatus: 'in_progress' }} />);
    expect(screen.getByText('Scoring…')).toBeInTheDocument();
    rerender(<JobCard job={{ ...baseJob, scoreStatus: 'pending', extractionStatus: 'pending' }} />);
    expect(screen.queryByText('Scoring…')).not.toBeInTheDocument();
    rerender(<JobCard job={{ ...baseJob, scoreStatus: 'failed' }} />);
    expect(screen.getByText("Couldn't score this job")).toBeInTheDocument();
  });

  test('shows add-a-CV hint linking to documents', () => {
    const { rerender } = render(<JobCard job={baseJob} noReadyCv />);
    expect(screen.getByRole('link', { name: 'Add a base CV to get match scores' })).toHaveAttribute('href', '/documents');
    rerender(<JobCard job={{ ...baseJob, matchScore: 80, scoreStatus: 'done' }} noReadyCv />);
    expect(screen.queryByText('Add a base CV to get match scores')).not.toBeInTheDocument();
  });

  test('title links to the job page', () => {
    render(<JobCard job={{ ...baseJob, id: 'abc', title: 'Salesforce Developer' }} />);
    expect(screen.getByRole('link', { name: 'Salesforce Developer' })).toHaveAttribute('href', '/jobs/abc');
  });

  test('card shows Generate only for new jobs without a run', () => {
    const { rerender } = render(<JobCard job={baseJob} />);
    expect(screen.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
    rerender(<JobCard job={{ ...baseJob, status: 'cv_ready' }} />);
    expect(screen.queryByRole('button', { name: 'Generate' })).not.toBeInTheDocument();
    rerender(<JobCard job={{ ...baseJob, generation: { status: 'done', stage: 'saving', round: 1 }, hasVersion: true }} />);
    expect(screen.queryByRole('button', { name: 'Generate' })).not.toBeInTheDocument();
    rerender(<JobCard job={{ ...baseJob, generation: { status: 'in_progress', stage: 'writing', round: 2 } }} />);
    expect(screen.queryByRole('button', { name: 'Generate' })).not.toBeInTheDocument();
    expect(screen.getByText('Writing… round 2')).toBeInTheDocument();
    rerender(<JobCard job={{ ...baseJob, extractionStatus: 'pending' }} />);
    expect(screen.queryByRole('button', { name: 'Generate' })).not.toBeInTheDocument();
  });

  test('Generate queues a run and tells the page to refresh', async () => {
    vi.mocked(client.generate).mockResolvedValue({ runId: 'r1' });
    const onChanged = vi.fn();
    render(<JobCard job={{ ...baseJob, id: 'abc' }} onChanged={onChanged} />);
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(client.generate).toHaveBeenCalledWith('abc');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  test('Generate shows why it could not start', async () => {
    vi.mocked(client.generate).mockRejectedValue(new client.ApiError(422, 'x', 'base_cv_not_ready'));
    render(<JobCard job={baseJob} />);
    await userEvent.click(screen.getByRole('button', { name: 'Generate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("base CV isn't ready");
  });
});
