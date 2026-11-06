import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { JobFileReadError, JobFolderMissingError, listJobFiles } from '../src/storage/jobFolder.js';
import { makeDocx } from '../../../tests/helpers/makeDocx.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobfolder-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test('ignores lock files and non-docx', async () => {
  const valid = await makeDocx([{ text: 'https://x.io/1' }, { text: 'Body' }]);
  await fs.writeFile(path.join(dir, 'job1.docx'), valid);
  await fs.writeFile(path.join(dir, '~$job1.docx'), valid);
  await fs.writeFile(path.join(dir, 'notes.txt'), 'hello');
  await fs.writeFile(path.join(dir, '.hidden.docx'), valid);
  await fs.writeFile(path.join(dir, 'JOB2.DOCX'), valid);
  expect((await listJobFiles(dir)).map((f) => f.name)).toEqual(['JOB2.DOCX', 'job1.docx']);
});

test('returns file bytes alongside names', async () => {
  const valid = await makeDocx([{ text: 'https://x.io/1' }]);
  await fs.writeFile(path.join(dir, 'job1.docx'), valid);
  const [file] = await listJobFiles(dir);
  expect(file.name).toBe('job1.docx');
  expect(Buffer.compare(file.bytes, valid)).toBe(0);
});

test('does not recurse into subfolders', async () => {
  const valid = await makeDocx([{ text: 'https://x.io/1' }]);
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'sub', 'nested.docx'), valid);
  await fs.writeFile(path.join(dir, 'top.docx'), valid);
  expect((await listJobFiles(dir)).map((f) => f.name)).toEqual(['top.docx']);
});

test('missing folder rejects with JobFolderMissingError', async () => {
  await expect(listJobFiles(path.join(dir, 'nope'))).rejects.toBeInstanceOf(JobFolderMissingError);
});

test('empty existing folder returns empty list', async () => {
  expect(await listJobFiles(dir)).toEqual([]);
});

const errno = (code: string) => Object.assign(new Error(code), { code });

test('file deleted between listing and reading is skipped', async () => {
  const valid = await makeDocx([{ text: 'https://x.io/1' }]);
  await fs.writeFile(path.join(dir, 'a.docx'), valid);
  await fs.writeFile(path.join(dir, 'b.docx'), valid);
  await fs.writeFile(path.join(dir, 'c.docx'), valid);
  const readFile = async (p: string) => {
    if (p.endsWith('b.docx')) throw errno('ENOENT');
    return fs.readFile(p);
  };
  expect((await listJobFiles(dir, { readFile })).map((f) => f.name)).toEqual(['a.docx', 'c.docx']);
});

test('other per-file read errors fail the whole listing', async () => {
  await fs.writeFile(path.join(dir, 'a.docx'), await makeDocx([{ text: 'https://x.io/1' }]));
  const readFile = async () => {
    throw errno('EACCES');
  };
  const err = await listJobFiles(dir, { readFile }).catch((e) => e);
  expect(err).toBeInstanceOf(JobFileReadError);
  expect(err).toMatchObject({ fileName: 'a.docx', code: 'EACCES' });
});
