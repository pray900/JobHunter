import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { N8N_URL, SYNC_HEADERS, WEB_URL, db, resetState, stub, writeJobFile } from './lib';

// CORS stops other sites reading responses, but a "simple" cross-site POST (for example
// Content-Type: text/plain) is sent without a preflight. The sync webhook therefore also
// requires the custom header X-JobHunter: 1, which a browser only sends cross-site after a
// preflight that n8n refuses for foreign origins.
const EVIL = 'https://evil.example';
const APP = 'http://localhost:8080';
const SYNC = `${N8N_URL}/webhook/api/jobs/sync`;

describe('sync webhook requires the X-JobHunter header', () => {
  beforeEach(async () => {
    await resetState();
    // A run that got past the check would insert this job and call Claude.
    await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'Job A' }]);
  });
  afterAll(async () => {
    await resetState();
  });

  const expectRefusedAndNothingRan = async (res: Response) => {
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'missing_jobhunter_header' });
    expect(await db.query('select id from jobs')).toEqual([]);
    expect(await stub.requests()).toEqual([]);
  };

  test('POST without the header: 403 and nothing runs', async () => {
    await expectRefusedAndNothingRan(await fetch(SYNC, { method: 'POST' }));
  });

  test('cross-site text/plain POST from a foreign origin (no preflight): 403', async () => {
    const res = await fetch(SYNC, { method: 'POST', headers: { Origin: EVIL, 'Content-Type': 'text/plain' }, body: 'x' });
    await expectRefusedAndNothingRan(res);
  });

  test('header with a value other than 1: 403', async () => {
    await expectRefusedAndNothingRan(await fetch(SYNC, { method: 'POST', headers: { 'X-JobHunter': '0' } }));
  });

  test('preflight from the web app origin allows the X-JobHunter header', async () => {
    const res = await fetch(SYNC, {
      method: 'OPTIONS',
      headers: { Origin: APP, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-jobhunter' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
    expect((res.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain('x-jobhunter');
    await res.arrayBuffer();
  });

  test('POST with the header from the web app origin: 200 and the sync runs', async () => {
    const res = await fetch(SYNC, { method: 'POST', headers: { Origin: APP, ...SYNC_HEADERS } });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
    expect(await res.json()).toEqual({ ok: true, scanned: 1, extracted: 1 });
    expect(await stub.requests()).toHaveLength(1);
  });

  test('through nginx: the header is passed on to n8n', async () => {
    const without = await fetch(`${WEB_URL}/api/jobs/sync`, { method: 'POST' });
    expect(without.status).toBe(403);
    await without.arrayBuffer();
    const res = await fetch(`${WEB_URL}/api/jobs/sync`, { method: 'POST', headers: SYNC_HEADERS });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, scanned: 1, extracted: 1 });
  });
});
