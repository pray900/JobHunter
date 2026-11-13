import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { createDocumentStore } from '../src/storage/documentFolder.js';
import { makeDocx } from '../../../tests/helpers/makeDocx.js';
import type { ScannedDocument } from '../src/documents/types.js';

let root: string;
let docs: string;
const PDF = Buffer.from('%PDF-1.4\nfake body\n');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'docroutes-'));
  docs = path.join(root, 'documents');
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const app = () => buildServer({ jobFolderDir: root, documentsDir: docs });
// Every file stored for a kind (any depth), except the pointer file.
const storedFiles = async (kind: string) =>
  (await fs.readdir(path.join(docs, kind), { recursive: true, withFileTypes: true }).catch(() => []))
    .filter((e) => e.isFile() && e.name !== '.current.json')
    .map((e) => path.join(e.parentPath, e.name));
const storedNames = async (kind: string) => (await storedFiles(kind)).map((f) => path.basename(f)).sort();
const storedBytes = async (kind: string) => fs.readFile((await storedFiles(kind))[0]);
// Places a document in the store the way an upload does (bypassing the route's content checks).
const place = (kind: 'cv' | 'cover_letter', name: string, bytes: Buffer) =>
  createDocumentStore(docs).saveDocument(kind, name, bytes);

async function upload(name: string, bytes: Buffer, opts: { kind?: string; query?: string } = {}) {
  const boundary = 'XBOUNDARYX';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const payload = Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const a = app();
  const res = await a.inject({
    method: 'POST',
    url: `/documents/${opts.kind ?? 'cv'}${opts.query ?? ''}`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  await a.close();
  return res;
}

async function scan(): Promise<ScannedDocument[]> {
  const a = app();
  const res = await a.inject({ method: 'POST', url: '/documents/scan' });
  await a.close();
  expect(res.statusCode).toBe(200);
  return res.json().documents;
}

test('scan of an empty store returns no documents', async () => {
  expect(await scan()).toEqual([]);
});

test('scan returns the stored PDF as base64 and the stored DOCX as text', async () => {
  const docx = await makeDocx([{ text: 'Jane Doe' }, { text: 'Engineer' }]);
  await place('cv', 'cv.pdf', PDF);
  await place('cover_letter', 'letter.docx', docx);
  const documents = await scan();
  expect(documents).toHaveLength(2);
  const pdf = documents.find((d) => d.kind === 'cv')!;
  expect(pdf).toEqual({
    kind: 'cv',
    sourceRef: 'cv.pdf',
    mediaType: 'application/pdf',
    contentHash: sha(PDF),
    pdfBase64: PDF.toString('base64'),
    text: null,
    warnings: [],
  });
  const word = documents.find((d) => d.kind === 'cover_letter')!;
  expect(word).toMatchObject({
    sourceRef: 'letter.docx',
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pdfBase64: null,
    text: 'Jane Doe\nEngineer',
    contentHash: sha(docx),
  });
});

test('scan reads only the stored document of each kind, never other files', async () => {
  await place('cv', 'old.pdf', PDF);
  await place('cv', 'new.pdf', Buffer.concat([PDF, Buffer.from('2')]));
  await fs.mkdir(path.join(docs, 'cv', '0123456789abcdef'));
  await fs.writeFile(path.join(docs, 'cv', '0123456789abcdef', 'stray.pdf'), PDF);
  await fs.writeFile(path.join(root, 'outside.pdf'), PDF);
  const documents = await scan();
  expect(documents.map((d) => d.sourceRef)).toEqual(['new.pdf']);
});

test('GET /documents lists the stored documents without reading their content', async () => {
  await place('cv', 'cv.pdf', PDF);
  const a = app();
  const res = await a.inject({ method: 'GET', url: '/documents' });
  await a.close();
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ documents: [{ kind: 'cv', sourceRef: 'cv.pdf', contentHash: sha(PDF) }] });
});

test('docx with no readable text gets unreadable_file and no text', async () => {
  await place('cv', 'empty.docx', await makeDocx([{ text: '   ' }, { text: '' }]));
  expect((await scan())[0]).toMatchObject({ text: null, pdfBase64: null, warnings: ['unreadable_file'] });
});

test('unreadable docx gets unreadable_file warning', async () => {
  await place('cv', 'bad.docx', Buffer.from('PK\u0003\u0004 not really a zip'));
  expect((await scan())[0]).toMatchObject({ text: null, warnings: ['unreadable_file'] });
});

test('scan flags an over-5MB stored file as unreadable but keeps its hash', async () => {
  const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
  await place('cv', 'big.pdf', big);
  expect((await scan())[0]).toMatchObject({
    sourceRef: 'big.pdf',
    pdfBase64: null,
    text: null,
    warnings: ['unreadable_file'],
    contentHash: sha(big),
  });
});

test('upload into an empty slot stores it', async () => {
  const res = await upload('a.pdf', PDF);
  expect(res.statusCode).toBe(201);
  expect(res.json()).toEqual({ sourceRef: 'a.pdf' });
  expect(await storedNames('cv')).toEqual(['a.pdf']);
  expect((await storedBytes('cv')).equals(PDF)).toBe(true);
});

