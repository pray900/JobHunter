import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as client from '../api/client';
import type { BaseCoverLetterFacts, BaseCvFacts, BaseDocumentFacts, DocumentKind } from '../api/types';
import { BaseDocumentPage } from './BaseDocumentPage';

vi.mock('../api/client', async (orig) => ({
  ...(await orig<typeof import('../api/client')>()),
  fetchBaseFacts: vi.fn(),
  saveBaseFacts: vi.fn(),
}));
const m = vi.mocked(client);

const cvFacts: BaseCvFacts = {
  name: 'Sam Example',
  headline: 'Salesforce developer',
  summary: 'Builds things.',
  workRights: 'Full working rights',
  education: [{ qualification: 'Master of IT', institution: 'Example University', dates: '2025-2026', statusText: 'conferral Nov 2026' }],
  roles: [
    { title: 'Developer', employer: 'Acme Pty Ltd', dates: '2022-2025', bullets: ['Built the thing', 'Fixed the other thing', 'Shipped it'] },
  ],
  projects: [{ name: 'JobTool', bullets: ['Wrote a tool'] }],
  skills: ['Apex', 'SQL'],
  metrics: ['Cut load time by 40%'],
  contact: { location: 'Sydney', email: 'sam@example.com', phone: '0400 000 000', links: ['example.com/sam'] },
};
const letterFacts: BaseCoverLetterFacts = {
  previousTarget: { company: 'Old Co', addressee: 'Hiring team', role: 'Analyst' },
  reusableParagraphs: ['I like building things.'],
  toneNotes: 'Warm and direct.',
};

function doc(over: Partial<BaseDocumentFacts> = {}): BaseDocumentFacts {
  return {
    id: 'd1',
    kind: 'cv',
    sourceRef: 'my-cv.pdf',
    mediaType: 'application/pdf',
    contentHash: 'hash-1',
    facts: cvFacts,
    edited: false,
    editedAt: null,
    warnings: [],
    rescoreJobs: 0,
    ...over,
  };
}

