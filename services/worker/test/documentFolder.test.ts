import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createDocumentStore, sanitiseDocumentName } from '../src/storage/documentFolder.js';

let root: string;
const store = (opts: Parameters<typeof createDocumentStore>[1] = {}) => createDocumentStore(root, opts);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
// Every file stored for a kind (any depth), except the pointer file.
const storedFiles = async (kind: string) =>
  (await fs.readdir(path.join(root, kind), { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile() && e.name !== '.current.json')
    .map((e) => path.join(e.parentPath, e.name));
const storedNames = async (kind: string) => (await storedFiles(kind)).map((f) => path.basename(f)).sort();

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'docstore-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('an empty store has no document of either kind', async () => {
  const s = store();
  expect(await s.readDocument('cv')).toBeNull();
  expect(await s.readDocument('cover_letter')).toBeNull();
  expect(await s.currentDocument('cv')).toBeNull();
});

test('save into an empty slot stores the file under <root>/<kind>/', async () => {
  const s = store();
  await s.saveDocument('cv', 'a.pdf', Buffer.from('one'));
  await s.saveDocument('cover_letter', 'l.docx', Buffer.from('two'));
  expect(await storedNames('cv')).toEqual(['a.pdf']);
  expect(await storedNames('cover_letter')).toEqual(['l.docx']);
  expect(await s.readDocument('cv')).toEqual({ name: 'a.pdf', bytes: Buffer.from('one'), contentHash: sha(Buffer.from('one')) });
  expect(await s.currentDocument('cover_letter')).toEqual({ name: 'l.docx', contentHash: sha(Buffer.from('two')) });
});

test('save replaces the previous document: exactly one file per kind, with a different or the same name', async () => {
  const s = store();
  await s.saveDocument('cv', 'old.pdf', Buffer.from('old'));
  await s.saveDocument('cv', 'new.pdf', Buffer.from('new'));
  expect(await storedNames('cv')).toEqual(['new.pdf']);
  expect((await s.readDocument('cv'))?.bytes?.toString()).toBe('new');
  await s.saveDocument('cv', 'new.pdf', Buffer.from('newer'));
  expect(await storedNames('cv')).toEqual(['new.pdf']);
  expect(await s.readDocument('cv')).toMatchObject({ name: 'new.pdf', contentHash: sha(Buffer.from('newer')) });
  // The other kind is untouched.
  expect(await s.readDocument('cover_letter')).toBeNull();
  // No temp files are left behind.
  expect((await storedNames('cv')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
});

test('a failed write keeps the old document and leaves no temp file', async () => {
  await store().saveDocument('cv', 'old.pdf', Buffer.from('old'));
  const failing = store({
    writeFile: async () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    },
  });
  await expect(failing.saveDocument('cv', 'new.pdf', Buffer.from('new'))).rejects.toThrow(/disk full/);
  await expect(failing.saveDocument('cv', 'old.pdf', Buffer.from('new'))).rejects.toThrow(/disk full/);
  expect(await storedNames('cv')).toEqual(['old.pdf']);
  // Only the pointer and the old document's copy remain: no new copy, no temp file.
  const entries = await fs.readdir(path.join(root, 'cv'));
  expect(entries).toHaveLength(2);
  expect(entries).toContain('.current.json');
  expect((await store().readDocument('cv'))?.bytes?.toString()).toBe('old');
});

test('a file left over from an interrupted replace is never read and is cleaned up by the next save', async () => {
  const s = store();
  await s.saveDocument('cv', 'a.pdf', Buffer.from('a'));
  await fs.mkdir(path.join(root, 'cv', '0123456789abcdef'));
  await fs.writeFile(path.join(root, 'cv', '0123456789abcdef', 'stray.pdf'), 'stray');
  await fs.writeFile(path.join(root, 'cv', 'loose.pdf'), 'loose');
  expect((await s.readDocument('cv'))?.name).toBe('a.pdf');
  await s.saveDocument('cv', 'b.pdf', Buffer.from('b'));
  expect(await storedNames('cv')).toEqual(['b.pdf']);
});

test('overlapping saves of one kind still leave exactly one document', async () => {
  const s = store();
  await Promise.all(['a.pdf', 'b.pdf', 'c.pdf'].map((n) => s.saveDocument('cv', n, Buffer.from(n))));
  const names = await storedNames('cv');
  expect(names).toHaveLength(1);
  expect((await s.readDocument('cv'))?.name).toBe(names[0]);
});

test('a read during a replace waits for it and never sees a half-finished one', async () => {
  const s = store({
    writeFile: async (file, bytes) => {
      await new Promise((r) => setTimeout(r, 50));
      await fs.writeFile(file, bytes);
    },
  });
  await s.saveDocument('cv', 'old.pdf', Buffer.from('old'));
  const saving = s.saveDocument('cv', 'new.pdf', Buffer.from('new'));
  const [read, current] = await Promise.all([s.readDocument('cv'), s.currentDocument('cv'), saving]);
  expect(read?.name).toBe('new.pdf');
  expect(current?.name).toBe('new.pdf');
});

test('saveDocument rejects unsafe names and never writes outside the store', async () => {
  const s = store();
  for (const n of ['../x.pdf', 'a/b.pdf', 'a\\b.pdf', '..', '', '.hidden.pdf', '~$x.docx', 'x.exe', "it's.pdf"]) {
    await expect(s.saveDocument('cv', n, Buffer.from('x')), n).rejects.toThrow();
  }
  expect(await fs.readdir(root).catch(() => [])).not.toContain('x.pdf');
  expect(await s.readDocument('cv')).toBeNull();
});

test('readDocument does not load an oversize file but still hashes it', async () => {
  const big = Buffer.alloc(5 * 1024 * 1024 + 1, 1);
  const s = store();
  await s.saveDocument('cv', 'big.pdf', big);
  const file = await s.readDocument('cv');
  expect(file?.bytes).toBeNull();
  expect(file?.contentHash).toBe(sha(big));
});

test('a stored document whose file has gone is treated as no document', async () => {
  const s = store();
  await s.saveDocument('cv', 'a.pdf', Buffer.from('a'));
  for (const f of await storedFiles('cv')) await fs.rm(f);
  expect(await s.readDocument('cv')).toBeNull();
  expect(await s.currentDocument('cv')).toBeNull();
});

test('sanitiseDocumentName strips odd characters, keeps extension', () => {
  expect(sanitiseDocumentName('CV – Sep*2026.pdf')).toBe('CV  Sep2026.pdf');
  expect(sanitiseDocumentName("Prayush's CV.pdf")).toBe('Prayushs CV.pdf');
  expect(sanitiseDocumentName('x.exe')).toBeNull();
  expect(sanitiseDocumentName('.hidden.pdf')).toBeNull();
  expect(sanitiseDocumentName('~$x.docx')).toBeNull();
  expect(sanitiseDocumentName('../x.pdf')).toBeNull();
  expect(sanitiseDocumentName('a/b.pdf')).toBeNull();
  expect(sanitiseDocumentName('a\\b.pdf')).toBeNull();
  expect(sanitiseDocumentName('a..b.PDF')).toBe('a.b.PDF');
  expect(sanitiseDocumentName('***.pdf')).toBeNull();
});
