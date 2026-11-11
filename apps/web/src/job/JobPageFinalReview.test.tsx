import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as client from '../api/client';
import type { DocumentVersion, JobDetail, VersionSummary } from '../api/types';
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
        <Route path="/" element={<p>All jobs page</p>} />
        <Route path="/documents" element={<p>Documents page</p>} />
      </Routes>
      <Link to="/documents">Sidebar documents</Link>
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
const gen = (over: Partial<NonNullable<JobDetail['generation']>> = {}): NonNullable<JobDetail['generation']> => ({
  status: 'in_progress',
  stage: 'writing',
  round: 1,
  attempts: 1,
  error: null,
  instruction: null,
  fromVersionId: null,
  ...over,
});
const edited = (over: Partial<DocumentVersion> = {}): DocumentVersion => ({
  ...baseVersion,
  id: 'v2',
  versionNo: 2,
  label: 'Edited',
  origin: 'edited',
  parentVersionId: 'v1',
  review: { passed: true, rounds: 1, verdicts: ['pass'], unresolved: [{ source: 'review', id: 'ai_sounding', note: 'The summary sounds generic.' }], reviewedVersionNo: 1 },
  checks: [],
  costUsd: 0,
  ...over,
});

beforeEach(() => {
  m.fetchJobDetail.mockResolvedValue(baseDetail);
  m.fetchVersions.mockResolvedValue([summary(1)]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('I1: the editor stays on the version it was opened on', () => {
  test('a run that finishes while editing keeps the typed text, says so, and Save sends the original version', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const newer: JobDetail = {
      ...baseDetail,
      versions: 2,
      generation: gen({ status: 'done', stage: 'saving' }),
      version: { ...baseVersion, id: 'v9', versionNo: 2, origin: 'generated', cv: { ...baseVersion.cv, headline: 'Claude new headline' } },
    };
    m.fetchJobDetail.mockResolvedValueOnce({ ...baseDetail, generation: gen() }).mockResolvedValue(newer);
    m.saveEdit.mockResolvedValue({ versionId: 'v10', versionNo: 3, checks: [] });
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const headline = screen.getByLabelText('Headline');
    await user.clear(headline);
    await user.type(headline, 'My own headline');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(m.fetchJobDetail).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Headline')).toHaveValue('My own headline');
    expect(screen.getByRole('status', { name: 'A new version finished' })).toHaveTextContent(
      'A new version finished while you were editing. Saving adds your edit as the newest version; the other one stays in the history.',
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const [, fromId, cv] = m.saveEdit.mock.calls[0]!;
    expect(fromId).toBe('v1');
    expect(cv.headline).toBe('My own headline');
  });
});

describe('I2: Try again repeats a failed regenerate', () => {
  test('a failed regenerate is tried again with the same instruction and version', async () => {
    m.fetchJobDetail.mockResolvedValue({
      ...baseDetail,
      generation: gen({ status: 'failed', attempts: 3, error: 'Generation stopped and gave up after 3 attempts.', instruction: 'Shorter summary', fromVersionId: 'v1' }),
    });
    m.generate.mockResolvedValue({ runId: 'r2' });
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Shorter summary');
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(m.generate).toHaveBeenCalledWith('j1', { instruction: 'Shorter summary', fromVersionId: 'v1' });
  });

  test('a failed plain Generate is tried again as a plain Generate', async () => {
    m.fetchJobDetail.mockResolvedValue({ ...baseDetail, generation: gen({ status: 'failed', attempts: 3, error: 'Generation stopped and gave up after 3 attempts.' }) });
    m.generate.mockResolvedValue({ runId: 'r2' });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(m.generate).toHaveBeenCalledWith('j1');
  });
});

describe('I3: an edited version does not look reviewed', () => {
  test('the reviewer section says the edits were not reviewed; no ✓, no stale "Needs your attention"', async () => {
    m.fetchJobDetail.mockResolvedValue({ ...baseDetail, versions: 2, version: edited() });
    renderPage();
    const reviewer = await screen.findByRole('region', { name: 'Reviewer' });
    expect(reviewer).toHaveTextContent('Not reviewed: your edits came after the review (version 1 was: passed)');
    expect(reviewer).not.toHaveTextContent('✓');
    expect(screen.queryByText('Reviewer: passed')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Needs your attention' })).not.toBeInTheDocument();
    const old = screen.getByRole('region', { name: 'From the review of version 1' });
    expect(old).not.toHaveClass('attention');
    expect(old).toHaveTextContent('The summary sounds generic.');
  });

  test('review-severity checks on an edit are listed as "Needs a look"', async () => {
    m.fetchJobDetail.mockResolvedValue({
      ...baseDetail,
      versions: 2,
      version: edited({
        review: { passed: false, rounds: 2, verdicts: ['fail', 'fail'], unresolved: [], reviewedVersionNo: 1 },
        checks: [{ code: 'unmatched_skill', severity: 'review', doc: 'cv', where: 'cv.skills[0].items[2]', detail: 'The technology "Kubernetes" is not in the base CV.' }],
      }),
    });
    renderPage();
    expect(await screen.findByRole('region', { name: 'Reviewer' })).toHaveTextContent('(version 1 was: not satisfied)');
    const look = screen.getByRole('region', { name: 'Needs a look' });
    expect(look).toHaveClass('attention');
    expect(look).toHaveTextContent('The reviewer did not see your edit. Check these yourself.');
    expect(look).toHaveTextContent('Technology not in your base CV');
    expect(look).toHaveTextContent('Kubernetes');
  });

  test('the save notice lists review checks and only says "No rules broken" when there are none', async () => {
    m.saveEdit.mockResolvedValue({
      versionId: 'v2',
      versionNo: 2,
      checks: [{ code: 'unmatched_skill', severity: 'review', doc: 'cv', detail: 'The technology "Kubernetes" is not in the base CV.' }],
    });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.type(screen.getByLabelText('Headline'), ' II');
    m.fetchJobDetail.mockResolvedValue({ ...baseDetail, versions: 2, version: edited() });
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const notice = await screen.findByRole('alert', { name: 'Edit saved' });
    expect(notice).toHaveClass('attention');
    expect(notice).toHaveTextContent('Needs a look');
    expect(notice).toHaveTextContent('Kubernetes');
    expect(notice).not.toHaveTextContent('No rules broken');
  });

  test('locked edits kept on a regenerate are labelled as his own', async () => {
    m.fetchJobDetail.mockResolvedValue({
      ...baseDetail,
      version: {
        ...baseVersion,
        origin: 'regenerated',
        review: {
          passed: false,
          rounds: 1,
          verdicts: ['pass'],
          unresolved: [{ source: 'check', code: 'unknown_fact', severity: 'hard', doc: 'cv', where: 'cv.summary', detail: 'The number "4711" is not in the base CV.', locked: true, note: 'Your edit — kept as you asked' }],
        },
        checks: [{ code: 'unknown_fact', severity: 'hard', doc: 'cv', where: 'cv.summary', detail: 'The number "4711" is not in the base CV.', locked: true }],
      },
    });
    renderPage();
    const attention = await screen.findByRole('region', { name: 'Needs your attention' });
    expect(attention).toHaveTextContent('Your edit — kept as you asked');
    expect(attention).toHaveTextContent('Not in your base CV');
    expect(screen.getByRole('region', { name: 'Failed checks' })).toHaveTextContent('Your edit — kept as you asked');
  });
});

describe('M6: edits and restores cost nothing', () => {
  test('an edited version says so instead of US$0.00', async () => {
    m.fetchJobDetail.mockResolvedValue({ ...baseDetail, versions: 2, version: edited() });
    renderPage();
    expect(await screen.findByText('No cost (your edit)')).toBeInTheDocument();
    expect(screen.queryByText(/This generation cost/)).not.toBeInTheDocument();
  });

  test('a restored version says it is a copy', async () => {
    m.fetchJobDetail.mockResolvedValue({ ...baseDetail, versions: 2, version: { ...baseVersion, id: 'v2', versionNo: 2, origin: 'restored', costUsd: 0 } });
    renderPage();
    expect(await screen.findByText('Restored copy (no new cost)')).toBeInTheDocument();
  });
});

describe('I6: leaving with unsaved edits asks first', () => {
  test('an in-app link asks, Keep editing stays, Leave goes', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.type(screen.getByLabelText('Headline'), ' II');
    await userEvent.click(screen.getByRole('link', { name: '← All jobs' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('You have unsaved edits — leave anyway?');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Headline')).toHaveValue('Salesforce Developer II');
    await userEvent.click(screen.getByRole('link', { name: 'Sidebar documents' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Leave' }));
    expect(await screen.findByText('Documents page')).toBeInTheDocument();
  });

  test('without changes a link just goes', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.click(screen.getByRole('link', { name: '← All jobs' }));
    expect(await screen.findByText('All jobs page')).toBeInTheDocument();
  });

  test('reload or closing the tab asks while there are unsaved edits', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    await userEvent.type(screen.getByLabelText('Headline'), ' II');
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard changes' }));
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});

describe('M10 and M14', () => {
  test('a regenerate started from an older version shows the result as the current version', async () => {
    m.fetchVersions.mockResolvedValue([summary(2), summary(1)]);
    m.fetchJobDetail.mockResolvedValue({ ...baseDetail, versions: 2, version: { ...baseVersion, id: 'v2', versionNo: 2 } });
    m.generate.mockResolvedValue({ runId: 'r1' });
    renderPage();
    m.fetchJobDetail.mockResolvedValue({ ...baseDetail, versions: 2, version: { ...baseVersion, isCurrent: false } });
    await userEvent.click(await screen.findByRole('button', { name: /Version 1/ }));
    await screen.findByRole('status', { name: 'Viewing an older version' });
    m.fetchJobDetail.mockResolvedValue({ ...baseDetail, versions: 2, version: { ...baseVersion, id: 'v2', versionNo: 2 }, generation: gen({ status: 'pending', stage: 'queued' }) });
    await userEvent.type(screen.getByLabelText(/regenerate with an instruction/i), 'Shorter');
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    expect(m.generate).toHaveBeenCalledWith('j1', { instruction: 'Shorter', fromVersionId: 'v1' });
    await waitFor(() => expect(m.fetchJobDetail).toHaveBeenLastCalledWith('j1', undefined));
  });

  test('Generate again says it starts from the base CV', async () => {
    renderPage();
    const btn = await screen.findByRole('button', { name: 'Generate again' });
    expect(btn).toHaveAttribute('title', 'Writes new documents from your base CV. Your edits are not carried over (they stay in the history).');
    expect(screen.getByText(/Writes new documents from your base CV/, { selector: 'p' })).toBeInTheDocument();
  });
});

describe('manual edit markers follow the text', () => {
  test('the preview marks his edits where their text is, and nothing where the text has gone', async () => {
    m.fetchJobDetail.mockResolvedValue({
      ...baseDetail,
      version: {
        ...baseVersion,
        manualEdits: [
          { path: 'cv.summary', text: baseVersion.cv.summary },
          { path: 'cv.experience[0].bullets[3]', text: 'Built LWC components.' },
          { path: 'cv.headline', text: 'A headline that is no longer there' },
        ],
      },
    });
    renderPage();
    const panel = await screen.findByRole('tabpanel');
    const marks = within(panel).getAllByText('Your edit');
    expect(marks).toHaveLength(2);
    expect(marks[0]!.closest('p')).toHaveTextContent(baseVersion.cv.summary);
    expect(marks[1]!.closest('li')).toHaveTextContent('Built LWC components.');
  });
});

describe('R3: Back and Forward with unsaved edits ask first', () => {
  beforeEach(() => window.history.replaceState(null, '', window.location.href));
  test('browser Back asks; Keep editing stays; Leave goes back past the guard entry', async () => {
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(window.history.state?.jhGuard).toBeUndefined();
    await userEvent.type(screen.getByLabelText('Headline'), ' II');
    // A guard entry sits on top of the page, so Back lands on it instead of leaving.
    expect(window.history.state?.jhGuard).toBe(true);
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('You have unsaved edits — leave anyway?');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Headline')).toHaveValue('Salesforce Developer II');
    expect(window.history.state?.jhGuard).toBe(true);
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Leave' }));
    expect(go).toHaveBeenCalledWith(-2);
    go.mockRestore();
  });

  test('once the edits are saved or discarded, Back is not blocked', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await userEvent.type(screen.getByLabelText('Headline'), ' II');
    expect(window.history.state?.jhGuard).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard changes' }));
    // The guard entry is taken off again.
    await waitFor(() => expect(back).toHaveBeenCalledTimes(1));
    back.mockRestore();
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
