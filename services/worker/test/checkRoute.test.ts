import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { buildServer } from '../src/server.js';
import { CV, LETTER, makePdf } from './fixtures.js';

const configDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../config');
const body = {
  templateId: 'standard-ats',
  cv: CV,
  coverLetter: LETTER,
  keywordsCovered: [],
  job: { title: 'Platform Engineer', employer: 'Newco', advertiser: null, rawText: 'ad' },
  baseCv: { structured: { roles: [], skills: [], workRights: 'Australian citizen' } },
  baseCoverLetter: null,
  otherJobs: [],
};
const app = (fetchImpl?: unknown) =>
  buildServer({
    jobFolderDir: '/nonexistent',
    documentsDir: '/nonexistent',
    gotenbergUrl: 'http://gotenberg.test',
    configDir,
    fetch: fetchImpl as typeof fetch | undefined,
  });

test('check route returns pages', async () => {
  const a = app(async (url: unknown) =>
    String(url).startsWith('http://gotenberg.test') ? new Response(new Uint8Array(makePdf(2))) : new Response('', { status: 200 }),
  );
  const res = await a.inject({ method: 'POST', url: '/generation/check', payload: body });
  expect(res.statusCode).toBe(200);
  const json = res.json();
  expect(json.cvPages).toBe(2);
  expect(json.letterPages).toBe(2);
  expect(json.checks).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'cv_pages', severity: 'hard', doc: 'cv' })]));
  await a.close();
});

test('check route answers 400 invalid_document and 502 when gotenberg fails', async () => {
  const a = app(async () => new Response('boom', { status: 500 }));
  const bad = await a.inject({ method: 'POST', url: '/generation/check', payload: { ...body, cv: { ...CV, name: '' } } });
  expect(bad.statusCode).toBe(400);
  expect(bad.json()).toEqual({ error: 'invalid_document', path: 'cv.name' });
  const noJob = await a.inject({ method: 'POST', url: '/generation/check', payload: { ...body, job: undefined } });
  expect(noJob.json()).toEqual({ error: 'invalid_document', path: 'job' });
  const down = await a.inject({ method: 'POST', url: '/generation/check', payload: body });
  expect(down.statusCode).toBe(502);
  await a.close();
});

test('route validates both documents', async () => {
  const a = app();
  const ok = await a.inject({ method: 'POST', url: '/generation/changed-paths', payload: { before: { cv: CV, coverLetter: LETTER }, after: { cv: { ...CV, summary: 'x' }, coverLetter: LETTER } } });
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toEqual({ paths: ['cv.summary'] });
  const badBefore = await a.inject({ method: 'POST', url: '/generation/changed-paths', payload: { before: { cv: { ...CV, name: '' }, coverLetter: LETTER }, after: { cv: CV, coverLetter: LETTER } } });
  expect(badBefore.statusCode).toBe(400);
  expect(badBefore.json()).toEqual({ error: 'invalid_document', path: 'before.cv.name' });
  const badAfter = await a.inject({ method: 'POST', url: '/generation/changed-paths', payload: { before: { cv: CV, coverLetter: LETTER }, after: { cv: CV, coverLetter: { ...LETTER, paragraphs: 'no' } } } });
  expect(badAfter.statusCode).toBe(400);
  expect(badAfter.json().error).toBe('invalid_document');
  expect(badAfter.json().path).toMatch(/^after\.coverLetter/);
  const missing = await a.inject({ method: 'POST', url: '/generation/changed-paths', payload: {} });
  expect(missing.json()).toEqual({ error: 'invalid_document', path: 'before' });
  await a.close();
});
