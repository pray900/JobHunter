import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { makeDocx } from '../../../tests/helpers/makeDocx.js';
import type { ScannedDocument } from '../src/documents/types.js';

let root: string;
let cv: string;
let cl: string;
const PDF = Buffer.from('%PDF-1.4\nfake body\n');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'docroutes-'));
  cv = path.join(root, 'cv');
  cl = path.join(root, 'cl');
  await fs.mkdir(cv);
  await fs.mkdir(cl);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const app = () => buildServer({ jobFolderDir: root, cvDir: cv, coverLetterDir: cl });

async function upload(name: string, bytes: Buffer, opts: { kind?: string; replace?: boolean } = {}) {
  const boundary = 'XBOUNDARYX';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const payload = Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const a = app();
  const res = await a.inject({
    method: 'POST',
    url: `/documents/${opts.kind ?? 'cv'}${opts.replace === undefined ? '' : `?replace=${opts.replace}`}`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  await a.close();
  return res;
}

test('scan returns PDFs as base64 and DOCX as text for both kinds', async () => {
  const docx = await makeDocx([{ text: 'Jane Doe' }, { text: 'Engineer' }]);
  await fs.writeFile(path.join(cv, 'cv.pdf'), PDF);
  await fs.writeFile(path.join(cl, 'letter.docx'), docx);
  const a = app();
  const res = await a.inject({ method: 'POST', url: '/documents/scan' });
  await a.close();
  expect(res.statusCode).toBe(200);
  const docs: ScannedDocument[] = res.json().documents;
  const pdf = docs.find((d) => d.kind === 'cv')!;
  expect(pdf).toMatchObject({
    sourceRef: 'cv.pdf',
    mediaType: 'application/pdf',
    text: null,
    warnings: [],
    contentHash: createHash('sha256').update(PDF).digest('hex'),
  });
  expect(Buffer.from(pdf.pdfBase64!, 'base64').equals(PDF)).toBe(true);
  const word = docs.find((d) => d.kind === 'cover_letter')!;
  expect(word.mediaType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  expect(word.pdfBase64).toBeNull();
  expect(word.text).toBe('Jane Doe\nEngineer');
  expect(word.contentHash).toBe(createHash('sha256').update(docx).digest('hex'));
});

test('unreadable docx gets unreadable_file warning', async () => {
  await fs.writeFile(path.join(cv, 'bad.docx'), 'not a zip');
  const a = app();
  const res = await a.inject({ method: 'POST', url: '/documents/scan' });
  await a.close();
  expect(res.json().documents[0]).toMatchObject({ text: null, warnings: ['unreadable_file'] });
});

test('docx with no readable text gets unreadable_file and no text', async () => {
  await fs.writeFile(path.join(cv, 'empty.docx'), await makeDocx([{ text: '   ' }, { text: '' }]));
  const a = app();
  const res = await a.inject({ method: 'POST', url: '/documents/scan' });
  await a.close();
  expect(res.json().documents[0]).toMatchObject({ text: null, pdfBase64: null, warnings: ['unreadable_file'] });
});

test('missing cv folder -> 503 document_folder_missing', async () => {
  await fs.rm(cv, { recursive: true });
  const a = app();
  const res = await a.inject({ method: 'POST', url: '/documents/scan' });
  await a.close();
  expect(res.statusCode).toBe(503);
  expect(res.json()).toEqual({ error: 'document_folder_missing', kind: 'cv' });
});

test('upload refuses to overwrite', async () => {
  expect((await upload('a.pdf', PDF)).statusCode).toBe(201);
  const second = await upload('a.pdf', Buffer.concat([PDF, Buffer.from('2')]));
  expect(second.statusCode).toBe(409);
  expect(second.json()).toEqual({ error: 'document_exists' });
  const third = await upload('a.pdf', Buffer.concat([PDF, Buffer.from('2')]), { replace: true });
  expect(third.statusCode).toBe(201);
  expect(third.json()).toEqual({ sourceRef: 'a.pdf' });
  expect((await fs.readFile(path.join(cv, 'a.pdf'))).length).toBe(PDF.length + 1);
});

test('uploads docx to cover_letter folder', async () => {
  const docx = await makeDocx([{ text: 'Hi' }]);
  const res = await upload('l.docx', docx, { kind: 'cover_letter' });
  expect(res.statusCode).toBe(201);
  expect((await fs.readFile(path.join(cl, 'l.docx'))).equals(docx)).toBe(true);
});

test('rejects traversal and bad extensions', async () => {
  for (const name of ['../x.pdf', 'a/b.pdf', 'a\\b.pdf', 'x.exe', '.hidden.pdf', '~$x.docx']) {
    expect((await upload(name, PDF)).statusCode, name).toBe(400);
  }
  expect(await fs.readdir(cv)).toEqual([]);
  expect((await fs.readdir(root)).sort()).toEqual(['cl', 'cv']);
});

test('rejects non-pdf bytes, non-zip docx, empty and oversize', async () => {
  const r = await upload('x.pdf', Buffer.from('hello'));
  expect(r.statusCode).toBe(400);
  expect(r.json()).toEqual({ error: 'bad_file' });
  expect((await upload('x.docx', Buffer.from('hello'))).statusCode).toBe(400);
  expect((await upload('x.pdf', Buffer.alloc(0))).statusCode).toBe(400);
  const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
  expect((await upload('big.pdf', big)).statusCode).toBe(400);
  expect(await fs.readdir(cv)).toEqual([]);
});

test('unknown kind -> 404', async () => {
  expect((await upload('a.pdf', PDF, { kind: 'other' })).statusCode).toBe(404);
});

test('delete removes the file; unknown name -> 404', async () => {
  await fs.writeFile(path.join(cv, 'a.pdf'), PDF);
  const a = app();
  expect((await a.inject({ method: 'DELETE', url: '/documents/cv/a.pdf' })).statusCode).toBe(204);
  expect((await a.inject({ method: 'DELETE', url: '/documents/cv/a.pdf' })).statusCode).toBe(404);
  expect((await a.inject({ method: 'DELETE', url: '/documents/cv/..%2Fx.pdf' })).statusCode).toBe(404);
  await a.close();
  expect(await fs.readdir(cv)).toEqual([]);
});

test('sanitises odd characters but keeps the extension', async () => {
  const res = await upload('CV – Sep*2026.pdf', PDF);
  expect(res.statusCode).toBe(201);
  const { sourceRef } = res.json();
  expect(sourceRef).toBe('CV  Sep2026.pdf');
  expect(await fs.readdir(cv)).toEqual([sourceRef]);
});

test('scan flags an over-5MB file as unreadable but keeps its hash', async () => {
  const big = Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)]);
  await fs.writeFile(path.join(cv, 'big.pdf'), big);
  const a = app();
  const res = await a.inject({ method: 'POST', url: '/documents/scan' });
  await a.close();
  expect(res.json().documents[0]).toMatchObject({
    sourceRef: 'big.pdf',
    pdfBase64: null,
    text: null,
    warnings: ['unreadable_file'],
    contentHash: createHash('sha256').update(big).digest('hex'),
  });
});

