import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { VersionSummary } from '../api/types';
import { VersionHistory } from './VersionHistory';

const versions: VersionSummary[] = [
  { id: 'v4', versionNo: 4, label: 'Restored version 1', origin: 'restored', createdAt: '2026-11-08T04:00:00.000Z', instruction: null, passed: false, hardChecks: 2, manualEdit: false },
  { id: 'v3', versionNo: 3, label: 'Edited', origin: 'edited', createdAt: '2026-11-08T03:00:00.000Z', instruction: null, passed: null, hardChecks: 0, manualEdit: true },
  { id: 'v2', versionNo: 2, label: 'Make it shorter', origin: 'regenerated', createdAt: '2026-11-08T02:00:00.000Z', instruction: 'Make it shorter and lead with Apex', passed: true, hardChecks: 0, manualEdit: false },
  { id: 'v1', versionNo: 1, label: 'Generated', origin: 'generated', createdAt: '2026-11-08T01:00:00.000Z', instruction: null, passed: true, hardChecks: 0, manualEdit: false },
];

describe('VersionHistory', () => {
  test('history lists versions with origin labels', () => {
    render(<VersionHistory versions={versions} selectedId="v4" onSelect={() => {}} />);
    const items = within(screen.getByRole('list', { name: 'Versions' })).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('Version 4');
    expect(items[0]).toHaveTextContent('Current');
    expect(items[0]).toHaveTextContent('Restored');
    expect(items[0]).toHaveTextContent('Not passed');
    expect(items[0]).toHaveTextContent('2 hard checks');
    expect(items[1]).toHaveTextContent('Edited by you');
    expect(items[1]).toHaveTextContent('Not reviewed');
    expect(items[2]).toHaveTextContent('Regenerated');
    // M2: the short label shows; the whole instruction is in the tooltip.
    expect(items[2]).toHaveTextContent('“Make it shorter”');
    expect(items[2]).not.toHaveTextContent('lead with Apex');
    expect(within(items[2]).getByText('“Make it shorter”')).toHaveAttribute('title', 'Make it shorter and lead with Apex');
    expect(items[2]).toHaveTextContent('Passed');
    expect(items[3]).toHaveTextContent('Generated');
    expect(items[3]).not.toHaveTextContent('Current');
    // not colour alone: not-passed is amber with an icon
    expect(within(items[0]).getAllByText('⚠').length).toBeGreaterThan(0);
  });

  test('selecting a version reports it, and the selected one is marked', async () => {
    const onSelect = vi.fn();
    render(<VersionHistory versions={versions} selectedId="v2" onSelect={onSelect} />);
    expect(screen.getByRole('button', { name: /Version 2/ })).toHaveAttribute('aria-current', 'true');
    await userEvent.click(screen.getByRole('button', { name: /Version 1/ }));
    expect(onSelect).toHaveBeenCalledWith(versions[3]);
  });

  test('M2: an old label with line breaks reads as one line', () => {
    const v = { ...versions[2]!, label: 'Shorter\n\nsummary', instruction: 'Shorter\n\nsummary' };
    render(<VersionHistory versions={[v]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText('“Shorter summary”')).toBeInTheDocument();
  });

  test('says so when there are none', () => {
    render(<VersionHistory versions={[]} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText('No versions yet.')).toBeInTheDocument();
  });
});
