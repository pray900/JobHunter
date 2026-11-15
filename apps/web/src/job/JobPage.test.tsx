import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
    setTemplate: vi.fn(),
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

const running = (stage: 'queued' | 'writing' | 'reviewing', round: number, status: 'pending' | 'in_progress' = 'in_progress'): JobDetail => ({
  ...baseDetail,
  generation: { status, stage, round, attempts: 1, error: null },
});

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

beforeEach(() => {
  m.fetchJobDetail.mockResolvedValue(baseDetail);
  m.fetchVersions.mockResolvedValue([summary(1)]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('JobPage', () => {
  test('shows the cv preview and reasons', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: /Salesforce Developer/ })).toBeInTheDocument();
    expect(screen.getByText('Based on: MyCV.docx')).toBeInTheDocument();
    expect(screen.getByText(/Template: Standard ATS/)).toHaveTextContent('Plain layout reads best');
    const cv = screen.getByRole('tabpanel');
    expect(within(cv).getByText('Sam Citizen')).toBeInTheDocument();
    expect(within(cv).getByText('Built LWC components.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Cover letter' }));
    expect(screen.getByText('Dear Hiring Manager,')).toBeInTheDocument();
    // reasons
    expect(screen.getByText('Strong Apex fit.')).toBeInTheDocument();
    expect(screen.getByText('CPQ')).toBeInTheDocument();
    expect(screen.getByText('Not in your base CV.')).toBeInTheDocument();
    expect(screen.getByText('The ad asks for Apex first.')).toBeInTheDocument();
    expect(screen.getByText('Stretch — you decide')).toBeInTheDocument();
    expect(screen.getByText(/This generation cost US\$0\.42/)).toBeInTheDocument();
    expect(screen.getByText(/2 rounds/)).toBeInTheDocument();
    // job ad with covered keywords highlighted (US/AU variants)
    const marks = document.querySelectorAll('mark');
    expect([...marks].map((x) => x.textContent)).toEqual(['Apex', 'LWC']);
  });

  test('links to the posting only through safeHref', async () => {
    m.fetchJobDetail.mockResolvedValue({ ...baseDetail, job: { ...baseDetail.job, url: 'javascript:alert(1)' } });
    renderPage();
    await screen.findByRole('heading', { name: /Salesforce Developer/ });
    expect(screen.queryByRole('link', { name: /open job posting/i })).not.toBeInTheDocument();
  });

  test('open job posting link is safe', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: /open job posting/i });
    expect(link).toHaveAttribute('href', 'https://au.seek.com/job/1');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('a government version names its two-page limit on an unresolved page check', async () => {
    m.fetchJobDetail.mockResolvedValue({ ...baseDetail, version: { ...baseVersion, templateId: 'au-government' } });
    renderPage();
    const region = await screen.findByRole('region', { name: 'Needs your attention' });
    expect(within(region).getByText('CV is longer than 2 pages')).toBeInTheDocument();
    expect(within(region).queryByText('CV is longer than 1 page')).not.toBeInTheDocument();
  });

  test('unresolved items are amber with a label', async () => {
    renderPage();
    const region = await screen.findByRole('region', { name: 'Needs your attention' });
    expect(region).toHaveClass('attention');
    expect(within(region).getByText('The summary sounds generic.')).toBeInTheDocument();
    expect(within(region).getByText('CV is longer than 1 page')).toBeInTheDocument();
    expect(within(region).getAllByText('⚠').length).toBeGreaterThan(0);
    expect(screen.getByText('Hard checks that failed')).toBeInTheDocument();
    expect(screen.getByText('Warnings')).toBeInTheDocument();
    expect(screen.getByText('Reviewer: not satisfied')).toBeInTheDocument();
  });

  test('a passing review says so', async () => {
    m.fetchJobDetail.mockResolvedValue({
      ...baseDetail,
      version: { ...baseVersion, review: { passed: true, rounds: 1, verdicts: ['pass'], unresolved: [] }, checks: [] },
    });
    renderPage();
    expect(await screen.findByText('Reviewer: passed')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Needs your attention' })).not.toBeInTheDocument();
  });

  test('generate button queues and shows progress', async () => {
    m.fetchJobDetail.mockResolvedValueOnce({ ...baseDetail, version: null, generation: null, job: { ...baseDetail.job, status: 'new' } });
    m.generate.mockResolvedValue({ runId: 'r1' });
    m.fetchJobDetail.mockResolvedValue(running('reviewing', 2));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Generate' }));
    expect(m.generate).toHaveBeenCalledWith('j1');
    expect(await screen.findByText('Reviewing… round 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate' })).not.toBeInTheDocument();
  });

  test('a done version offers Generate again', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: 'Generate again' })).toBeInTheDocument();
  });

  test('409 shows already running', async () => {
    m.generate.mockRejectedValue(new client.ApiError(409, 'x', 'generation_in_progress'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Generate again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Already running');
  });

  test('422 shows the reason', async () => {
    m.generate.mockRejectedValue(new client.ApiError(422, 'x', 'base_cv_not_ready'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Generate again' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("base CV isn't ready");
    m.generate.mockRejectedValue(new client.ApiError(422, 'x', 'job_not_ready'));
    await userEvent.click(screen.getByRole('button', { name: 'Generate again' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("hasn't been read yet"));
  });

  test('failed run shows its error in amber with Try again', async () => {
    m.fetchJobDetail.mockResolvedValue({
      ...baseDetail,
      version: null,
      generation: { status: 'failed', stage: 'writing', round: 1, attempts: 3, error: 'Generation stopped and gave up after 3 attempts.' },
    });
    m.generate.mockResolvedValue({ runId: 'r2' });
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('attention');
    expect(alert).toHaveTextContent('Generation stopped and gave up after 3 attempts.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(m.generate).toHaveBeenCalledWith('j1');
  });

  test('downloads are links with doc and format', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Salesforce Developer/ });
    const hrefs = (name: string) => screen.getByRole('link', { name }).getAttribute('href');
    expect(hrefs('Download CV DOCX')).toBe('/api/jobs/download?id=j1&doc=cv&format=docx');
    expect(hrefs('Download CV PDF')).toBe('/api/jobs/download?id=j1&doc=cv&format=pdf');
    expect(hrefs('Download cover letter DOCX')).toBe('/api/jobs/download?id=j1&doc=cover_letter&format=docx');
    expect(hrefs('Download cover letter PDF')).toBe('/api/jobs/download?id=j1&doc=cover_letter&format=pdf');
  });

  test('status dropdown saves', async () => {
    m.setStatus.mockResolvedValue({ status: 'applied' });
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText('Status'), 'applied');
    expect(m.setStatus).toHaveBeenCalledWith('j1', 'applied');
    expect(screen.getByLabelText('Status')).toHaveValue('applied');
  });

  test('status failure goes back and says so', async () => {
    m.setStatus.mockRejectedValue(new client.ApiError(500, 'x'));
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText('Status'), 'closed');
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save the status");
    expect(screen.getByLabelText('Status')).toHaveValue('cv_ready');
  });

  test('notes save on blur', async () => {
    m.saveCompanyNotes.mockResolvedValue({ notes: 'Great culture' });
    renderPage();
    const box = await screen.findByLabelText('My notes about this company');
    await userEvent.type(box, 'Great culture');
    expect(m.saveCompanyNotes).not.toHaveBeenCalled();
    await userEvent.tab();
    expect(m.saveCompanyNotes).toHaveBeenCalledWith('j1', 'Great culture');
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  test('polls every 5 seconds only while running, then stops', async () => {
    vi.useFakeTimers();
    m.fetchJobDetail.mockResolvedValueOnce(running('writing', 1)).mockResolvedValueOnce(running('writing', 1)).mockResolvedValue(baseDetail);
    renderPage();
    await act(async () => {});
    expect(m.fetchJobDetail).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Writing… round 1')).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(m.fetchJobDetail).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(m.fetchJobDetail).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('button', { name: 'Generate again' })).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(m.fetchJobDetail).toHaveBeenCalledTimes(3);
  });

  test('stops polling on unmount', async () => {
    vi.useFakeTimers();
    m.fetchJobDetail.mockResolvedValue(running('writing', 1));
    const { unmount } = renderPage();
    await act(async () => {});
    unmount();
    await vi.advanceTimersByTimeAsync(30000);
    expect(m.fetchJobDetail).toHaveBeenCalledTimes(1);
  });

  test('load failure shows an error with retry', async () => {
    m.fetchJobDetail.mockRejectedValueOnce(new client.ApiError(404, 'nope', 'job_not_found'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load this job");
  });

  test('I3: reworded skills the reviewer ruled on are listed with why; invented ones in amber', async () => {
    m.fetchJobDetail.mockResolvedValue({
      ...baseDetail,
      version: {
        ...baseVersion,
        reasons: {
          ...baseVersion.reasons,
          factRulings: [
            { text: 'modern JavaScript component frameworks', ruling: 'honest_rephrase', why: 'Lightning Web Components are in your base CV.' },
            { text: 'Kubernetes', ruling: 'invented', why: 'Nothing in your base CV supports it.' },
          ],
        },
      },
    });
    renderPage();
    const region = await screen.findByRole('region', { name: 'Reworded skills the reviewer accepted' });
    const items = within(region).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('modern JavaScript component frameworks');
    expect(items[0]).toHaveTextContent('Honest rephrase');
    expect(items[0]).toHaveTextContent('Lightning Web Components are in your base CV.');
    expect(items[0]).not.toHaveClass('attention-text');
    expect(items[1]).toHaveTextContent('Kubernetes');
    expect(items[1]).toHaveTextContent('Invented');
    expect(items[1]).toHaveTextContent('Nothing in your base CV supports it.');
    expect(items[1]).toHaveClass('attention-text');
    expect(within(items[1]).getByText('⚠')).toBeInTheDocument();
  });

  test('I3: no rulings, no rulings panel', async () => {
    renderPage();
    await screen.findByRole('heading', { name: /Salesforce Developer/ });
    expect(screen.queryByRole('region', { name: 'Reworded skills the reviewer accepted' })).not.toBeInTheDocument();
  });

  test('M11: "Reviewer: not satisfied" is amber with an icon', async () => {
    renderPage();
    const line = await screen.findByText('Reviewer: not satisfied');
    const p = line.closest('p')!;
    expect(p).toHaveClass('attention-text');
    expect(within(p).getByText('⚠')).toBeInTheDocument();
  });

  test('M6: a failed attempt waiting to retry shows the reason', async () => {
    m.fetchJobDetail.mockResolvedValue({
      ...baseDetail,
      generation: { status: 'pending', stage: 'queued', round: 2, attempts: 1, error: 'The request to Claude failed (HTTP 529).' },
    });
    renderPage();
    expect(await screen.findByRole('status')).toHaveTextContent('Retrying: The request to Claude failed (HTTP 529).');
  });

  test('M6: a first attempt waiting to start says so', async () => {
    m.fetchJobDetail.mockResolvedValue({ ...baseDetail, generation: { status: 'pending', stage: 'queued', round: 0, attempts: 0, error: null } });
    renderPage();
    expect(await screen.findByRole('status')).toHaveTextContent('Waiting to start…');
  });

  test('M11: the document tabs move with the arrow keys', async () => {
    renderPage();
    const cvTab = await screen.findByRole('tab', { name: 'CV' });
    expect(cvTab).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Cover letter' })).toHaveAttribute('tabindex', '-1');
    cvTab.focus();
    await userEvent.keyboard('{ArrowRight}');
    const letterTab = screen.getByRole('tab', { name: 'Cover letter' });
    expect(letterTab).toHaveAttribute('aria-selected', 'true');
    expect(letterTab).toHaveFocus();
    expect(screen.getByText('Dear Hiring Manager,')).toBeInTheDocument();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'CV' })).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Diff vs base CV' })).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'CV' })).toHaveAttribute('aria-selected', 'true');
  });

  test('I2/M11: preview has no stray comma for a missing institution and no empty Summary heading', async () => {
    m.fetchJobDetail.mockResolvedValue({
      ...baseDetail,
      version: {
        ...baseVersion,
        cv: {
          ...baseVersion.cv,
          summary: '',
          education: [{ qualification: 'Salesforce Certified Platform Developer I', institution: '', dates: '2023', statusText: '' }],
        },
      },
    });
    renderPage();
    const panel = await screen.findByRole('tabpanel');
    expect(within(panel).getByText('Salesforce Certified Platform Developer I')).toBeInTheDocument();
    expect(within(panel).queryByRole('heading', { name: 'Summary' })).not.toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Skills' })).toBeInTheDocument();
  });
});

describe('JobPage: projects left out to fit one page', () => {
  test('lists each project left out, with an info label', async () => {
    m.fetchJobDetail.mockResolvedValue({
      ...baseDetail,
      version: { ...baseVersion, reasons: { ...baseVersion.reasons, fit: { droppedProjects: ['Handwritten Math Symbol Classification'] } } },
    });
    m.fetchVersions.mockResolvedValue([summary(1)]);
    renderPage();
    const region = await screen.findByRole('region', { name: 'Fit to one page' });
    const items = within(region).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Left out to fit one page: Handwritten Math Symbol Classification');
    expect(within(items[0]).getByText('ⓘ')).toBeInTheDocument();
    expect(items[0]).toHaveClass('muted');
  });

  test('a government version says two pages', async () => {
    m.fetchJobDetail.mockResolvedValue({
      ...baseDetail,
      version: { ...baseVersion, templateId: 'au-government', reasons: { ...baseVersion.reasons, fit: { droppedProjects: ['Old Project'] } } },
    });
    m.fetchVersions.mockResolvedValue([summary(1)]);
    renderPage();
    const region = await screen.findByRole('region', { name: 'Fit to two pages' });
    expect(within(region).getByText(/Left out to fit two pages: Old Project/)).toBeInTheDocument();
    expect(screen.queryByText(/one page/)).not.toBeInTheDocument();
  });

  test('a version without fit shows no such line', async () => {
    renderPage();
    await screen.findByText('Strong Apex fit.');
    expect(screen.queryByText(/Left out to fit one page/)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Fit to one page' })).not.toBeInTheDocument();
  });
});

describe('JobPage template choice', () => {
  const withJob = (over: Partial<JobDetail['job']>): JobDetail => ({ ...baseDetail, job: { ...baseDetail.job, ...over } });
  const NOTE = "Applies to the next Generate. Regenerate keeps the current version's template.";

  test('a Template select with both names and the note; Standard ATS with no suggestion', async () => {
    renderPage();
    const select = await screen.findByLabelText('Template');
    expect(within(select).getByRole('option', { name: 'Standard ATS' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Australian Government' })).toBeInTheDocument();
    expect(select).toHaveValue('standard-ats');
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    expect(screen.queryByText(/^Suggested:/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use suggestion' })).toBeNull();
  });

  test('a suggestion with no choice is shown and selected', async () => {
    m.fetchJobDetail.mockResolvedValue(withJob({ suggestedTemplate: 'au-government', templateReason: 'APS ad with selection criteria.' }));
    renderPage();
    expect(await screen.findByText('Suggested: Australian Government — APS ad with selection criteria.')).toBeInTheDocument();
    expect(screen.getByLabelText('Template')).toHaveValue('au-government');
    expect(screen.queryByRole('button', { name: 'Use suggestion' })).toBeNull();
  });

  test('changing the select saves the choice', async () => {
    m.setTemplate.mockResolvedValue({ templateChoice: 'au-government' });
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText('Template'), 'au-government');
    expect(m.setTemplate).toHaveBeenCalledWith('j1', 'au-government');
    await waitFor(() => expect(screen.getByLabelText('Template')).toHaveValue('au-government'));
  });

  test('Use suggestion appears only when the choice differs and clears it', async () => {
    m.fetchJobDetail.mockResolvedValue(withJob({ suggestedTemplate: 'au-government', templateReason: 'r', templateChoice: 'standard-ats' }));
    m.setTemplate.mockResolvedValue({ templateChoice: null });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Use suggestion' }));
    expect(m.setTemplate).toHaveBeenCalledWith('j1', null);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use suggestion' })).toBeNull());
    expect(screen.getByLabelText('Template')).toHaveValue('au-government');
  });

  test('a failed save shows a warning and keeps the old choice', async () => {
    m.setTemplate.mockRejectedValue(new Error('x'));
    renderPage();
    await userEvent.selectOptions(await screen.findByLabelText('Template'), 'au-government');
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't save the template");
    expect(screen.getByLabelText('Template')).toHaveValue('standard-ats');
  });
});
