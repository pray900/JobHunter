import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError, deleteDocument, fetchDocuments, uploadDocument } from '../api/client';
import type { BaseDocumentSummary, DocumentsResponse } from '../api/types';
import { App } from '../App';
import { DocumentsPage } from './DocumentsPage';

vi.mock('../api/client', async (orig) => ({
  ...(await orig<typeof import('../api/client')>()),
  fetchDocuments: vi.fn(),
  uploadDocument: vi.fn(),
  deleteDocument: vi.fn(),
  fetchJobs: vi.fn().mockResolvedValue([]),
}));
const mockFetch = vi.mocked(fetchDocuments);
const mockUpload = vi.mocked(uploadDocument);
const mockDelete = vi.mocked(deleteDocument);

function doc(over: Partial<BaseDocumentSummary>): BaseDocumentSummary {
  return {
    id: 'd1',
    kind: 'cv',
    sourceRef: 'my-cv.pdf',
    analysisStatus: 'done',
    analysisError: null,
    warnings: [],
    updatedAt: '2026-11-07T00:00:00.000Z',
    ...over,
  };
}
const empty: DocumentsResponse = { cv: null, coverLetter: null, ignored: [] };

beforeEach(() => {
  mockFetch.mockReset();
  mockUpload.mockReset();
  mockDelete.mockReset();
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
      ignored: [],
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
    expect(within(dialog).getByText('Replace my-cv.pdf? The old file is removed from your folder.')).toBeInTheDocument();
    expect(mockUpload).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace file' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const file = new File(['x'], 'new.pdf', { type: 'application/pdf' });
    await userEvent.upload(screen.getByLabelText('Choose CV file'), file);
    await waitFor(() => expect(mockUpload).toHaveBeenCalledWith('cv', file));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  test('cancel leaves the file alone', async () => {
    mockFetch.mockResolvedValue({ ...empty, cv: doc({}) });
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Replace' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockUpload).not.toHaveBeenCalled();
  });

  test('upload errors map to messages', async () => {
    mockFetch.mockResolvedValue(empty);
    renderPage();
    await screen.findByText('No CV yet');
    mockUpload.mockRejectedValueOnce(new ApiError(409, 'x'));
    await userEvent.upload(screen.getByLabelText('Choose CV file'), new File(['x'], 'a.pdf'));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A file with that name is already in the folder. Rename your file and try again.',
    );
    mockUpload.mockRejectedValueOnce(new ApiError(400, 'x'));
    await userEvent.upload(screen.getByLabelText('Choose cover letter file'), new File(['x'], 'a.pdf'));
    expect(await screen.findByText("That file can't be used. Upload a PDF or Word file under 5 MB.")).toBeInTheDocument();
    mockUpload.mockRejectedValueOnce(new ApiError(413, 'x'));
    await userEvent.upload(screen.getByLabelText('Choose CV file'), new File(['x'], 'b.pdf'));
    expect(await screen.findByText("That file can't be used. Upload a PDF or Word file under 5 MB.")).toBeInTheDocument();
    mockUpload.mockRejectedValueOnce(new ApiError(503, 'x'));
    await userEvent.upload(screen.getByLabelText('Choose CV file'), new File(['x'], 'c.pdf'));
    expect(await screen.findByText('Your documents folder is missing. Check the folder path in .env.')).toBeInTheDocument();
  });

  test('lists ignored files and deletes after in-page confirm', async () => {
    mockFetch.mockResolvedValue({
      ...empty,
      ignored: [
        doc({ id: 'x1', sourceRef: 'old.pdf', warnings: [{ code: 'extra_file_ignored', detail: 'Only one CV is used.' }] }),
        doc({ id: 'x2', sourceRef: 'bad.docx', warnings: [{ code: 'unreadable_file', detail: '' }] }),
      ],
    });
    mockDelete.mockResolvedValue();
    renderPage();
    expect(await screen.findByText('Other files in your folders (not used)')).toBeInTheDocument();
    expect(screen.getByText('old.pdf')).toBeInTheDocument();
    expect(screen.getByText('Only one CV is used.')).toBeInTheDocument();
    expect(screen.getByText("Couldn't read this file")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Delete old.pdf? This removes the file from your folder.')).toBeInTheDocument();
    expect(mockDelete).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('x1'));
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
