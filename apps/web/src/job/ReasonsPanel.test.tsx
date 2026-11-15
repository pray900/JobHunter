import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { baseDetail, baseVersion, govVersion } from './detailFixtures';
import { ReasonsPanel } from './ReasonsPanel';

const panel = () => screen.getByRole('region', { name: 'Selection criteria' });

describe('ReasonsPanel selection criteria', () => {
  test('lists each criterion with where it is answered', () => {
    render(<ReasonsPanel job={baseDetail.job} version={govVersion} />);
    expect(within(panel()).getByRole('heading', { name: 'Selection criteria' })).toBeInTheDocument();
    expect(within(panel()).getByText('Demonstrated stakeholder engagement')).toBeInTheDocument();
    expect(within(panel()).getByText('Key Achievements — role 1')).toBeInTheDocument();
    expect(within(panel()).getByText('Cover letter')).toBeInTheDocument();
  });

  test('an unanswered criterion shows a warning, the words and the reason', () => {
    render(<ReasonsPanel job={baseDetail.job} version={govVersion} />);
    const item = within(panel()).getByText('Budget management').closest('li')!;
    expect(item).toHaveTextContent('⚠');
    expect(item).toHaveTextContent('Not answered');
    expect(item).toHaveTextContent('Not in your base CV.');
    expect(item.className).toContain('attention-text');
  });

  test('an answer removed by an edit is flagged', () => {
    const edited = { ...govVersion, cv: { ...govVersion.cv, experience: [{ ...govVersion.cv.experience[0]!, achievements: [] }] } };
    render(<ReasonsPanel job={baseDetail.job} version={edited} />);
    const item = within(panel()).getByText('Demonstrated stakeholder engagement').closest('li')!;
    expect(item).toHaveTextContent('Not answered (removed by your edit)');
    expect(item).toHaveTextContent('⚠');
  });

  test('a blank competency or summary counts as removed', () => {
    const v = {
      ...govVersion,
      cv: { ...govVersion.cv, summary: ' ', competencies: ['', 'x'] },
      reasons: {
        ...govVersion.reasons,
        criteriaCoverage: [
          { criterion: 'A', answeredIn: 'cv.summary', why: '' },
          { criterion: 'B', answeredIn: 'cv.competencies[0]', why: '' },
          { criterion: 'C', answeredIn: 'cv.competencies[1]', why: '' },
        ],
      },
    };
    render(<ReasonsPanel job={baseDetail.job} version={v} />);
    expect(within(panel()).getAllByText('Not answered (removed by your edit)')).toHaveLength(2);
    expect(within(panel()).getByText('Key Skills & Competencies — competency 2')).toBeInTheDocument();
  });

  test('no section when the list is absent or empty', () => {
    const { rerender } = render(<ReasonsPanel job={baseDetail.job} version={baseVersion} />);
    expect(screen.queryByRole('heading', { name: 'Selection criteria' })).toBeNull();
    rerender(<ReasonsPanel job={baseDetail.job} version={{ ...baseVersion, reasons: { ...baseVersion.reasons, criteriaCoverage: [] } }} />);
    expect(screen.queryByRole('heading', { name: 'Selection criteria' })).toBeNull();
  });
});
