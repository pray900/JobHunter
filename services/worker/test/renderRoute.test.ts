import { expect, test, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import JSZip from 'jszip';
import { CV, LETTER, makePdf } from './fixtures.js';
import { LAYOUT_STEPS } from '../src/templates/layout.js';

const app = (fetchImpl?: unknown) =>
  buildServer({
    jobFolderDir: '/nonexistent',
    documentsDir: '/nonexistent',
    gotenbergUrl: 'http://gotenberg.test',
    fetch: fetchImpl as typeof fetch | undefined,
  });
const render = (a: ReturnType<typeof app>, payload: object) =>
  a.inject({ method: 'POST', url: '/generation/render', payload });
const base = { templateId: 'standard-ats', doc: 'cv', format: 'docx', cv: CV, coverLetter: LETTER };

test('render route returns docx bytes starting with PK', async () => {
  const a = app();
  const res = await render(a, base);
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  expect(res.rawPayload.subarray(0, 2).toString()).toBe('PK');
  const letter = await render(a, { ...base, doc: 'cover_letter' });
  expect(letter.statusCode).toBe(200);
  await a.close();
});

test('render route answers 400 invalid_document with the path', async () => {
  const a = app();
  const res = await render(a, { ...base, cv: { ...CV, name: '' } });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: 'invalid_document', path: 'cv.name' });
  const noLetter = await render(a, { ...base, doc: 'cover_letter', coverLetter: undefined });
  expect(noLetter.json()).toEqual({ error: 'invalid_document', path: 'coverLetter' });
  await a.close();
});

test('pdf route returns %PDF through gotenberg and 502 when gotenberg fails', async () => {
  const ok = vi.fn(async (_url: unknown, _init?: unknown) => new Response(new Uint8Array(makePdf(1))));
  const a = app(ok);
  const res = await render(a, { ...base, format: 'pdf' });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe('application/pdf');
  expect(res.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  expect(String(ok.mock.calls[0][0])).toBe('http://gotenberg.test/forms/libreoffice/convert');
  await a.close();

  const bad = app(async () => new Response('boom', { status: 500 }));
  const failed = await render(bad, { ...base, format: 'pdf' });
  expect(failed.statusCode).toBe(502);
  expect(failed.json()).toEqual({ error: 'pdf_render_failed' });
  await bad.close();

  const down = app(async () => {
    throw new Error('ECONNREFUSED');
  });
  expect((await render(down, { ...base, format: 'pdf' })).statusCode).toBe(502);
  await down.close();
});

// A fake Gotenberg: one page when the DOCX body size is at most maxHalfPt, otherwise two.
const gotenbergBySize = (maxHalfPt: number) => async (_url: unknown, init?: { body?: FormData }) => {
  const file = init?.body?.get('files') as Blob;
  const xml = await (await JSZip.loadAsync(Buffer.from(await file.arrayBuffer()))).file('word/document.xml')!.async('string');
  const m = [...xml.matchAll(/<w:sz w:val="(\d+)"\/>/g)].map((x) => Number(x[1]));
  const body = Math.min(...m);
  return new Response(new Uint8Array(makePdf(body <= maxHalfPt ? 1 : 2)));
};
const sizeOf = async (docx: Buffer) => {
  const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
  return Math.min(...[...xml.matchAll(/<w:sz w:val="(\d+)"\/>/g)].map((x) => Number(x[1])));
};

test('render route fits the CV: renders at the first layout that fits, never drops projects', async () => {
  const cv = { ...CV, projects: [CV.projects[0], { name: 'Second', bullets: ['More.'] }] };
  const a = app(gotenbergBySize(Math.round(LAYOUT_STEPS[4].bodyPt * 2)));
  const res = await render(a, { ...base, cv });
  expect(res.statusCode).toBe(200);
  expect(await sizeOf(res.rawPayload)).toBe(20);
  await a.close();

  const floor = app(gotenbergBySize(0));
  const over = await render(floor, { ...base, cv });
  expect(await sizeOf(over.rawPayload)).toBe(Math.round(LAYOUT_STEPS[LAYOUT_STEPS.length - 1].bodyPt * 2));
  const xml = await (await JSZip.loadAsync(over.rawPayload)).file('word/document.xml')!.async('string');
  expect(xml).toContain('Second');
  await floor.close();
});

test('a docx request falls back to the default layout when Gotenberg is down', async () => {
  const a = app(async () => {
    throw new Error('ECONNREFUSED');
  });
  const res = await render(a, base);
  expect(res.statusCode).toBe(200);
  expect(await sizeOf(res.rawPayload)).toBe(21);
  await a.close();
});
