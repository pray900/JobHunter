import { describe, expect, test } from 'vitest';
import { N8N_URL, WEB_URL } from './lib';

// Other websites must not be able to read the job list or trigger a (paid) sync from
// the user's browser. Only the web app's own origins are allowed.
const EVIL = 'https://evil.example';
const APP = 'http://localhost:8080';

const bases = [
  ['via web (nginx)', `${WEB_URL}/api`],
  ['n8n directly', `${N8N_URL}/webhook/api`],
] as const;

describe.each(bases)('CORS %s', (_, base) => {
  test('GET /jobs does not allow a foreign origin', async () => {
    const res = await fetch(`${base}/jobs`, { headers: { Origin: EVIL } });
    expect(res.headers.get('access-control-allow-origin')).not.toBe(EVIL);
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    await res.arrayBuffer();
  });

  test('sync preflight is not allowed for a foreign origin', async () => {
    const res = await fetch(`${base}/jobs/sync`, {
      method: 'OPTIONS',
      headers: { Origin: EVIL, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    expect(res.headers.get('access-control-allow-origin')).not.toBe(EVIL);
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    await res.arrayBuffer();
  });
});

test('n8n allows the web app origin', async () => {
  const res = await fetch(`${N8N_URL}/webhook/api/jobs`, { headers: { Origin: APP } });
  expect(res.status).toBe(200);
  expect(res.headers.get('access-control-allow-origin')).toBe(APP);
  await res.arrayBuffer();
});
