import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, deleteDocument, fetchDocuments, fetchJobs, uploadDocument } from './client';

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
  const body = { cv: null, coverLetter: null, ignored: [] };
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

test('uploadDocument and deleteDocument surface the status', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 409 })));
  await expect(uploadDocument('cv', new File(['x'], 'cv.pdf'))).rejects.toMatchObject({ status: 409 });
  const f = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', f);
  await deleteDocument('a b');
  expect(f.mock.calls[0][0]).toBe('/api/documents?id=a%20b');
  expect(f.mock.calls[0][1].method).toBe('DELETE');
});