test('delete and replace work on a hand-placed name with odd characters', async () => {
  const name = "Prayush's CV \u2013 M\u00fcller.pdf";
  await fs.writeFile(path.join(cv, name), PDF);
  const a = app();
  const del = await a.inject({ method: 'DELETE', url: `/documents/cv/${encodeURIComponent(name)}` });
  expect(del.statusCode).toBe(204);
  expect((await a.inject({ method: 'DELETE', url: `/documents/cv/${encodeURIComponent(name)}` })).statusCode).toBe(404);
  await a.close();
  await fs.writeFile(path.join(cv, name), PDF);
  const res = await upload(name, Buffer.concat([PDF, Buffer.from('2')]), { replace: true });
  expect(res.statusCode).toBe(201);
  expect(res.json()).toEqual({ sourceRef: name });
  expect(await fs.readdir(cv)).toEqual([name]);
  expect((await fs.readFile(path.join(cv, name))).length).toBe(PDF.length + 1);
});

test('scan reports modifiedAt for every document', async () => {
  await fs.writeFile(path.join(cv, 'old.pdf'), PDF);
  await fs.writeFile(path.join(cv, 'new.pdf'), PDF);
  await fs.writeFile(path.join(cl, 'broken.docx'), 'not a zip');
  const older = new Date('2026-01-01T00:00:00.000Z');
  const newer = new Date('2026-02-01T10:20:30.000Z');
  await fs.utimes(path.join(cv, 'old.pdf'), older, older);
  await fs.utimes(path.join(cv, 'new.pdf'), newer, newer);
  await fs.utimes(path.join(cl, 'broken.docx'), older, older);
  const a = app();
  const res = await a.inject({ method: 'POST', url: '/documents/scan' });
  await a.close();
  const docs: ScannedDocument[] = res.json().documents;
  const byRef = Object.fromEntries(docs.map((d) => [d.sourceRef, d.modifiedAt]));
  expect(byRef).toEqual({
    'old.pdf': older.toISOString(),
    'new.pdf': newer.toISOString(),
    'broken.docx': older.toISOString(),
  });
});
