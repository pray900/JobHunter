import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
  COVER_LETTER_DIR,
  CV_DIR,
  N8N_URL,
  WEB_URL,
  db,
  deleteDocument,
  listDocuments,
  makePdf,
  resetState,
  triggerDocumentsSync,
  triggerScoring,
  uploadDocument,
  writeDocument,
} from './lib';

const OWNER = '00000000-0000-0000-0000-000000000001';
const EVIL = 'https://evil.example';
const OLD = new Date('2026-01-01T00:00:00Z');
const NEW = new Date('2026-02-01T00:00:00Z');
const summaryKeys = ['analysisError', 'analysisStatus', 'id', 'kind', 'sourceRef', 'updatedAt', 'warnings'];

describe('documents API', () => {
  beforeEach(async () => {
    await resetState();
  });
  afterAll(async () => {
    await resetState();
  });

  test('lists the active CV, the active cover letter and ignored files', async () => {
    writeDocument('cv', 'old.pdf', makePdf('CV old'), OLD);
    writeDocument('cv', 'new.pdf', makePdf('CV new'), NEW);
    writeDocument('cover_letter', 'cl.pdf', makePdf('Letter'));
    await triggerDocumentsSync();
    const body = await listDocuments();
    expect(Object.keys(body).sort()).toEqual(['coverLetter', 'cv', 'ignored']);
    expect(Object.keys(body.cv).sort()).toEqual(summaryKeys);
    expect(body.cv).toMatchObject({ kind: 'cv', sourceRef: 'new.pdf', analysisStatus: 'done', analysisError: null });
    expect(new Date(body.cv.updatedAt).toISOString()).toBe(body.cv.updatedAt);
    expect(body.coverLetter).toMatchObject({ kind: 'cover_letter', sourceRef: 'cl.pdf' });
    expect(body.ignored).toHaveLength(1);
    expect(body.ignored[0]).toMatchObject({ kind: 'cv', sourceRef: 'old.pdf' });
    expect(body.ignored[0].warnings.map((w: any) => w.code)).toContain('extra_file_ignored');
  });

  test('empty list has nulls and no ignored files', async () => {
    expect(await listDocuments()).toEqual({ cv: null, coverLetter: null, ignored: [] });
  });

  test('requests without X-JobHunter are refused', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A'));
    await triggerDocumentsSync();
    const [row] = await db.query(`select id from base_documents`);
    const up = await uploadDocument('cv', 'b.pdf', makePdf('CV B'), {});
    expect(up.status).toBe(403);
    expect(await up.json()).toEqual({ error: 'missing_jobhunter_header' });
    const del = await deleteDocument(row.id, {});
    expect(del.status).toBe(403);
    await del.arrayBuffer();
    expect(readdirSync(CV_DIR)).toEqual(['a.pdf']);
  });

  test('upload same name as an existing file is 409 and nothing is deleted', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A'));
    await triggerDocumentsSync();
    const res = await uploadDocument('cv', 'a.pdf', makePdf('CV A v2'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'document_exists' });
    expect(readdirSync(CV_DIR)).toEqual(['a.pdf']);
  });

  test('upload replaces the current CV', async () => {
    writeDocument('cv', 'old.pdf', makePdf('CV old'));
    await triggerDocumentsSync();
    const res = await uploadDocument('cv', 'fresh.pdf', makePdf('CV fresh'));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ sourceRef: 'fresh.pdf' });
    expect(readdirSync(CV_DIR)).toEqual(['fresh.pdf']);
    await triggerDocumentsSync();
    const body = await listDocuments();
    expect(body.cv).toMatchObject({ sourceRef: 'fresh.pdf', analysisStatus: 'done' });
    expect(body.ignored).toEqual([]);
    const rows = await db.query(`select source_ref, source_removed, active from base_documents order by source_ref`);
    expect(rows).toEqual([
      { source_ref: 'fresh.pdf', source_removed: false, active: true },
      { source_ref: 'old.pdf', source_removed: true, active: false },
    ]);
  });

  test('upload with no current document just adds the file', async () => {
    const res = await uploadDocument('cover_letter', 'letter.pdf', makePdf('Letter'));
    expect(res.status).toBe(201);
    expect(readdirSync(COVER_LETTER_DIR)).toEqual(['letter.pdf']);
    // The upload already triggered a sync, so the document is listed and analysed.
    expect((await listDocuments()).coverLetter).toMatchObject({ sourceRef: 'letter.pdf', analysisStatus: 'done' });
  });

  test('bad uploads are 400 and write nothing', async () => {
    expect((await uploadDocument('cv', 'x.pdf', Buffer.from('not a pdf'))).status).toBe(400);
    expect((await uploadDocument('cv', 'x.exe', makePdf('x'))).status).toBe(400);
    expect((await uploadDocument('resume', 'x.pdf', makePdf('x'))).status).toBe(400);
    const res = await fetch(`${WEB_URL}/api/documents/upload?kind=cv`, {
      method: 'POST',
      headers: { 'X-JobHunter': '1' },
      body: new FormData(),
    });
    expect(res.status).toBe(400);
    await res.arrayBuffer();
    expect(readdirSync(CV_DIR)).toEqual([]);
  });

  test('upload over 5 MB is refused and the current CV is kept', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A'));
    await triggerDocumentsSync();
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x20)]);
    const res = await uploadDocument('cv', 'big.pdf', big);
    expect([400, 413]).toContain(res.status);
    await res.arrayBuffer();
    expect(readdirSync(CV_DIR)).toEqual(['a.pdf']);
  });

  test('delete removes the file, marks the row removed and resets scoring', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A'));
    await triggerDocumentsSync();
    await db.query(
      `insert into jobs (owner_id, source, source_ref, content_hash, raw_text, title, extraction_status)
       values ($1, 'folder', 'j.docx', 'h', 'text', 'Job', 'done')`,
      [OWNER],
    );
    await triggerScoring();
    expect((await db.query(`select score_status from jobs`))[0].score_status).toBe('done');
    const [row] = await db.query(`select id from base_documents`);
    const res = await deleteDocument(row.id);
    expect(res.status).toBe(204);
    await res.arrayBuffer();
    expect(existsSync(join(CV_DIR, 'a.pdf'))).toBe(false);
    expect((await db.query(`select source_removed, active from base_documents`))[0]).toEqual({
      source_removed: true,
      active: false,
    });
    expect((await db.query(`select score_status, match_score, match_basis_hash from jobs`))[0]).toEqual({
      score_status: 'pending',
      match_score: null,
      match_basis_hash: null,
    });
    expect(await listDocuments()).toEqual({ cv: null, coverLetter: null, ignored: [] });
  });

  test('failed write keeps a different current CV', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A'));
    await triggerDocumentsSync();
    const res = await uploadDocument('cv', 'x.pdf', Buffer.from('not a pdf'));
    expect(res.status).toBe(400);
    await res.arrayBuffer();
    expect(readdirSync(CV_DIR)).toEqual(['a.pdf']);
    expect((await listDocuments()).cv.sourceRef).toBe('a.pdf');
  });

  test('409 on an ignored file name keeps the active CV', async () => {
    writeDocument('cv', 'old.pdf', makePdf('CV old'), OLD);
    writeDocument('cv', 'new.pdf', makePdf('CV new'), NEW);
    await triggerDocumentsSync();
    const res = await uploadDocument('cv', 'old.pdf', makePdf('CV again'));
    expect(res.status).toBe(409);
    await res.arrayBuffer();
    expect(readdirSync(CV_DIR).sort()).toEqual(['new.pdf', 'old.pdf']);
    expect((await listDocuments()).cv.sourceRef).toBe('new.pdf');
  });

  test('hostile file name is stored inside the folder or rejected', async () => {
    const res = await uploadDocument('cv', '../x.pdf', makePdf('CV x'));
    const body: any = await res.json();
    if (res.status === 201) {
      expect(body.sourceRef).not.toMatch(/[\\/]|\.\./);
      expect(readdirSync(CV_DIR)).toEqual([body.sourceRef]);
    } else {
      expect(res.status).toBe(400);
      expect(readdirSync(CV_DIR)).toEqual([]);
    }
    expect(existsSync(join(CV_DIR, '..', 'x.pdf'))).toBe(false);
  });

  test('deleting an ignored file or the cover letter leaves job scores alone', async () => {
    writeDocument('cv', 'old.pdf', makePdf('CV old'), OLD);
    writeDocument('cv', 'new.pdf', makePdf('CV new'), NEW);
    writeDocument('cover_letter', 'cl.pdf', makePdf('Letter'));
    await triggerDocumentsSync();
    await db.query(
      `insert into jobs (owner_id, source, source_ref, content_hash, raw_text, title, extraction_status)
       values ($1, 'folder', 'j.docx', 'h', 'text', 'Job', 'done')`,
      [OWNER],
    );
    await triggerScoring();
    const before = (await db.query(`select score_status, match_score, match_basis_hash from jobs`))[0];
    expect(before.score_status).toBe('done');
    for (const ref of ['old.pdf', 'cl.pdf']) {
      const [row] = await db.query(`select id from base_documents where source_ref=$1`, [ref]);
      const res = await deleteDocument(row.id);
      expect(res.status).toBe(204);
      await res.arrayBuffer();
    }
    expect((await db.query(`select score_status, match_score, match_basis_hash from jobs`))[0]).toEqual(before);
  });

  test('deleting an already removed document is 404', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A'));
    await triggerDocumentsSync();
    const [row] = await db.query(`select id from base_documents`);
    expect((await deleteDocument(row.id)).status).toBe(204);
    const again = await deleteDocument(row.id);
    expect(again.status).toBe(404);
    await again.arrayBuffer();
  });

  test('delete can remove an ignored file', async () => {
    writeDocument('cv', 'old.pdf', makePdf('CV old'), OLD);
    writeDocument('cv', 'new.pdf', makePdf('CV new'), NEW);
    await triggerDocumentsSync();
    const [row] = await db.query(`select id from base_documents where source_ref='old.pdf'`);
    expect((await deleteDocument(row.id)).status).toBe(204);
    expect(readdirSync(CV_DIR)).toEqual(['new.pdf']);
    const body = await listDocuments();
    expect(body.cv.sourceRef).toBe('new.pdf');
    expect(body.ignored).toEqual([]);
  });

  test('delete of an unknown id is 404, a malformed id is 400', async () => {
    const missing = await deleteDocument('11111111-1111-1111-1111-111111111111');
    expect(missing.status).toBe(404);
    await missing.arrayBuffer();
    const bad = await deleteDocument("x'; drop table jobs; --");
    expect(bad.status).toBe(400);
    await bad.arrayBuffer();
  });

  test('foreign Origin gets no CORS allow header on the new endpoints', async () => {
    for (const base of [`${WEB_URL}/api`, `${N8N_URL}/webhook/api`]) {
      for (const [method, path] of [
        ['GET', 'documents'],
        ['POST', 'documents/upload?kind=cv'],
        ['DELETE', 'documents?id=11111111-1111-1111-1111-111111111111'],
      ]) {
        const res = await fetch(`${base}/${path}`, { method, headers: { Origin: EVIL } });
        expect(res.headers.get('access-control-allow-origin')).not.toBe(EVIL);
        expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
        await res.arrayBuffer();
      }
    }
  });
});
