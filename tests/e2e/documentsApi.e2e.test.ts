import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
  N8N_URL,
  ROOT,
  SYNC_HEADERS,
  WEB_URL,
  db,
  listDocuments,
  makePdf,
  putDocument,
  resetState,
  storedDocuments,
  triggerScoring,
  uploadDocument,
} from './lib';

const OWNER = '00000000-0000-0000-0000-000000000001';
const EVIL = 'https://evil.example';
const summaryKeys = ['analysisError', 'analysisStatus', 'id', 'kind', 'sourceRef', 'updatedAt', 'warnings'];
const bigPdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x20)]);

async function addScoredJob(): Promise<void> {
  await db.query(
    `insert into jobs (owner_id, source, source_ref, content_hash, raw_text, title, extraction_status)
     values ($1, 'folder', 'j.docx', 'h', 'text', 'Job', 'done')`,
    [OWNER],
  );
  expect((await triggerScoring()).scored).toBe(1);
}
const jobScore = async () =>
  (await db.query(`select score_status, match_score, match_basis_hash from jobs`))[0];
const activeCvHash = async () =>
  (await db.query(`select content_hash from base_documents where kind='cv' and active`))[0].content_hash;

describe('documents API', () => {
  beforeEach(async () => {
    await resetState();
  });
  afterAll(async () => {
    await resetState();
  });

  test('lists the current CV and the current cover letter, nothing else', async () => {
    await putDocument('cv', 'old.pdf', makePdf('CV old'));
    await putDocument('cv', 'new.pdf', makePdf('CV new'));
    await putDocument('cover_letter', 'cl.pdf', makePdf('Letter'));
    const body = await listDocuments();
    expect(Object.keys(body).sort()).toEqual(['coverLetter', 'cv']);
    expect(Object.keys(body.cv).sort()).toEqual(summaryKeys);
    expect(body.cv).toMatchObject({ kind: 'cv', sourceRef: 'new.pdf', analysisStatus: 'done', analysisError: null });
    expect(new Date(body.cv.updatedAt).toISOString()).toBe(body.cv.updatedAt);
    expect(body.coverLetter).toMatchObject({ kind: 'cover_letter', sourceRef: 'cl.pdf', analysisStatus: 'done' });
  });

  test('empty list has nulls', async () => {
    expect(await listDocuments()).toEqual({ cv: null, coverLetter: null });
  });

  test('uploads without X-JobHunter are refused and store nothing', async () => {
    for (const headers of [{}, { 'X-JobHunter': '0' }]) {
      const up = await uploadDocument('cv', 'b.pdf', makePdf('CV B'), headers);
      expect(up.status).toBe(403);
      expect(await up.json()).toEqual({ error: 'missing_jobhunter_header' });
    }
    expect(storedDocuments('cv')).toEqual([]);
    expect(await db.query(`select id from base_documents`)).toEqual([]);
  });

  test('upload into an empty slot: 201, stored and analysed', async () => {
    const res = await uploadDocument('cover_letter', 'letter.pdf', makePdf('Letter'));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ sourceRef: 'letter.pdf' });
    expect(storedDocuments('cover_letter')).toEqual(['letter.pdf']);
    // The upload already ran the sync, so the document is listed and analysed.
    expect((await listDocuments()).coverLetter).toMatchObject({ sourceRef: 'letter.pdf', analysisStatus: 'done' });
  });

  test('replace with a different name: the old file is gone, the new one is current', async () => {
    await putDocument('cv', 'old.pdf', makePdf('CV old'));
    const res = await uploadDocument('cv', 'fresh.pdf', makePdf('CV fresh'));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ sourceRef: 'fresh.pdf' });
    expect(storedDocuments('cv')).toEqual(['fresh.pdf']);
    expect((await listDocuments()).cv).toMatchObject({ sourceRef: 'fresh.pdf', analysisStatus: 'done' });
    expect(await db.query(`select source_ref, source_removed, active from base_documents order by source_ref`)).toEqual([
      { source_ref: 'fresh.pdf', source_removed: false, active: true },
      { source_ref: 'old.pdf', source_removed: true, active: false },
    ]);
  });

  test('replace with the same name simply replaces (no 409)', async () => {
    await putDocument('cv', 'a.pdf', makePdf('CV A'));
    const before = await activeCvHash();
    const res = await uploadDocument('cv', 'a.pdf', makePdf('CV A v2'));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ sourceRef: 'a.pdf' });
    expect(storedDocuments('cv')).toEqual(['a.pdf']);
    expect(await activeCvHash()).not.toBe(before);
    expect((await listDocuments()).cv).toMatchObject({ sourceRef: 'a.pdf', analysisStatus: 'done' });
  });

  test('replacing the CV with new content rescores the jobs', async () => {
    await putDocument('cv', 'a.pdf', makePdf('Base CV STUB_HEADLINE:v1'));
    await addScoredJob();
    const before = await jobScore();
    await putDocument('cv', 'b.pdf', makePdf('Base CV STUB_HEADLINE:v2'));
    const basis = await activeCvHash();
    expect(basis).not.toBe(before.match_basis_hash);
    expect(await triggerScoring()).toEqual({ ok: true, scored: 1, basisHash: basis });
    expect(await jobScore()).toMatchObject({ score_status: 'done', match_basis_hash: basis });
  });

  test('uploading the same CV content again does not rescore', async () => {
    const bytes = makePdf('Base CV STUB_HEADLINE:v1');
    await putDocument('cv', 'a.pdf', bytes);
    await addScoredJob();
    const before = await jobScore();
    await putDocument('cv', 'a.pdf', bytes);
    expect((await triggerScoring()).scored).toBe(0);
    expect(await jobScore()).toEqual(before);
  });

  test('replacing the cover letter leaves job scores alone', async () => {
    await putDocument('cv', 'a.pdf', makePdf('CV A'));
    await putDocument('cover_letter', 'cl.pdf', makePdf('Letter'));
    await addScoredJob();
    const before = await jobScore();
    await putDocument('cover_letter', 'cl2.pdf', makePdf('Letter 2'));
    expect((await triggerScoring()).scored).toBe(0);
    expect(await jobScore()).toEqual(before);
  });

  test('bad uploads are 400 and store nothing', async () => {
    expect((await uploadDocument('cv', 'x.pdf', Buffer.from('not a pdf'))).status).toBe(400);
    expect((await uploadDocument('cv', 'x.exe', makePdf('x'))).status).toBe(400);
    expect((await uploadDocument('resume', 'x.pdf', makePdf('x'))).status).toBe(400);
    const res = await fetch(`${WEB_URL}/api/documents/upload?kind=cv`, { method: 'POST', headers: SYNC_HEADERS, body: new FormData() });
    expect(res.status).toBe(400);
    await res.arrayBuffer();
    expect(storedDocuments('cv')).toEqual([]);
  });

  test('a failed upload keeps the current CV', async () => {
    await putDocument('cv', 'a.pdf', makePdf('CV A'));
    for (const [name, bytes] of [['x.pdf', Buffer.from('not a pdf')], ['big.pdf', bigPdf()]] as const) {
      const res = await uploadDocument('cv', name, bytes);
      expect([400, 413]).toContain(res.status);
      await res.arrayBuffer();
    }
    expect(storedDocuments('cv')).toEqual(['a.pdf']);
    expect((await listDocuments()).cv).toMatchObject({ sourceRef: 'a.pdf', analysisStatus: 'done' });
  });

  test('hostile file name is stored inside the storage or rejected', async () => {
    const res = await uploadDocument('cv', '../x.pdf', makePdf('CV x'));
    const body: any = await res.json();
    if (res.status === 201) {
      expect(body.sourceRef).not.toMatch(/[\\/]|\.\./);
      expect(storedDocuments('cv')).toEqual([body.sourceRef]);
    } else {
      expect(res.status).toBe(400);
      expect(storedDocuments('cv')).toEqual([]);
    }
  });

  test('there is no delete endpoint', async () => {
    await putDocument('cv', 'a.pdf', makePdf('CV A'));
    const [row] = await db.query(`select id from base_documents`);
    for (const base of [`${WEB_URL}/api`, `${N8N_URL}/webhook/api`]) {
      const res = await fetch(`${base}/documents?id=${row.id}`, { method: 'DELETE', headers: SYNC_HEADERS });
      expect([404, 405]).toContain(res.status);
      await res.arrayBuffer();
    }
    expect(storedDocuments('cv')).toEqual(['a.pdf']);
    expect((await listDocuments()).cv).toMatchObject({ id: row.id, sourceRef: 'a.pdf' });
  });

  test('foreign Origin gets no CORS allow header on the documents endpoints', async () => {
    for (const base of [`${WEB_URL}/api`, `${N8N_URL}/webhook/api`]) {
      for (const [method, path] of [
        ['GET', 'documents'],
        ['POST', 'documents/upload?kind=cv'],
      ]) {
        const res = await fetch(`${base}/${path}`, { method, headers: { Origin: EVIL } });
        expect(res.headers.get('access-control-allow-origin')).not.toBe(EVIL);
        expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
        await res.arrayBuffer();
      }
    }
  });

  // Checks on the workflow JSON itself.
  describe('workflow definition', () => {
    const wf = JSON.parse(readFileSync(join(ROOT, 'n8n', 'workflows', 'documents-api.json'), 'utf8'));
    test('worst-case upload time stays under nginx 30 s', () => {
      const timeouts = wf.nodes
        .filter((n: any) => n.type === 'n8n-nodes-base.httpRequest')
        .map((n: any) => n.parameters.options.timeout as number);
      expect(timeouts.every((t: number) => typeof t === 'number')).toBe(true);
      expect(timeouts.reduce((a: number, b: number) => a + b, 0)).toBeLessThan(30_000);
    });
  });
});
