import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';
import { baseVersion, govVersion } from './detailFixtures';
import { CvPreview } from './DocumentPreview';

test('government preview has its headings, labels and competency lines, and no referees', () => {
  render(<CvPreview cv={govVersion.cv} templateId="au-government" />);
  expect(screen.queryByRole('heading', { name: 'Referees' })).toBeNull();
  for (const h of ['Professional Summary', 'Key Skills & Competencies', 'Professional Experience', 'Qualifications']) {
    expect(screen.getByRole('heading', { name: h })).toBeInTheDocument();
  }
  expect(screen.getByText('Responsibilities')).toBeInTheDocument();
  expect(screen.getByText('Key Achievements')).toBeInTheDocument();
  expect(screen.getByText('Cut case handling time by 30%.')).toBeInTheDocument();
  expect(screen.getByText('Stakeholder engagement').tagName).toBe('STRONG');
  expect(screen.getByText(/led a 12-agency working group/)).toBeInTheDocument();
  expect(screen.getByText('Policy writing').tagName).toBe('P');
  expect(screen.queryByText('Referees available on request')).toBeNull();
});

test('standard preview is unchanged', () => {
  render(<CvPreview cv={baseVersion.cv} templateId="standard-ats" />);
  expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
  expect(screen.queryByText('Referees available on request')).toBeNull();
});
