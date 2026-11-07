import { expect, test, vi } from 'vitest';
import { buildServer } from '../src/server.js';
import { CV, LETTER, makePdf } from './fixtures.js';

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
