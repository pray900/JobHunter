import { expect, test } from 'vitest';
import { buildServer } from '../src/server.js';

test('GET /health returns ok', async () => {
  const app = buildServer({ jobFolderDir: '/nonexistent' });
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});
