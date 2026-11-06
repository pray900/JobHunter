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

test('missing folder returns 503 job_folder_missing, not an empty list', async () => {
  const app = buildServer({ jobFolderDir: path.join(dir, 'nope') });
  const res = await app.inject({ method: 'POST', url: '/jobs/scan' });
  expect(res.statusCode).toBe(503);
  expect(res.json()).toEqual({ error: 'job_folder_missing' });
  await app.close();
});

test('empty existing folder returns an empty job list', async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'scanempty-'));
  const app = buildServer({ jobFolderDir: empty });
  const res = await app.inject({ method: 'POST', url: '/jobs/scan' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ jobs: [] });
  await app.close();
  await fs.rm(empty, { recursive: true, force: true });
});

test('non-ENOENT per-file read error fails the scan with 500 and logs the file and code', async () => {
  const lines: Record<string, unknown>[] = [];
  const sink = { write: (chunk: string) => void lines.push(JSON.parse(chunk)) };
  const readFile = async () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  };
  const app = buildServer({
    jobFolderDir: dir,
    readFile,
    logger: { level: 'error', stream: sink } as never,
  });
  const res = await app.inject({ method: 'POST', url: '/jobs/scan' });
  expect(res.statusCode).toBe(500);
  expect(res.json()).toEqual({ error: 'job_scan_failed' });
  const logged = lines.find((l) => l.msg === 'job file read failed');
  expect(logged).toMatchObject({ file: 'job1.docx', code: 'EACCES', folder: dir });
  await app.close();
});
