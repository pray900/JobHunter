import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError, fetchDocuments, uploadDocument } from '../api/client';
import type { BaseDocumentSummary, DocumentsResponse } from '../api/types';
import { App } from '../App';
import { DocumentsPage } from './DocumentsPage';

vi.mock('../api/client', async (orig) => ({
  ...(await orig<typeof import('../api/client')>()),
  fetchDocuments: vi.fn(),
  uploadDocument: vi.fn(),
  fetchJobs: vi.fn().mockResolvedValue([]),
}));
const mockFetch = vi.mocked(fetchDocuments);
const mockUpload = vi.mocked(uploadDocument);

function doc(over: Partial<BaseDocumentSummary>): BaseDocumentSummary {
  return {
    id: 'd1',
    kind: 'cv',
    sourceRef: 'my-cv.pdf',
    analysisStatus: 'done',
    analysisError: null,
    warnings: [],
    edited: false,
    editedAt: null,
    updatedAt: '2026-11-07T00:00:00.000Z',
    ...over,
  };
}
const empty: DocumentsResponse = { cv: null, coverLetter: null };

beforeEach(() => {
  mockFetch.mockReset();
  mockUpload.mockReset();
});

const renderPage = (pollMs = 3000) =>
  render(
    <MemoryRouter>
      <DocumentsPage pollMs={pollMs} />
    </MemoryRouter>,
  );

