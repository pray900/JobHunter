import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as client from '../api/client';
import { baseDetail } from './detailFixtures';
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

const structured = {
  headline: 'Dev',
  summary: 'Summary.',
  roles: [{ title: 'Developer', employer: 'Acme', dates: '2020', bullets: ['Built LWC components.'] }],
  skills: ['Apex'],
  projects: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  m.fetchVersions.mockResolvedValue([]);
});
afterEach(cleanup);

describe('JobPage regenerate and diff', () => {
  test('G focuses the instruction box', async () => {
    m.fetchJobDetail.mockResolvedValue(baseDetail);
    renderPage();
    const box = await screen.findByLabelText(/regenerate with an instruction/i);
    await userEvent.keyboard('g');
    expect(box).toHaveFocus();
  });

  test('regenerate from the page sends the shown version', async () => {
    m.fetchJobDetail.mockResolvedValue(baseDetail);
    m.generate.mockResolvedValue({ runId: 'r1' });
    renderPage();
    await userEvent.type(await screen.findByLabelText(/regenerate with an instruction/i), 'Shorter summary');
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(m.generate).toHaveBeenCalledWith('j1', { instruction: 'Shorter summary', fromVersionId: 'v1' }));
  });

  test('box is disabled while a run is active', async () => {
    m.fetchJobDetail.mockResolvedValue({ ...baseDetail, generation: { status: 'in_progress', stage: 'writing', round: 1, attempts: 1, error: null } });
    renderPage();
    expect(await screen.findByLabelText(/regenerate with an instruction/i)).toBeDisabled();
  });

  test('Diff vs base CV tab shows the comparison', async () => {
    m.fetchJobDetail.mockResolvedValue({ ...baseDetail, baseCv: { structured, sourceRef: 'MyCV.docx', isCurrentBase: false } });
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Diff vs base CV' }));
    expect(screen.getByText('Kept')).toBeInTheDocument();
    expect(screen.getByText(/Your base CV has changed since this version/)).toBeInTheDocument();
  });

  test('Diff tab with no stored base CV', async () => {
    m.fetchJobDetail.mockResolvedValue(baseDetail);
    renderPage();
    await userEvent.click(await screen.findByRole('tab', { name: 'Diff vs base CV' }));
    expect(screen.getByText(/no longer stored/)).toBeInTheDocument();
  });
});
