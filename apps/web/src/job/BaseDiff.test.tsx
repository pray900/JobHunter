import { render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { baseVersion } from './detailFixtures';
import { BaseDiff } from './BaseDiff';

const structured = {
  headline: 'Dev',
  summary: 'Summary.',
  roles: [{ title: 'Developer', employer: 'Acme', dates: '2020', bullets: ['Built LWC widgets quickly', 'Ran standups'] }],
  skills: ['Apex'],
  projects: [],
};
const cv = {
  ...baseVersion.cv,
  experience: [{ ...baseVersion.cv.experience[0]!, bullets: ['Built LWC widgets for sales quickly', 'Built LWC components.'] }],
};

describe('BaseDiff', () => {
  test('labels, not colour alone', () => {
    render(<BaseDiff baseCv={{ structured, sourceRef: 'MyCV.docx', isCurrentBase: true }} cv={cv} reasons={baseVersion.reasons} />);
    const roleSection = screen.getByRole('region', { name: /Developer at Acme/ });
    expect(within(roleSection).getByText('Reworded')).toBeInTheDocument();
    expect(within(roleSection).getByText('Added')).toBeInTheDocument();
    expect(within(roleSection).getByText('Stretch')).toBeInTheDocument();
    expect(within(roleSection).getByText('Built LWC widgets quickly').tagName).toBe('DEL');
    const left = within(roleSection).getByRole('region', { name: 'Left out' });
    expect(within(left).getByText('Ran standups')).toBeInTheDocument();
  });

  test('diff notice when base changed', () => {
    render(<BaseDiff baseCv={{ structured, sourceRef: null, isCurrentBase: false }} cv={cv} reasons={baseVersion.reasons} />);
    expect(screen.getByText(/Your base CV has changed since this version/)).toBeInTheDocument();
  });

  test('no stored base CV', () => {
    render(<BaseDiff baseCv={null} cv={cv} reasons={baseVersion.reasons} />);
    expect(screen.getByText(/made from an earlier base CV that's no longer stored/)).toBeInTheDocument();
    expect(screen.queryByText('Reworded')).toBeNull();
    expect(screen.getByText('Base CV no longer available.')).toBeInTheDocument();
  });
});
