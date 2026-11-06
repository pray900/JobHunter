import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  createDocumentFolders,
  DocumentExistsError,
  DocumentFolderMissingError,
  DocumentNotFoundError,
  sanitiseDocumentName,
} from '../src/storage/documentFolder.js';

let root: string;
let cv: string;
let cl: string;
const folders = () => createDocumentFolders({ cv, cover_letter: cl });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'docfolder-'));
  cv = path.join(root, 'cv');
  cl = path.join(root, 'cl');
  await fs.mkdir(cv);
  await fs.mkdir(cl);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('listDocuments returns only pdf/docx, skipping lock, hidden and other files', async () => {
  for (const n of ['a.pdf', 'B.DOCX', '~$c.docx', '.d.pdf', 'e.txt']) await fs.writeFile(path.join(cv, n), 'x');
  await fs.mkdir(path.join(cv, 'sub.pdf'));
  const list = await folders().listDocuments('cv');
  expect(list.map((f) => f.name)).toEqual(['B.DOCX', 'a.pdf']);
});

test('missing folder throws DocumentFolderMissingError', async () => {
  await fs.rm(cl, { recursive: true });
  await expect(folders().listDocuments('cover_letter')).rejects.toBeInstanceOf(DocumentFolderMissingError);
});

test('writeDocument refuses overwrite unless replace, leaves no temp files', async () => {
  const f = folders();
  await f.writeDocument('cv', 'a.pdf', Buffer.from('one'), { replace: false });
  await expect(f.writeDocument('cv', 'a.pdf', Buffer.from('two'), { replace: false })).rejects.toBeInstanceOf(
    DocumentExistsError,
  );
  expect(await fs.readFile(path.join(cv, 'a.pdf'), 'utf8')).toBe('one');
  await f.writeDocument('cv', 'a.pdf', Buffer.from('two'), { replace: true });
  expect(await fs.readFile(path.join(cv, 'a.pdf'), 'utf8')).toBe('two');
  expect(await fs.readdir(cv)).toEqual(['a.pdf']);
});

test('writeDocument and deleteDocument reject unsafe names', async () => {
  const f = folders();
  for (const n of ['../x.pdf', 'a/b.pdf', 'a\\b.pdf', '..', '']) {
    await expect(f.writeDocument('cv', n, Buffer.from('x'), { replace: true })).rejects.toThrow();
    await expect(f.deleteDocument('cv', n)).rejects.toThrow();
  }
});

test('deleteDocument removes a file; unknown or directory -> DocumentNotFoundError', async () => {
  await fs.writeFile(path.join(cv, 'a.pdf'), 'x');
  await fs.mkdir(path.join(cv, 'd.pdf'));
  const f = folders();
  await f.deleteDocument('cv', 'a.pdf');
  await expect(f.deleteDocument('cv', 'a.pdf')).rejects.toBeInstanceOf(DocumentNotFoundError);
  await expect(f.deleteDocument('cv', 'd.pdf')).rejects.toBeInstanceOf(DocumentNotFoundError);
  expect((await fs.stat(path.join(cv, 'd.pdf'))).isDirectory()).toBe(true);
});

test('sanitiseDocumentName strips odd characters, keeps extension', () => {
  expect(sanitiseDocumentName('CV – Sep*2026.pdf')).toBe('CV  Sep2026.pdf');
  expect(sanitiseDocumentName('x.exe')).toBeNull();
  expect(sanitiseDocumentName('.hidden.pdf')).toBeNull();
  expect(sanitiseDocumentName('~$x.docx')).toBeNull();
  expect(sanitiseDocumentName('../x.pdf')).toBeNull();
  expect(sanitiseDocumentName('a/b.pdf')).toBeNull();
  expect(sanitiseDocumentName('a\\b.pdf')).toBeNull();
  expect(sanitiseDocumentName('a..b.PDF')).toBe('a.b.PDF');
  expect(sanitiseDocumentName('***.pdf')).toBeNull();
});
