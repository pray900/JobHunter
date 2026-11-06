import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { listJobFiles } from '../src/storage/jobFolder.js';
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

test('missing folder returns empty list', async () => {
  expect(await listJobFiles(path.join(dir, 'nope'))).toEqual([]);
});