describe('DocumentsPage', () => {
  test('shows empty slots with upload buttons', async () => {
    mockFetch.mockResolvedValue(empty);
    renderPage();
    expect(await screen.findByText('No CV yet')).toBeInTheDocument();
    expect(screen.getByText('No cover letter yet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'My documents' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your CV' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your cover letter' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload CV' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload cover letter' })).toBeInTheDocument();
  });

  test('filled slots show file name, status and warnings', async () => {
    mockFetch.mockResolvedValue({
      cv: doc({
        warnings: [
          { code: 'missing_work_rights', detail: '' },
          { code: 'degree_status_unclear', detail: '' },
          { code: 'banned_phrase', detail: 'passionate' },
        ],
      }),
      coverLetter: doc({ id: 'd2', kind: 'cover_letter', sourceRef: 'cover.docx', analysisStatus: 'in_progress' }),
    });
    renderPage();
    expect(await screen.findByText('my-cv.pdf')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('cover.docx')).toBeInTheDocument();
    expect(screen.getByText('Analysing…')).toBeInTheDocument();
    expect(screen.getByText('No work-rights line (e.g. "Full working rights (485 visa)")')).toBeInTheDocument();
    expect(screen.getByText('Degree status unclear — say e.g. "(conferral Nov 2026)"')).toBeInTheDocument();
    expect(screen.getByText('Phrase that reads as AI or cliché: passionate')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Replace' })).toHaveLength(2);
  });

  test('failed analysis shows the error', async () => {
    mockFetch.mockResolvedValue({ ...empty, cv: doc({ analysisStatus: 'failed', analysisError: 'bad pdf' }) });
    renderPage();
    expect(await screen.findByText("Couldn't read this document: bad pdf")).toBeInTheDocument();
  });

  test('replace asks in-page first, then uploads', async () => {
    mockFetch.mockResolvedValue({ ...empty, cv: doc({}) });
    mockUpload.mockResolvedValue({ sourceRef: 'new.pdf' });
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Replace my-cv.pdf? The current file will be replaced.')).toBeInTheDocument();
    expect(mockUpload).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace file' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const file = new File(['x'], 'new.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('Choose CV file'), file);
    await waitFor(() => expect(mockUpload).toHaveBeenCalledWith('cv', file));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  test('ready slot links to view and edit', async () => {
    mockFetch.mockResolvedValue({ cv: doc({}), coverLetter: doc({ id: 'd2', kind: 'cover_letter', sourceRef: 'c.pdf' }) });
    renderPage();
    const links = await screen.findAllByRole('link', { name: 'View and edit' });
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/documents/cv', '/documents/cover-letter']);
    expect(screen.queryByText('Edited in the app', { exact: false })).not.toBeInTheDocument();
  });

  test('no view and edit link while analysing or failed', async () => {
    mockFetch.mockResolvedValue({ cv: doc({ analysisStatus: 'in_progress' }), coverLetter: doc({ id: 'd2', kind: 'cover_letter', analysisStatus: 'failed' }) });
    renderPage();
    await screen.findByText('Analysing…');
    expect(screen.queryByRole('link', { name: 'View and edit' })).not.toBeInTheDocument();
  });

  test('edited slot shows the label', async () => {
    mockFetch.mockResolvedValue({ ...empty, cv: doc({ edited: true, editedAt: '2026-11-10T02:00:00.000Z' }) });
    renderPage();
    expect(await screen.findByText(/Edited in the app/)).toBeInTheDocument();
  });

  test('replace warns when edited', async () => {
    mockFetch.mockResolvedValue({ ...empty, cv: doc({ edited: true, editedAt: '2026-11-10T02:00:00.000Z' }) });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    expect(
      within(screen.getByRole('dialog')).getByText('Replace my-cv.pdf? Your edits in the app will be lost; the new file is read fresh.'),
    ).toBeInTheDocument();
  });

  test('cancel leaves the file alone', async () => {
    mockFetch.mockResolvedValue({ ...empty, cv: doc({}) });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  test('upload into an empty slot needs no confirm', async () => {
    mockFetch.mockResolvedValue(empty);
    mockUpload.mockResolvedValue({ sourceRef: 'cv.pdf' });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Upload CV' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const file = new File(['x'], 'cv.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('Choose CV file'), file);
    await waitFor(() => expect(mockUpload).toHaveBeenCalledWith('cv', file));
  });

  test('upload errors map to messages', async () => {
    mockFetch.mockResolvedValue(empty);
    renderPage();
    await screen.findByText('No CV yet');
    mockUpload.mockRejectedValueOnce(new ApiError(400, 'x'));
    await userEvent.upload(screen.getByLabelText('Choose cover letter file'), new File(['x'], 'a.pdf'));
    expect(await screen.findByText("That file can't be used. Upload a PDF or Word file under 5 MB.")).toBeInTheDocument();
    mockUpload.mockRejectedValueOnce(new ApiError(413, 'x'));
    await userEvent.upload(screen.getByLabelText('Choose CV file'), new File(['x'], 'b.pdf'));
    expect(await screen.findByText("That file can't be used. Upload a PDF or Word file under 5 MB.")).toBeInTheDocument();
    mockUpload.mockRejectedValueOnce(new ApiError(502, 'x'));
    await userEvent.upload(screen.getByLabelText('Choose CV file'), new File(['x'], 'c.pdf'));
    expect(await screen.findByText("Couldn't upload that file. Try again.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/folder/i);
  });

  test('only the two slots: no other files and no delete', async () => {
    mockFetch.mockResolvedValue({ cv: doc({}), coverLetter: doc({ id: 'd2', kind: 'cover_letter', sourceRef: 'cover.docx' }) });
    renderPage();
    await screen.findByText('my-cv.pdf');
    expect(screen.getAllByRole('region')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/not used|other files|folder/i)).not.toBeInTheDocument();
  });

  test('an unreadable document shows why', async () => {
    mockFetch.mockResolvedValue({ ...empty, cv: doc({ analysisStatus: 'skipped', warnings: [{ code: 'unreadable_file', detail: '' }] }) });
    renderPage();
    expect(await screen.findByText("Couldn't read this file")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();
  });

  test('polls until analysis settles', async () => {
    mockFetch
      .mockResolvedValueOnce({ ...empty, cv: doc({ analysisStatus: 'in_progress' }) })
      .mockResolvedValue({ ...empty, cv: doc({ analysisStatus: 'done' }) });
    renderPage(20);
    expect(await screen.findByText('Analysing…')).toBeInTheDocument();
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    const calls = mockFetch.mock.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(mockFetch.mock.calls.length).toBe(calls);
  });

  test('shows an error when loading fails', async () => {
    mockFetch.mockRejectedValue(new ApiError(500, 'x'));
    renderPage();
    expect(await screen.findByText("Couldn't load your documents. Is the backend running?")).toBeInTheDocument();
  });
});

describe('navigation', () => {
  test('nav switches between Jobs and My documents', async () => {
    mockFetch.mockResolvedValue(empty);
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'My documents' }));
    expect(await screen.findByRole('heading', { name: 'My documents' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Jobs' }));
    expect(await screen.findByRole('heading', { name: 'Jobs' })).toBeInTheDocument();
  });
});
