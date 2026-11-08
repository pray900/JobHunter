import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as client from '../api/client';
import type { JobDetail, VersionSummary } from '../api/types';
import { baseDetail, baseVersion } from './detailFixtures';
import { JobPage } from './JobPage';

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    fetchJobDetail: vi.fn(),
    generate: vi.fn(),
    setStatus: vi.fn(),
    saveCompanyNotes: vi.fn(),
    fetchVersions: vi.fn(),
    saveEdit: vi.fn(),
    restoreVersion: vi.fn(),
    downloadUrl: actual.downloadUrl,
  };
});

const m = vi.mocked(client);

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/jobs/j1']}>
      <Routes>
        <Route path="/jobs/:id" element={<JobPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const summary = (n: number, over: Partial<VersionSummary> = {}): VersionSummary => ({
  id: `v${n}`,
  versionNo: n,
  label: 'Generated',
  origin: 'generated',
  createdAt: '2026-11-07T01:00:00.000Z',
  instruction: null,
  passed: true,
  hardChecks: 0,
  manualEdit: false,
  ...over,
});

const editedVersion = {
  ...baseVersion,
  id: 'v2',
  versionNo: 2,
  label: 'Edited',
  origin: 'edited' as const,
  parentVersionId: 'v1',
  manualEdits: ['cv.experience[0].bullets[0]'],
  review: { ...baseVersion.review, reviewedVersionNo: 1 },
  cv: { ...baseVersion.cv, experience: [{ ...baseVersion.cv.experience[0]!, bullets: ['Built LWC components used by 40 reps.'] }] },
};
const editedDetail: JobDetail = { ...baseDetail, version: editedVersion, versions: 2 };
const oldDetail: JobDetail = { ...baseDetail, versions: 2, version: { ...baseVersion, isCurrent: false } };
const twoVersions = [summary(2, { origin: 'edited', label: 'Edited', passed: null, manualEdit: true }), summary(1)];

beforeEach(() => {
  m.fetchJobDetail.mockResolvedValue(baseDetail);
  m.fetchVersions.mockResolvedValue([summary(1)]);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('JobPage editing, history and shortcuts', () => {
  test('Edit opens the editor, Save creates a version and shows broken rules in amber with labels', async () => {
    m.saveEdit.mockResolvedValue({
      versionId: 'v2',
      versionNo: 2,
      checks: [
        { code: 'unknown_fact', severity: 'hard', doc: 'cv', detail: '40 is not in your base CV.' },
        { code: 'link_unreachable', severity: 'warning', doc: 'cv', detail: 'x' },
      ],
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const bullet = screen.getByLabelText('Developer bullet 1');
    await userEvent.clear(bullet);
    await userEvent.type(bullet, 'Built LWC components used by 40 reps.');
    m.fetchJobDetail.mockResolvedValue(editedDetail);
    m.fetchVersions.mockResolvedValue(twoVersions);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(m.saveEdit).toHaveBeenCalledTimes(1);
    const [jobId, fromId, cv] = m.saveEdit.mock.calls[0]!;
    expect([jobId, fromId]).toEqual(['j1', 'v1']);
    expect(cv.experience[0]!.bullets).toEqual(['Built LWC components used by 40 reps.']);
    const notice = await screen.findByRole('alert', { name: 'Edit saved' });
    expect(notice).toHaveClass('attention');
    expect(notice).toHaveTextContent('Your edit broke 1 rule');
    expect(notice).toHaveTextContent('Not in your base CV');
    expect(notice).toHaveTextContent('40 is not in your base CV.');
    expect(notice).not.toHaveTextContent("Link didn't answer");
    expect(within(notice).getByText('⚠')).toBeInTheDocument();
    expect(screen.queryByLabelText('Developer bullet 1')).not.toBeInTheDocument();
    expect(within(screen.getByRole('tabpanel')).getByText('Built LWC components used by 40 reps.')).toBeInTheDocument();
    expect(screen.getByText('Reviewer verdict is from version 1, before your edits.')).toBeInTheDocument();
  });

  test('a clean save says so without the amber warning', async () => {
    m.saveEdit.mockResolvedValue({ versionId: 'v2', versionNo: 2, checks: [] });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.type(screen.getByLabelText('Headline'), ' II');
    m.fetchJobDetail.mockResolvedValue(editedDetail);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('status', { name: 'Edit saved' })).toHaveTextContent('Saved as version 2');
    expect(screen.queryByText(/Your edit broke/)).not.toBeInTheDocument();
  });

  test('save failures are explained and keep the editor open', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.type(screen.getByLabelText('Headline'), ' II');
    m.saveEdit.mockRejectedValueOnce(new client.ApiError(422, 'x', 'base_cv_not_ready'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("base CV isn't ready");
    m.saveEdit.mockRejectedValueOnce(new client.ApiError(400, 'x', 'invalid_document', 'cv.headline'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('cv.headline'));
    m.saveEdit.mockRejectedValueOnce(new client.ApiError(413, 'x', 'too_large'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('too long'));
    expect(screen.getByLabelText('Headline')).toHaveValue('Salesforce Developer II');
  });

  test('an edited version says the reviewer verdict predates the edits', async () => {
    m.fetchJobDetail.mockResolvedValue(editedDetail);
    renderPage();
    expect(await screen.findByText('Reviewer verdict is from version 1, before your edits.')).toBeInTheDocument();
  });

  test('E opens the editor, A marks applied, S closes, not while typing', async () => {
    m.setStatus.mockResolvedValue({ status: 'applied' });
    renderPage();
    const notes = await screen.findByLabelText('My notes about this company');
    await userEvent.type(notes, 'ase');
    expect(notes).toHaveValue('ase');
    expect(m.setStatus).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Headline')).not.toBeInTheDocument();
    notes.blur();
    await userEvent.keyboard('a');
    expect(m.setStatus).toHaveBeenLastCalledWith('j1', 'applied');
    await userEvent.keyboard('s');
    expect(m.setStatus).toHaveBeenLastCalledWith('j1', 'closed');
    await userEvent.keyboard('e');
    const headline = await screen.findByLabelText('Headline');
    // shortcuts are off while the editor is open
    headline.blur();
    m.setStatus.mockClear();
    await userEvent.keyboard('a');
    expect(m.setStatus).not.toHaveBeenCalled();
  });

  test('the ? button lists the shortcuts', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Keyboard shortcuts' }));
    const list = screen.getByRole('list', { name: 'Shortcuts' });
    expect(list).toHaveTextContent('Edit the documents');
    expect(list).toHaveTextContent('Mark applied');
    expect(list).toHaveTextContent('Skip');
  });

  test('viewing an old version is read-only and shows its own downloads', async () => {
    m.fetchVersions.mockResolvedValue(twoVersions);
    m.fetchJobDetail.mockResolvedValue(editedDetail);
    renderPage();
    await screen.findByRole('heading', { name: /Salesforce Developer/ });
    m.fetchJobDetail.mockResolvedValue(oldDetail);
    await userEvent.click(await screen.findByRole('button', { name: /Version 1/ }));
    expect(m.fetchJobDetail).toHaveBeenLastCalledWith('j1', 'v1');
    const banner = await screen.findByRole('status', { name: 'Viewing an older version' });
    expect(banner).toHaveTextContent("You're viewing version 1 (not the current one)");
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download CV DOCX' })).toHaveAttribute('href', '/api/jobs/download?id=j1&doc=cv&format=docx&versionId=v1');
    expect(screen.getByRole('link', { name: 'Download cover letter PDF' })).toHaveAttribute(
      'href',
      '/api/jobs/download?id=j1&doc=cover_letter&format=pdf&versionId=v1',
    );
  });

  test('restore asks then creates a version', async () => {
    m.fetchVersions.mockResolvedValue(twoVersions);
    m.fetchJobDetail.mockResolvedValue(editedDetail);
    renderPage();
    await screen.findByRole('heading', { name: /Salesforce Developer/ });
    m.fetchJobDetail.mockResolvedValue(oldDetail);
    await userEvent.click(await screen.findByRole('button', { name: /Version 1/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Restore this version' }));
    const dialog = screen.getByRole('dialog');
    expect(m.restoreVersion).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(m.restoreVersion).not.toHaveBeenCalled();

    m.restoreVersion.mockResolvedValue({ versionId: 'v3', versionNo: 3 });
    m.fetchJobDetail.mockResolvedValue({
      ...baseDetail,
      versions: 3,
      version: { ...baseVersion, id: 'v3', versionNo: 3, label: 'Restored version 1', origin: 'restored' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Restore this version' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore' }));
    expect(m.restoreVersion).toHaveBeenCalledWith('j1', 'v1');
    expect(await screen.findByText('Restored version 1 as version 3.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('status', { name: 'Viewing an older version' })).not.toBeInTheDocument());
    expect(m.fetchJobDetail).toHaveBeenLastCalledWith('j1', undefined);
  });

  test('a failed restore says so', async () => {
    m.fetchVersions.mockResolvedValue(twoVersions);
    m.fetchJobDetail.mockResolvedValue(oldDetail);
    m.restoreVersion.mockRejectedValue(new client.ApiError(500, 'x'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Restore this version' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Restore' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't restore that version");
  });
});
