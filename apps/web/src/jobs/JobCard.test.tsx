import { render, screen } from '@testing-library/react';
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

  test('employer with advertiser reads "via"', () => {
    render(<JobCard job={{ ...baseJob, employer: 'Acme', advertiser: 'Hays' }} />);
    expect(screen.getByText('Acme via Hays')).toBeInTheDocument();
  });

  test('shows match score or not-scored label, and status', () => {
    const { rerender } = render(<JobCard job={{ ...baseJob, matchScore: 82, status: 'cv_ready' }} />);
    expect(screen.getByText('82%')).toBeInTheDocument();
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
    expect(screen.getByText('Reading job…')).toBeInTheDocument();
    rerender(<JobCard job={{ ...baseJob, extractionStatus: 'in_progress' }} />);
    expect(screen.getByText('Reading job…')).toBeInTheDocument();
  });

  test('shows short description', () => {
    render(<JobCard job={{ ...baseJob, shortDescription: 'Build things.' }} />);
    expect(screen.getByText('Build things.')).toBeInTheDocument();
  });
});
