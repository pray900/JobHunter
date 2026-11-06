import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { scanJobFolder } from '../src/jobs/scan.js';
import type { ScannedJob } from '../src/jobs/types.js';
import { makeDocx } from '../../../tests/helpers/makeDocx.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scanroute-'));
  await fs.writeFile(path.join(dir, 'job1.docx'), await makeDocx([{ text: 'https://x.io/1' }, { text: 'Body' }]));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test('POST /jobs/scan returns ScannedJob records', async () => {
  const app = buildServer({ jobFolderDir: dir });
  const res = await app.inject({ method: 'POST', url: '/jobs/scan' });
  expect(res.statusCode).toBe(200);
  const job = res.json().jobs.find((j: ScannedJob) => j.sourceRef === 'job1.docx');
  expect(job).toMatchObject({ source: 'folder', url: 'https://x.io/1', body: 'Body', warnings: [] });
  expect(job.contentHash).toMatch(/^[0-9a-f]{64}$/);
  await app.close();
});

test('contentHash is the sha256 of the file bytes', async () => {
  const bytes = await fs.readFile(path.join(dir, 'job1.docx'));
  const [job] = await scanJobFolder(dir);
  expect(job.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'));
});

test('changed content changes the hash', async () => {
  const [before] = await scanJobFolder(dir);
  await fs.writeFile(path.join(dir, 'job1.docx'), await makeDocx([{ text: 'https://x.io/1' }, { text: 'Edited body' }]));
  const [after] = await scanJobFolder(dir);
  expect(after.body).toBe('Edited body');
  expect(after.contentHash).not.toBe(before.contentHash);
});

test('missing folder scans to an empty list', async () => {
  const app = buildServer({ jobFolderDir: path.join(dir, 'nope') });
  const res = await app.inject({ method: 'POST', url: '/jobs/scan' });
  expect(res.json()).toEqual({ jobs: [] });
  await app.close();
});
