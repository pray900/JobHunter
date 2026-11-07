import { afterEach, expect, test, vi } from 'vitest';
import * as client from './client';
import { ApiError, downloadUrl, fetchDocuments, fetchJobDetail, fetchJobs, generate, saveCompanyNotes, setStatus, uploadDocument } from './client';
import { baseDetail } from '../job/detailFixtures';

afterEach(() => vi.unstubAllGlobals());

test('fetchJobs returns the jobs array', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ jobs: [{ id: 'x' }] }), { status: 200 })));
  expect(await fetchJobs()).toEqual([{ id: 'x' }]);
});

test('fetchJobs throws ApiError 502 on non-JSON 200 body', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>', { status: 200 })));
  await expect(fetchJobs()).rejects.toMatchObject({ name: 'ApiError', status: 502 });
});

test('fetchJobs throws ApiError 502 when jobs is missing', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })));
  await expect(fetchJobs()).rejects.toMatchObject({ name: 'ApiError', status: 502 });
});

test('fetchJobs wraps network failures in ApiError status 0', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await expect(fetchJobs()).rejects.toMatchObject({ name: 'ApiError', status: 0 });
});

test('fetchJobs throws ApiError on non-2xx', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 502 })));
  await expect(fetchJobs()).rejects.toMatchObject({ name: 'ApiError', status: 502 });
  await expect(fetchJobs()).rejects.toBeInstanceOf(ApiError);
});

test('every request sends the X-JobHunter: 1 header (CSRF guard on the n8n webhooks)', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ jobs: [] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  await fetchJobs();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(new Headers(init.headers).get('X-JobHunter')).toBe('1');
});

test('fetchDocuments returns the documents body and validates shape', async () => {
  const body = { cv: null, coverLetter: null };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
  expect(await fetchDocuments()).toEqual(body);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"cv":null}', { status: 200 })));
  await expect(fetchDocuments()).rejects.toMatchObject({ status: 502 });
});

test('uploadDocument posts multipart with the header and returns sourceRef', async () => {
  const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ sourceRef: 'cv.pdf' }), { status: 201 }));
  vi.stubGlobal('fetch', f);
  const out = await uploadDocument('cv', new File(['x'], 'cv.pdf'));
  expect(out).toEqual({ sourceRef: 'cv.pdf' });
  const [url, init] = f.mock.calls[0];
  expect(url).toBe('/api/documents/upload?kind=cv');
  expect(init.method).toBe('POST');
  expect(init.body).toBeInstanceOf(FormData);
  expect(init.headers['X-JobHunter']).toBe('1');
});

test('uploadDocument surfaces the status', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 400 })));
  await expect(uploadDocument('cv', new File(['x'], 'cv.pdf'))).rejects.toMatchObject({ status: 400 });
});

test('documents can only be uploaded: there is no delete', () => {
  expect(client).not.toHaveProperty('deleteDocument');
});

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('fetchJobDetail returns a valid detail', async () => {
  const f = vi.fn().mockResolvedValue(ok(baseDetail));
  vi.stubGlobal('fetch', f);
  expect(await fetchJobDetail('j 1')).toEqual(baseDetail);
  expect(f.mock.calls[0][0]).toBe('/api/jobs/detail?id=j%201');
});

test('fetchJobDetail accepts no run and no version', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ ...baseDetail, generation: null, version: null })));
  expect((await fetchJobDetail('j1')).version).toBeNull();
});

test('client rejects a malformed detail response', async () => {
  const bad = [
    {},
    { job: baseDetail.job, generation: null },
    { ...baseDetail, job: { ...baseDetail.job, status: 'weird' } },
    { ...baseDetail, generation: { status: 'running', stage: 'writing', round: 1, attempts: 1, error: null } },
    { ...baseDetail, version: { ...baseDetail.version, cv: null } },
    { ...baseDetail, version: { ...baseDetail.version, review: { passed: true } } },
    { ...baseDetail, version: { ...baseDetail.version, keywordCoverage: { covered: 'x', missing: [] } } },
    { ...baseDetail, version: { ...baseDetail.version, checks: [{ code: 'x' }] } },
  ];
  for (const b of bad) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok(b)));
    await expect(fetchJobDetail('j1')).rejects.toMatchObject({ name: 'ApiError', status: 502 });
  }
});

test('generate posts with the header and returns the run id', async () => {
  const f = vi.fn().mockResolvedValue(ok({ runId: 'r1' }, 202));
  vi.stubGlobal('fetch', f);
  expect(await generate('j1')).toEqual({ runId: 'r1' });
  const [url, init] = f.mock.calls[0];
  expect(url).toBe('/api/jobs/generate?id=j1');
  expect(init.method).toBe('POST');
  expect(init.headers['X-JobHunter']).toBe('1');
});

test('generate errors carry the status and the error code', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({ error: 'generation_in_progress' }, 409)));
  await expect(generate('j1')).rejects.toMatchObject({ status: 409, code: 'generation_in_progress' });
});

test('setStatus and saveCompanyNotes post JSON', async () => {
  const f = vi.fn().mockResolvedValueOnce(ok({ status: 'applied' })).mockResolvedValueOnce(ok({ notes: 'hi' }));
  vi.stubGlobal('fetch', f);
  expect(await setStatus('j1', 'applied')).toEqual({ status: 'applied' });
  expect(await saveCompanyNotes('j1', 'hi')).toEqual({ notes: 'hi' });
  expect(f.mock.calls[0][0]).toBe('/api/jobs/status?id=j1');
  expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ status: 'applied' });
  expect(f.mock.calls[0][1].headers['Content-Type']).toBe('application/json');
  expect(f.mock.calls[1][0]).toBe('/api/jobs/notes?id=j1');
  expect(JSON.parse(f.mock.calls[1][1].body)).toEqual({ notes: 'hi' });
});

test('setStatus rejects a malformed answer', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(ok({})));
  await expect(setStatus('j1', 'applied')).rejects.toMatchObject({ status: 502 });
});

test('downloadUrl builds a plain GET link', () => {
  expect(downloadUrl('a b', 'cover_letter', 'pdf')).toBe('/api/jobs/download?id=a%20b&doc=cover_letter&format=pdf');
});
