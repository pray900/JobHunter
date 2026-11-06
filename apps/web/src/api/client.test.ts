import { afterEach, expect, test, vi } from 'vitest';
import { ApiError, fetchJobs } from './client';

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
