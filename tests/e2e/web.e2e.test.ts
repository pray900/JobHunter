import { expect, test } from 'vitest';
import { request } from 'node:http';
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

/** A raw GET with a chosen Host header (fetch does not let a test set Host). */
function getWithHost(host: string): Promise<{ status: number } | { closed: true }> {
  const { port, hostname } = new URL(WEB_URL);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, path: '/api/jobs', headers: { Host: host } }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on('error', (err: NodeJS.ErrnoException) => (err.code === 'ECONNRESET' || /socket hang up/.test(err.message) ? resolve({ closed: true }) : reject(err)));
    req.end();
  });
}

test('M9: web answers only for localhost and 127.0.0.1 (no DNS rebinding)', async () => {
  const port = new URL(WEB_URL).port;
  expect(await getWithHost(`localhost:${port}`)).toEqual({ status: 200 });
  expect(await getWithHost(`127.0.0.1:${port}`)).toEqual({ status: 200 });
  expect(await getWithHost(`rebind.attacker.example:${port}`)).toEqual({ closed: true });
  expect(await getWithHost('rebind.attacker.example')).toEqual({ closed: true });
});