function renderPage(kind: DocumentKind = 'cv') {
  return render(
    <MemoryRouter initialEntries={['/documents/x']}>
      <Link to="/documents">Away</Link>
      <Routes>
        <Route path="/documents/x" element={<BaseDocumentPage kind={kind} />} />
        <Route path="/documents" element={<p>Documents list</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  m.fetchBaseFacts.mockResolvedValue(doc());
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByText('Sam Example');
  await user.click(screen.getByRole('button', { name: /^Edit/ }));
}

describe('BaseDocumentPage', () => {
  test('shows the PDF original beside the facts', async () => {
    renderPage();
    const frame = await screen.findByTitle('Original file');
    expect(frame).toHaveAttribute('src', '/api/documents/file?kind=cv');
    expect(screen.getByText('Sam Example')).toBeInTheDocument();
    expect(screen.getByText('Built the thing')).toBeInTheDocument();
    expect(screen.getByText('my-cv.pdf')).toBeInTheDocument();
  });

  test('Word original offers download', async () => {
    m.fetchBaseFacts.mockResolvedValue(doc({ mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sourceRef: 'my-cv.docx' }));
    renderPage();
    const link = await screen.findByRole('link', { name: 'Download original' });
    expect(link).toHaveAttribute('href', '/api/documents/file?kind=cv');
    expect(screen.queryByTitle('Original file')).toBeNull();
  });

  test('shows warnings with their labels', async () => {
    m.fetchBaseFacts.mockResolvedValue(doc({ warnings: [{ code: 'missing_work_rights', detail: '' }] }));
    renderPage();
    expect(await screen.findByText(/No work-rights line/)).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });

  test('E opens the editor, not while typing', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Sam Example');
    await user.keyboard('e');
    const name = await screen.findByLabelText('Name');
    expect(name).toBeInTheDocument();
    await user.click(name);
    await user.keyboard('e');
    expect(name).toHaveValue('Sam Examplee');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  test('edit a qualification and save sends the edited facts', async () => {
    const user = userEvent.setup();
    const saved = doc({ edited: true, editedAt: '2026-11-14T01:00:00.000Z', facts: { ...cvFacts, education: [{ ...cvFacts.education[0]!, qualification: 'Master of Data' }] } });
    m.saveBaseFacts.mockResolvedValue(saved);
    renderPage();
    await openEditor(user);
    const q = screen.getByLabelText('Qualification 1');
    await user.clear(q);
    await user.type(q, 'Master of Data');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(m.saveBaseFacts).toHaveBeenCalledTimes(1));
    const [kind, id, hash, facts] = m.saveBaseFacts.mock.calls[0]!;
    expect([kind, id, hash]).toEqual(['cv', 'd1', 'hash-1']);
    expect((facts as BaseCvFacts).education[0]!.qualification).toBe('Master of Data');
    expect((facts as BaseCvFacts).roles).toEqual(cvFacts.roles);
    expect(await screen.findByText(/Edited in the app/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByText('Master of Data')).toBeInTheDocument();
  });

  test('shows the re-score cost for a CV', async () => {
    const user = userEvent.setup();
    m.fetchBaseFacts.mockResolvedValue(doc({ rescoreJobs: 25 }));
    renderPage();
    await openEditor(user);
    expect(screen.getByText('Saving re-scores your 25 jobs (about US$0.40).')).toBeInTheDocument();
  });

  test('a cover letter shows no re-score cost and edits its paragraphs', async () => {
    const user = userEvent.setup();
    m.fetchBaseFacts.mockResolvedValue(doc({ kind: 'cover_letter', facts: letterFacts, rescoreJobs: 0 }));
    renderPage('cover_letter');
    await screen.findByText('I like building things.');
    await user.click(screen.getByRole('button', { name: /^Edit/ }));
    expect(screen.queryByText(/re-scores/)).toBeNull();
    expect(screen.getByLabelText('Company')).toHaveValue('Old Co');
    expect(screen.getByLabelText('Paragraph 1')).toHaveValue('I like building things.');
  });

  test('undo all edits confirms then saves null', async () => {
    const user = userEvent.setup();
    m.fetchBaseFacts.mockResolvedValue(doc({ edited: true, editedAt: '2026-11-14T01:00:00.000Z' }));
    m.saveBaseFacts.mockResolvedValue(doc());
    renderPage();
    await screen.findByText(/Edited in the app/);
    await user.click(screen.getByRole('button', { name: 'Undo all edits' }));
    expect(screen.getByText('Undo all your edits? Your CV goes back to what was read from the file.')).toBeInTheDocument();
    expect(m.saveBaseFacts).not.toHaveBeenCalled();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Undo all edits' }));
    await waitFor(() => expect(m.saveBaseFacts).toHaveBeenCalledWith('cv', 'd1', 'hash-1', null));
    await waitFor(() => expect(screen.queryByText(/Edited in the app/)).toBeNull());
  });

  test('409 shows reload message', async () => {
    const user = userEvent.setup();
    m.saveBaseFacts.mockRejectedValue(new client.ApiError(409, 'conflict', 'document_changed'));
    renderPage();
    await openEditor(user);
    await user.type(screen.getByLabelText('Headline'), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Your CV changed since you opened it. Reload to edit the new one.')).toBeInTheDocument();
    m.fetchBaseFacts.mockResolvedValue(doc({ contentHash: 'hash-2', facts: { ...cvFacts, name: 'Sam Newer' } }));
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(await screen.findByText('Sam Newer')).toBeInTheDocument();
    expect(screen.queryByText(/changed since you opened/)).toBeNull();
  });

  test('invalid_facts marks the field', async () => {
    const user = userEvent.setup();
    m.saveBaseFacts.mockRejectedValue(new client.ApiError(400, 'bad', 'invalid_facts', 'facts.roles[0].bullets[2]'));
    renderPage();
    await openEditor(user);
    await user.type(screen.getByLabelText('Developer bullet 3'), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByLabelText('Developer bullet 3')).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByLabelText('Developer bullet 1')).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(/isn't valid/);
  });

  test('unsaved edits ask before leaving', async () => {
    const user = userEvent.setup();
    renderPage();
    await openEditor(user);
    await user.type(screen.getByLabelText('Headline'), '!');
    await user.click(screen.getByRole('link', { name: 'Away' }));
    expect(screen.getByText('You have unsaved edits — leave anyway?')).toBeInTheDocument();
    expect(screen.queryByText('Documents list')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Leave' }));
    expect(await screen.findByText('Documents list')).toBeInTheDocument();
  });

  test('no question about leaving when nothing changed', async () => {
    const user = userEvent.setup();
    renderPage();
    await openEditor(user);
    await user.click(screen.getByRole('link', { name: 'Away' }));
    expect(await screen.findByText('Documents list')).toBeInTheDocument();
  });

  test('add, remove and move a bullet', async () => {
    const user = userEvent.setup();
    m.saveBaseFacts.mockResolvedValue(doc());
    renderPage();
    await openEditor(user);
    await user.click(screen.getByRole('button', { name: 'Move Developer bullet 3 up' }));
    expect(screen.getByLabelText('Developer bullet 2')).toHaveValue('Shipped it');
    expect(screen.getByLabelText('Developer bullet 3')).toHaveValue('Fixed the other thing');
    await user.click(screen.getByRole('button', { name: 'Remove Developer bullet 1' }));
    expect(screen.queryByLabelText('Developer bullet 3')).toBeNull();
    expect(screen.getByLabelText('Developer bullet 1')).toHaveValue('Shipped it');
    await user.click(screen.getByRole('button', { name: 'Add Developer bullet' }));
    expect(screen.getByLabelText('Developer bullet 3')).toHaveValue('');
    await user.type(screen.getByLabelText('Developer bullet 3'), 'New one');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(m.saveBaseFacts).toHaveBeenCalled());
    const facts = m.saveBaseFacts.mock.calls[0]![3] as BaseCvFacts;
    expect(facts.roles[0]!.bullets).toEqual(['Shipped it', 'Fixed the other thing', 'New one']);
  });

  test('Cancel with changes asks, then returns to the facts', async () => {
    const user = userEvent.setup();
    renderPage();
    await openEditor(user);
    await user.type(screen.getByLabelText('Headline'), '!');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByText('Salesforce developer')).toBeInTheDocument();
  });
});
