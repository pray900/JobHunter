import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { makeDocx } from '../helpers/makeDocx';
import {
  N8N_URL,
  ROOT,
  SYNC_HEADERS,
  WEB_URL,
  api,
  db,
  getFacts,
  listDocuments,
  makePdf,
  putDocument,
  resetState,
  saveFacts,
  storedDocuments,
  stub,
  triggerScoring,
  uploadDocument,
} from './lib';

const OWNER = '00000000-0000-0000-0000-000000000001';
const EVIL = 'https://evil.example';
const summaryKeys = ['analysisError', 'analysisStatus', 'edited', 'editedAt', 'id', 'kind', 'sourceRef', 'updatedAt', 'warnings'];
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
    expect(body.cv).toMatchObject({ kind: 'cv', sourceRef: 'new.pdf', analysisStatus: 'done', analysisError: null, edited: false, editedAt: null });
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
    expect(await storedDocuments('cv')).toEqual([]);
    expect(await db.query(`select id from base_documents`)).toEqual([]);
  });

  test('upload into an empty slot: 201, stored and analysed', async () => {
    const res = await uploadDocument('cover_letter', 'letter.pdf', makePdf('Letter'));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ sourceRef: 'letter.pdf' });
    expect(await storedDocuments('cover_letter')).toEqual(['letter.pdf']);
    // The upload already ran the sync, so the document is listed and analysed.
    expect((await listDocuments()).coverLetter).toMatchObject({ sourceRef: 'letter.pdf', analysisStatus: 'done' });
  });

  test('replace with a different name: the old file is gone, the new one is current', async () => {
    await putDocument('cv', 'old.pdf', makePdf('CV old'));
    const res = await uploadDocument('cv', 'fresh.pdf', makePdf('CV fresh'));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ sourceRef: 'fresh.pdf' });
    expect(await storedDocuments('cv')).toEqual(['fresh.pdf']);
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
    expect(await storedDocuments('cv')).toEqual(['a.pdf']);
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
    expect(await storedDocuments('cv')).toEqual([]);
  });

  test('a failed upload keeps the current CV', async () => {
    await putDocument('cv', 'a.pdf', makePdf('CV A'));
    for (const [name, bytes] of [['x.pdf', Buffer.from('not a pdf')], ['big.pdf', bigPdf()]] as const) {
      const res = await uploadDocument('cv', name, bytes);
      expect([400, 413]).toContain(res.status);
      await res.arrayBuffer();
    }
    expect(await storedDocuments('cv')).toEqual(['a.pdf']);
    expect((await listDocuments()).cv).toMatchObject({ sourceRef: 'a.pdf', analysisStatus: 'done' });
  });

  test('hostile file name is stored inside the storage or rejected', async () => {
    const res = await uploadDocument('cv', '../x.pdf', makePdf('CV x'));
    const body: any = await res.json();
    if (res.status === 201) {
      expect(body.sourceRef).not.toMatch(/[\\/]|\.\./);
      expect(await storedDocuments('cv')).toEqual([body.sourceRef]);
    } else {
      expect(res.status).toBe(400);
      expect(await storedDocuments('cv')).toEqual([]);
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
    expect(await storedDocuments('cv')).toEqual(['a.pdf']);
    expect((await listDocuments()).cv).toMatchObject({ id: row.id, sourceRef: 'a.pdf' });
  });

  test('foreign Origin gets no CORS allow header on the documents endpoints', async () => {
    for (const base of [`${WEB_URL}/api`, `${N8N_URL}/webhook/api`]) {
      for (const [method, path] of [
        ['GET', 'documents'],
        ['POST', 'documents/upload?kind=cv'],
        ['GET', 'documents/facts?kind=cv'],
        ['POST', 'documents/facts'],
        ['GET', 'documents/file?kind=cv'],
      ]) {
        const res = await fetch(`${base}/${path}`, { method, headers: { Origin: EVIL } });
        expect(res.headers.get('access-control-allow-origin')).not.toBe(EVIL);
        expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
        await res.arrayBuffer();
      }
      // The save is a JSON POST with X-JobHunter, so the browser asks first (preflight).
      const pre = await fetch(`${base}/documents/facts`, {
        method: 'OPTIONS',
        headers: { Origin: EVIL, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-jobhunter,content-type' },
      });
      expect(pre.headers.get('access-control-allow-origin')).not.toBe(EVIL);
      expect(pre.headers.get('access-control-allow-origin')).not.toBe('*');
      await pre.arrayBuffer();
    }
    const APP = 'http://localhost:5173';
    const pre = await fetch(`${N8N_URL}/webhook/api/documents/facts`, {
      method: 'OPTIONS',
      headers: { Origin: APP, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-jobhunter,content-type' },
    });
    expect(pre.headers.get('access-control-allow-origin')).toBe(APP);
    await pre.arrayBuffer();
    for (const path of ['documents/facts?kind=cv', 'documents/file?kind=cv']) {
      const ok = await fetch(`${N8N_URL}/webhook/api/${path}`, { headers: { Origin: APP } });
      expect(ok.headers.get('access-control-allow-origin')).toBe(APP);
      await ok.arrayBuffer();
    }
  });

  // Checks on the workflow JSON itself.
  describe('workflow definition', () => {
    const wf = JSON.parse(readFileSync(join(ROOT, 'n8n', 'workflows', 'documents-api.json'), 'utf8'));
    // Every HTTP request node on one webhook's path, summed: each request must answer within nginx's 30 s.
    const reachable = (start: string): string[] => {
      const seen = new Set<string>();
      const queue = [start];
      while (queue.length) {
        const name = queue.shift()!;
        if (seen.has(name)) continue;
        seen.add(name);
        for (const out of wf.connections[name]?.main ?? []) for (const c of out ?? []) queue.push(c.node);
      }
      return [...seen];
    };
    test('worst-case time of every endpoint stays under nginx 30 s', () => {
      const hooks = wf.nodes.filter((n: any) => n.type === 'n8n-nodes-base.webhook');
      expect(hooks.length).toBe(5);
      for (const hook of hooks) {
        const timeouts = reachable(hook.name)
          .map((name) => wf.nodes.find((n: any) => n.name === name))
          .filter((n: any) => n.type === 'n8n-nodes-base.httpRequest')
          .map((n: any) => n.parameters.options.timeout as number);
        expect(timeouts.every((t: number) => typeof t === 'number')).toBe(true);
        expect(timeouts.reduce((a: number, b: number) => a + b, 0)).toBeLessThan(30_000);
      }
    });
    test('the save endpoint checks the X-JobHunter header before anything else', () => {
      const first = wf.connections['POST api/documents/facts'].main[0];
      expect(first).toHaveLength(1);
      const gate = wf.nodes.find((n: any) => n.name === first[0].node);
      expect(gate.type).toBe('n8n-nodes-base.if');
      expect(gate.parameters.conditions.conditions[0]).toMatchObject({
        leftValue: "={{ $json.headers['x-jobhunter'] }}",
        rightValue: '1',
      });
    });
    test('every webhook allows only the web app origins', () => {
      for (const n of wf.nodes.filter((x: any) => x.type === 'n8n-nodes-base.webhook')) {
        expect(n.parameters.options.allowedOrigins).toBe('http://localhost:8080,http://localhost:5173');
      }
    });
  });
});

describe('base document facts API', () => {
  const factsKeys = ['contentHash', 'edited', 'editedAt', 'facts', 'id', 'kind', 'mediaType', 'rescoreJobs', 'sourceRef', 'warnings'];
  const row = async (sourceRef: string) =>
    (
      await db.query(
        `select id, structured, edited_facts, edited_at, warnings, content_hash, facts_hash, active, source_removed
         from base_documents where source_ref = $1`,
        [sourceRef],
      )
    )[0];
  const readFacts = async (kind = 'cv') => {
    const res = await getFacts(kind);
    expect(res.status).toBe(200);
    return res.json() as Promise<any>;
  };
  type DocRef = { kind: string; id: string; contentHash: string };
  const save = async (doc: DocRef, facts: unknown) => {
    const res = await saveFacts(doc.kind, doc.id, doc.contentHash, facts);
    return { status: res.status, body: (await res.json()) as any };
  };
  const addJob = (ref: string, status: string, removed = false) =>
    db.query(
      `insert into jobs (owner_id, source, source_ref, content_hash, raw_text, title, extraction_status, source_removed)
       values ($1, 'folder', $2, 'h', 'text', 'Job', $3, $4)`,
      [OWNER, ref, status, removed],
    );
  const codes = (warnings: any[]) => warnings.map((w) => w.code);

  beforeEach(async () => {
    await resetState();
  });
  afterAll(async () => {
    await resetState();
  });

  test('facts of the analysed CV', async () => {
    await putDocument('cv', 'cv.pdf', makePdf('Base CV'));
    await addJob('a.docx', 'done');
    await addJob('b.docx', 'done');
    await addJob('c.docx', 'pending');
    await addJob('d.docx', 'done', true);
    const r = await row('cv.pdf');
    const body = await readFacts('cv');
    expect(Object.keys(body).sort()).toEqual(factsKeys);
    expect(body).toEqual({
      id: r.id,
      kind: 'cv',
      sourceRef: 'cv.pdf',
      mediaType: 'application/pdf',
      contentHash: r.content_hash,
      facts: r.structured,
      edited: false,
      editedAt: null,
      warnings: r.warnings,
      rescoreJobs: 2,
    });
    expect(body.facts.name).toBe('Stub Person');
    expect(codes(body.warnings)).toContain('missing_work_rights');

    // A cover letter never re-scores anything.
    await putDocument('cover_letter', 'cl.pdf', makePdf('Letter'));
    expect(await readFacts('cover_letter')).toMatchObject({ kind: 'cover_letter', sourceRef: 'cl.pdf', rescoreJobs: 0 });
  });

  test('facts: no document is 404, a bad kind is 400', async () => {
    let res = await getFacts('cv');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_document' });
    // A document still being analysed (or failed) has no facts yet.
    await putDocument('cv', 'cv.pdf', makePdf('Base CV'));
    await db.query(`update base_documents set analysis_status = 'pending', structured = null`);
    res = await getFacts('cv');
    expect(res.status).toBe(404);
    await res.arrayBuffer();
    for (const kind of ['resume', '', "cv' or 1=1"]) {
      res = await getFacts(kind);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
  });

  test('save an edit: 200, edited, effective facts returned', async () => {
    await putDocument('cv', 'cv.pdf', makePdf('Base CV'));
    const before = await readFacts('cv');
    const edited = {
      ...before.facts,
      headline: '  Platform Engineer  ',
      // Text that looks like SQL parameters or injection is stored as it is.
      skills: ['TypeScript', 'Saved $1 and $2 a month', "O'Brien'); drop table jobs; --", '   '],
    };
    const { status, body } = await save(before, edited);
    expect(status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(factsKeys);
    const expected = { ...edited, headline: 'Platform Engineer', skills: edited.skills.slice(0, 3) };
    expect(body).toMatchObject({ id: before.id, kind: 'cv', sourceRef: 'cv.pdf', edited: true, facts: expected });
    expect(new Date(body.editedAt).toISOString()).toBe(body.editedAt);
    expect(Date.now() - Date.parse(body.editedAt)).toBeLessThan(60_000);

    const r = await row('cv.pdf');
    expect(r.edited_facts).toEqual(expected);
    expect(r.structured).toEqual(before.facts); // what Claude read from the file is kept
    expect(r.facts_hash).not.toBe(r.content_hash);
    expect(await readFacts('cv')).toEqual(body);
    expect((await listDocuments()).cv).toMatchObject({ id: before.id, edited: true, editedAt: body.editedAt });
    // Saving never calls Claude: the only request is the upload's analysis.
    expect((await stub.requests()).length).toBe(1);
  });

  test('saving unchanged facts stores no edit', async () => {
    await putDocument('cv', 'cv.pdf', makePdf('Base CV'));
    const before = await readFacts('cv');
    const { status, body } = await save(before, before.facts);
    expect(status).toBe(200);
    expect(body).toMatchObject({ edited: false, editedAt: null, facts: before.facts });
    const r = await row('cv.pdf');
    expect(r.edited_facts).toBeNull();
    expect(r.edited_at).toBeNull();
    expect(r.facts_hash).toBe(r.content_hash);
  });

  test("undo all edits goes back to the file's facts", async () => {
    await putDocument('cv', 'cv.pdf', makePdf('Base CV'));
    const before = await readFacts('cv');
    expect((await save(before, { ...before.facts, headline: 'Changed' })).body.edited).toBe(true);
    const { status, body } = await save(before, null);
    expect(status).toBe(200);
    expect(body).toEqual(before);
    const r = await row('cv.pdf');
    expect(r.edited_facts).toBeNull();
    expect(r.edited_at).toBeNull();
    expect(r.facts_hash).toBe(r.content_hash);
  });

  test('bad facts are 400 and save nothing', async () => {
    await putDocument('cv', 'cv.pdf', makePdf('Base CV'));
    const before = await readFacts('cv');
    const cases: [unknown, string][] = [
      [{ ...before.facts, bogus: 'x' }, 'facts.bogus'],
      ['just text', 'facts'],
      [[before.facts], 'facts'],
      [{ ...before.facts, skills: Array.from({ length: 101 }, () => 'x') }, 'facts.skills'],
      [{ ...before.facts, headline: 'a\u0000b' }, 'facts.headline'],
      [{ ...before.facts, headline: 42 }, 'facts.headline'],
    ];
    for (const [facts, path] of cases) {
      const { status, body } = await save(before, facts);
      expect(status).toBe(400);
      expect(body).toEqual({ error: 'invalid_facts', path });
    }
    // Requests that are not shaped like a save at all.
    const raw = (body: string) =>
      fetch(`${WEB_URL}/api/documents/facts`, {
        method: 'POST',
        headers: { ...SYNC_HEADERS, 'Content-Type': 'application/json' },
        body,
      });
    for (const body of [
      '[]',
      '"x"',
      JSON.stringify({ kind: 'cv', id: before.id, contentHash: before.contentHash }),
      JSON.stringify({ kind: 'resume', id: before.id, contentHash: before.contentHash, facts: before.facts }),
      JSON.stringify({ kind: 'cv', id: 'not-a-uuid', contentHash: before.contentHash, facts: before.facts }),
      JSON.stringify({ kind: 'cv', id: `${before.id}' or '1'='1`, contentHash: before.contentHash, facts: before.facts }),
      // The file version is required and must look like one.
      JSON.stringify({ kind: 'cv', id: before.id, facts: before.facts }),
      JSON.stringify({ kind: 'cv', id: before.id, contentHash: 'abc', facts: before.facts }),
      JSON.stringify({ kind: 'cv', id: before.id, contentHash: `${before.contentHash}' or '1'='1`, facts: before.facts }),
      JSON.stringify({ kind: 'cv', id: before.id, contentHash: 42, facts: before.facts }),
    ]) {
      const res = await raw(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
    // Over 200 KB.
    const big = await raw(JSON.stringify({ kind: 'cv', id: before.id, contentHash: before.contentHash, facts: { ...before.facts, summary: 'x'.repeat(210 * 1024) } }));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'too_large' });
    const r = await row('cv.pdf');
    expect(r.edited_facts).toBeNull();
    expect(r.warnings).toEqual(before.warnings);
  });

  test('save without X-JobHunter is 403 and saves nothing', async () => {
    await putDocument('cv', 'cv.pdf', makePdf('Base CV'));
    const before = await readFacts('cv');
    for (const headers of [{}, { 'X-JobHunter': '0' }]) {
      for (const base of [`${WEB_URL}/api`, `${N8N_URL}/webhook/api`]) {
        const res = await fetch(`${base}/documents/facts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ kind: 'cv', id: before.id, contentHash: before.contentHash, facts: { ...before.facts, headline: 'Forged' } }),
        });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'missing_jobhunter_header' });
      }
    }
    expect((await row('cv.pdf')).edited_facts).toBeNull();
  });

  test('save on a replaced document is 409', async () => {
    await putDocument('cv', 'old.pdf', makePdf('Base CV STUB_HEADLINE:old'));
    const old = await readFacts('cv');
    await putDocument('cv', 'new.pdf', makePdf('Base CV STUB_HEADLINE:new'));
    const fresh = await readFacts('cv');
    const edit = { ...old.facts, headline: 'Stale edit' };
    const stale: DocRef[] = [
      old, // replaced in another tab
      { ...fresh, kind: 'cover_letter' }, // the id of another kind
      { ...fresh, id: '00000000-0000-4000-8000-000000000000' }, // no such document
      { ...fresh, contentHash: old.contentHash }, // another file's version
    ];
    for (const doc of stale) {
      const { status, body } = await save(doc, edit);
      expect(status).toBe(409);
      expect(body).toEqual({ error: 'document_changed' });
    }
    // Still being analysed: no edit either.
    await db.query(`update base_documents set analysis_status = 'pending' where id = $1`, [fresh.id]);
    expect((await save(fresh, edit)).status).toBe(409);
    expect(await db.query(`select source_ref from base_documents where edited_facts is not null`)).toEqual([]);
  });

  test('replacing the file drops the edits', async () => {
    await putDocument('cv', 'cv.pdf', makePdf('Base CV STUB_HEADLINE:v1'));
    const v1 = await readFacts('cv');
    expect((await save(v1, { ...v1.facts, headline: 'Edited' })).body.edited).toBe(true);
    // Same name, new content: the row is analysed fresh and holds no edits.
    await putDocument('cv', 'cv.pdf', makePdf('Base CV STUB_HEADLINE:v2'));
    const v2 = await readFacts('cv');
    expect(v2).toMatchObject({ id: v1.id, edited: false, editedAt: null });
    expect(v2.facts.headline).toBe('v2');
    const r = await row('cv.pdf');
    expect(r.edited_facts).toBeNull();
    expect(r.edited_at).toBeNull();
    // A different name: a new row, also without edits.
    expect((await save(v2, { ...v2.facts, headline: 'Edited again' })).body.edited).toBe(true);
    await putDocument('cv', 'other.pdf', makePdf('Base CV STUB_HEADLINE:v3'));
    expect(await readFacts('cv')).toMatchObject({ sourceRef: 'other.pdf', edited: false, facts: { headline: 'v3' } });
  });

  test('same file again keeps the edits', async () => {
    const bytes = makePdf('Base CV STUB_HEADLINE:v1');
    await putDocument('cv', 'cv.pdf', bytes);
    const before = await readFacts('cv');
    const saved = (await save(before, { ...before.facts, headline: 'Edited' })).body;
    expect(saved.edited).toBe(true);
    await putDocument('cv', 'cv.pdf', bytes);
    expect(await readFacts('cv')).toEqual(saved);
  });

  test('warnings follow the edited facts', async () => {
    await putDocument('cv', 'cv.pdf', makePdf('Base CV'));
    const before = await readFacts('cv');
    expect(codes(before.warnings)).toContain('missing_work_rights');
    const fixed = await save(before, { ...before.facts, workRights: 'Australian citizen' });
    expect(fixed.status).toBe(200);
    expect(codes(fixed.body.warnings)).not.toContain('missing_work_rights');
    expect((await row('cv.pdf')).warnings).toEqual(fixed.body.warnings);
    expect((await listDocuments()).cv.warnings).toEqual(fixed.body.warnings);
    // Undo brings back the file's warnings.
    expect(codes((await save(before, null)).body.warnings)).toContain('missing_work_rights');
  });

  test('cover letter edits save too', async () => {
    await putDocument('cover_letter', 'cl.pdf', makePdf('Letter'));
    const before = await readFacts('cover_letter');
    const { status, body } = await save(before, { ...before.facts, toneNotes: 'Warm and direct.' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ kind: 'cover_letter', edited: true, rescoreJobs: 0, facts: { toneNotes: 'Warm and direct.' } });
  });

  test('save after a same-name replace is 409 and changes nothing', async () => {
    await putDocument('cv', 'cv.pdf', makePdf('Base CV STUB_HEADLINE:v1'));
    const stale = await readFacts('cv');
    await putDocument('cv', 'cv.pdf', makePdf('Base CV STUB_HEADLINE:v2'));
    const fresh = await readFacts('cv');
    expect(fresh.id).toBe(stale.id); // same row, new file
    expect(fresh.contentHash).not.toBe(stale.contentHash);
    const before = await row('cv.pdf');
    const { status, body } = await save(stale, { ...stale.facts, headline: 'Old tab edit' });
    expect(status).toBe(409);
    expect(body).toEqual({ error: 'document_changed' });
    expect(await row('cv.pdf')).toEqual(before);
    expect(await readFacts('cv')).toEqual(fresh);
  });

  test('a raw analysis with untrimmed and blank values: unchanged save stores no edit, undo works', async () => {
    await putDocument('cv', 'cv.pdf', makePdf('Base CV'));
    // What Claude returned, before any cleaning: blank phone, padded text, a blank bullet.
    const [{ structured }] = await db.query(`select structured from base_documents where source_ref = 'cv.pdf'`);
    const raw = {
      ...structured,
      headline: `  ${structured.headline}  `,
      contact: { ...structured.contact, phone: '' },
      roles: structured.roles.map((r: any) => ({ ...r, bullets: [...r.bullets, '  '] })),
    };
    await db.query(`update base_documents set structured = $1::jsonb where source_ref = 'cv.pdf'`, [JSON.stringify(raw)]);
    const before = await readFacts('cv');
    // The form shows the cleaned facts and sends them back unchanged.
    const cleaned = { ...structured, contact: { ...structured.contact, phone: null } };
    const same = await save(before, cleaned);
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ edited: false, editedAt: null });
    expect((await row('cv.pdf')).edited_facts).toBeNull();
    // An edit, then undo: back to the raw facts, no edit stored.
    expect((await save(before, { ...cleaned, headline: 'Changed' })).body.edited).toBe(true);
    const undo = await save(before, null);
    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ edited: false, editedAt: null, facts: raw });
    expect((await row('cv.pdf')).edited_facts).toBeNull();
  });

  test('undo works even when the file facts would fail the strict check', async () => {
    await putDocument('cv', 'cv.pdf', makePdf('Base CV'));
    const before = await readFacts('cv');
    expect((await save(before, { ...before.facts, headline: 'Changed' })).body.edited).toBe(true);
    // Claude returned more skills than an edit may hold (and an extra key).
    const big = { ...before.facts, skills: Array.from({ length: 150 }, (_, i) => `skill ${i}`), confidence: 'high' };
    await db.query(`update base_documents set structured = $1::jsonb where source_ref = 'cv.pdf'`, [JSON.stringify(big)]);
    const undo = await save(before, null);
    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ edited: false, facts: big });
    expect(codes(undo.body.warnings)).toContain('missing_work_rights');
  });

  test('an earlier file uploaded again does not bring its old edits back', async () => {
    const a = makePdf('Base CV STUB_HEADLINE:a');
    await putDocument('cv', 'a.pdf', a);
    const first = await readFacts('cv');
    expect((await save(first, { ...first.facts, headline: 'Edited a' })).body.edited).toBe(true);
    await putDocument('cv', 'b.pdf', makePdf('Base CV STUB_HEADLINE:b'));
    expect((await row('a.pdf')).edited_facts).toBeNull();
    await putDocument('cv', 'a.pdf', a);
    expect(await readFacts('cv')).toMatchObject({ sourceRef: 'a.pdf', edited: false, editedAt: null, facts: { headline: 'a' } });
  });

  test('file endpoint serves the PDF inline and Word as attachment', async () => {
    let res = await api.get('/api/documents/file?kind=cv');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_document' });
    res = await api.get('/api/documents/file?kind=resume');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request' });

    const pdf = makePdf('Base CV');
    await putDocument('cv', 'Jane Citizen CV (2026).pdf', pdf);
    res = await api.get('/api/documents/file?kind=cv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/pdf/);
    expect(res.headers.get('content-disposition')).toBe(
      `inline; filename="Jane Citizen CV (2026).pdf"; filename*=UTF-8''Jane%20Citizen%20CV%20%282026%29.pdf`,
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await res.arrayBuffer()).equals(pdf)).toBe(true);

    const docx = await makeDocx([{ text: 'Dear Ms Quill,' }, { text: 'I would like to apply.' }]);
    await putDocument('cover_letter', 'Cover Letter.docx', docx);
    res = await api.get('/api/documents/file?kind=cover_letter');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(
      /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/,
    );
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="Cover Letter.docx"; filename*=UTF-8''Cover%20Letter.docx`,
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await res.arrayBuffer()).equals(docx)).toBe(true);
  });
});
