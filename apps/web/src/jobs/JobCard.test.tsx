import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test } from 'vitest';
import { JobCard } from './JobCard';
import { baseJob } from './jobFixtures';

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
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    rerender(<JobCard job={{ ...baseJob, url: 'not a url' }} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
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
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  test('shows reading state while extraction is pending or in progress', () => {
    const { rerender } = render(<JobCard job={{ ...baseJob, extractionStatus: 'pending' }} />);
    expect(screen.getByText('Reading jobâ€¦')).toBeInTheDocument();
    rerender(<JobCard job={{ ...baseJob, extractionStatus: 'in_progress' }} />);
    expect(screen.getByText('Reading jobâ€¦')).toBeInTheDocument();
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
    const { rerender } = render(
      <MemoryRouter>
        <JobCard job={baseJob} noReadyCv />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Add a base CV to get match scores' })).toHaveAttribute('href', '/documents');
    rerender(
      <MemoryRouter>
        <JobCard job={{ ...baseJob, matchScore: 80, scoreStatus: 'done' }} noReadyCv />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Add a base CV to get match scores')).not.toBeInTheDocument();
  });
});