test('upload replaces the current document, whatever its name', async () => {
  expect((await upload('a.pdf', PDF)).statusCode).toBe(201);
  const same = await upload('a.pdf', Buffer.concat([PDF, Buffer.from('2')]));
  expect(same.statusCode).toBe(201);
  expect(await storedNames('cv')).toEqual(['a.pdf']);
  expect((await storedBytes('cv')).length).toBe(PDF.length + 1);
  const other = await upload('b.pdf', PDF, { query: '?replace=false' });
  expect(other.statusCode).toBe(201);
  expect(other.json()).toEqual({ sourceRef: 'b.pdf' });
  expect(await storedNames('cv')).toEqual(['b.pdf']);
});

test('uploads docx to the cover_letter slot', async () => {
  const docx = await makeDocx([{ text: 'Hi' }]);
  const res = await upload('l.docx', docx, { kind: 'cover_letter' });
  expect(res.statusCode).toBe(201);
  expect((await storedBytes('cover_letter')).equals(docx)).toBe(true);
  expect(await storedNames('cv')).toEqual([]);
});

test('rejects traversal and bad extensions', async () => {
  for (const name of ['../x.pdf', 'a/b.pdf', 'a\\b.pdf', 'x.exe', '.hidden.pdf', '~$x.docx']) {
    expect((await upload(name, PDF)).statusCode, name).toBe(400);
  }
  expect(await storedNames('cv')).toEqual([]);
  expect((await fs.readdir(root)).filter((n) => n !== 'documents')).toEqual([]);
});

test('rejects non-pdf bytes, non-zip docx, empty and oversize; the current document is kept', async () => {
  await upload('keep.pdf', PDF);
  const r = await upload('x.pdf', Buffer.from('hello'));
  expect(r.statusCode).toBe(400);
  expect(r.json()).toEqual({ error: 'bad_file' });
  expect((await upload('x.docx', Buffer.from('hello'))).statusCode).toBe(400);
  expect((await upload('x.pdf', Buffer.alloc(0))).statusCode).toBe(400);
  const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
  expect((await upload('big.pdf', big)).statusCode).toBe(400);
  expect(await storedNames('cv')).toEqual(['keep.pdf']);
});

test('unknown kind -> 404', async () => {
  expect((await upload('a.pdf', PDF, { kind: 'other' })).statusCode).toBe(404);
});

test('there is no delete route', async () => {
  await upload('a.pdf', PDF);
  const a = app();
  const res = await a.inject({ method: 'DELETE', url: '/documents/cv/a.pdf' });
  await a.close();
  expect(res.statusCode).toBe(404);
  expect(await storedNames('cv')).toEqual(['a.pdf']);
});

test('sanitises odd characters but keeps the extension', async () => {
  const res = await upload("Prayush's CV – Sep*2026.pdf", PDF);
  expect(res.statusCode).toBe(201);
  const { sourceRef } = res.json();
  expect(sourceRef).toBe('Prayushs CV  Sep2026.pdf');
  expect(await storedNames('cv')).toEqual([sourceRef]);
});

describe('facts and file routes', () => {
  const facts = () => ({
    name: 'Jordan Testcase',
    headline: ' Backend Engineer ',
    summary: null,
    workRights: null,
    education: [],
    roles: [{ title: 'Engineer', employer: 'Acme', dates: '2022', bullets: ['Built things.', ' '] }],
    projects: [],
    skills: ['TypeScript'],
    metrics: [],
    contact: { location: null, email: null, phone: null, links: [] },
  });
  const post = async (payload: unknown) => {
    const phrases = path.join(root, 'banned-phrases.txt');
    await fs.writeFile(phrases, 'spearheaded');
    const a = buildServer({ jobFolderDir: root, documentsDir: docs, bannedPhrasesFile: phrases });
    const res = await a.inject({ method: 'POST', url: '/documents/facts/check', payload: payload as object });
    await a.close();
    return res;
  };

  test('facts/check returns normalised facts and warnings', async () => {
    const res = await post({ kind: 'cv', facts: facts() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.facts.headline).toBe('Backend Engineer');
    expect(body.facts.roles[0].bullets).toEqual(['Built things.']);
    expect(body.warnings.map((w: { code: string }) => w.code)).toContain('missing_work_rights');
  });

  test('facts/check 400 invalid_facts', async () => {
    const res = await post({ kind: 'cv', facts: { ...facts(), extra: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_facts', path: 'facts.extra' });
    expect((await post({ kind: 'cv' })).json()).toEqual({ error: 'invalid_facts', path: 'facts' });
    expect((await post({ kind: 'nope', facts: facts() })).json()).toEqual({ error: 'bad_request' });
  });

  test('file route returns the stored PDF bytes and type', async () => {
    await place('cv', 'my cv.pdf', PDF);
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/documents/cv/file' });
    await a.close();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-source-ref']).toBe('my cv.pdf');
    expect(res.rawPayload.equals(PDF)).toBe(true);
  });

  test('file route 404 when empty', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/documents/cv/file' });
    const unknown = await a.inject({ method: 'GET', url: '/documents/bogus/file' });
    await a.close();
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no_document' });
    expect(unknown.json()).toEqual({ error: 'unknown_kind' });
  });
});
