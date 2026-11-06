import { expect, test } from 'vitest';
import { WEB_URL, api } from './lib';

test('web proxies /api/jobs to n8n', async () => {
  const res = await api.get('/api/jobs');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { jobs: unknown[] };
  expect(Array.isArray(body.jobs)).toBe(true);

  const page = await fetch(`${WEB_URL}/`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('<div id="root">');
});

test('web serves the app on /documents (SPA fallback)', async () => {
  const page = await fetch(`${WEB_URL}/documents`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('<div id="root">');
});
