import pg from 'pg';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { CV, LETTER } from '../../services/worker/test/fixtures';
import { N8N_URL, SYNC_HEADERS, WEB_URL, db, makePdf, putDocument, resetState, stub } from './lib';

const OWNER = '00000000-0000-0000-0000-000000000001';
const DB_URL = 'postgres://jobhunter:test@localhost:55433/jobhunter';
const MISSING = '00000000-0000-0000-0000-0000000000ff';

const post = (path: string, body?: unknown, headers: Record<string, string> = SYNC_HEADERS) =>
  fetch(`${WEB_URL}/api/${path}`, {
    method: 'POST',
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (path: string) => fetch(`${WEB_URL}/api/${path}`);

async function addJob(over: Record<string, unknown> = {}): Promise<string> {
  const j = { title: 'Engineer', employer: 'Acme', advertiser: null, ...over };
  const [row] = await db.query(
    `insert into jobs (owner_id, source, source_ref, content_hash, raw_text, title, employer, advertiser, extraction_status, url)
     values ($1, 'folder', $2, 'h', 'The ad text', $3, $4, $5, 'done', 'https://x.io/a') returning id`,
    [OWNER, `j-${Math.random()}.docx`, j.title, j.employer, j.advertiser],
  );
  return row.id;
}
const withCv = () => putDocument('cv', 'cv.pdf', makePdf('Base CV of Stub Person'));

interface SeedOpts {
  versionNo: number;
  origin?: string;
  label?: string;
  parent?: string | null;
  instruction?: string | null;
  manualEdit?: boolean;
  cv?: unknown;
  review?: unknown;
  reasons?: unknown;
  checks?: unknown;
  baseCvId?: string | null;
  baseCvHash?: string;
  runId?: string | null;
}
async function seed(jobId: string, o: SeedOpts): Promise<string> {
  const [v] = await db.query(
    `insert into document_versions (owner_id, job_id, run_id, version_no, label, base_cv_id, base_cv_hash, template_id, cv, cover_letter,
       reasons, keyword_coverage, review, checks, instruction, manual_edit, origin, parent_version_id)
     values ($1,$2,$3,$4,$5,$6,$17,'standard-ats',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
    [
      OWNER, jobId, o.runId ?? null, o.versionNo, o.label ?? 'Generated', o.baseCvId ?? null,
      JSON.stringify(o.cv ?? CV), JSON.stringify(LETTER),
      JSON.stringify(o.reasons ?? { templateReason: 'r', changes: [], stretches: [], factRulings: [] }),
      JSON.stringify({ covered: [], missing: [] }),
      JSON.stringify(o.review ?? { passed: true, rounds: 1, verdicts: ['pass'], unresolved: [] }),
      JSON.stringify(o.checks ?? []),
      o.instruction ?? null, o.manualEdit ?? false, o.origin ?? 'generated', o.parent ?? null, o.baseCvHash ?? 'bh',
    ],
  );
  return v.id;
}
const rows = (jobId: string) =>
  db.query(`select * from document_versions where job_id=$1 order by version_no`, [jobId]);
const noClaude = async () => expect(await stub.requests()).toEqual([]);

describe('versions API', () => {
  beforeEach(async () => {
    await resetState();
  });
  afterAll(async () => {
    await resetState();
  });

  test('versions list newest first with origin and label', async () => {
    const jobId = await addJob();
    const v1 = await seed(jobId, { versionNo: 1, checks: [{ code: 'x', severity: 'hard' }, { code: 'y', severity: 'review' }] });
    const v2 = await seed(jobId, {
      versionNo: 2, origin: 'regenerated', label: 'Make it shorter', instruction: 'Make it shorter',
      review: { passed: false }, checks: [{ code: 'x', severity: 'hard' }, { code: 'x', severity: 'hard' }],
    });
    const v3 = await seed(jobId, {
      versionNo: 3, origin: 'edited', label: 'Edited', parent: v2, manualEdit: true,
      review: { passed: false, reviewedVersionNo: 2 },
    });
    const v4 = await seed(jobId, { versionNo: 4, origin: 'restored', label: 'Restored version 1', parent: v1 });
    const res = await get(`jobs/versions?id=${jobId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Object.keys(body)).toEqual(['versions']);
    expect(body.versions.map((v: any) => v.id)).toEqual([v4, v3, v2, v1]);
    expect(Object.keys(body.versions[0]).sort()).toEqual([
      'createdAt', 'hardChecks', 'id', 'instruction', 'label', 'manualEdit', 'origin', 'passed', 'versionNo',
    ]);
    expect(body.versions.map((v: any) => [v.versionNo, v.origin, v.label, v.passed, v.hardChecks, v.manualEdit, v.instruction])).toEqual([
      [4, 'restored', 'Restored version 1', true, 0, false, null],
      [3, 'edited', 'Edited', null, 0, true, null],
      [2, 'regenerated', 'Make it shorter', false, 2, false, 'Make it shorter'],
      [1, 'generated', 'Generated', true, 1, false, null],
    ]);
    expect(new Date(body.versions[0].createdAt).toISOString()).toBe(body.versions[0].createdAt);
  });

  test('passed is null (not reviewed) for edited versions and for a review that is not an object', async () => {
    await withCv();
    const jobId = await addJob();
    const v1 = await seed(jobId, { versionNo: 1 });
    const res = await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv: { ...CV, headline: 'Edited headline' }, coverLetter: LETTER });
    expect(res.status).toBe(201);
    const restored = await post(`jobs/versions/restore?id=${jobId}`, { versionId: ((await res.json()) as any).versionId });
    expect(restored.status).toBe(201);
    await seed(jobId, { versionNo: 4, review: 'unexpected text' });
    const list = ((await (await get(`jobs/versions?id=${jobId}`)).json()) as any).versions;
    expect(list.map((v: any) => [v.versionNo, v.origin, v.passed])).toEqual([
      [4, 'generated', null], [3, 'restored', null], [2, 'edited', null], [1, 'generated', true],
    ]);
  });

  test('versions: unknown job is 404 and a job with none is empty', async () => {
    const jobId = await addJob();
    expect(await (await get(`jobs/versions?id=${jobId}`)).json()).toEqual({ versions: [] });
    for (const id of [MISSING, 'nope']) {
      const res = await get(`jobs/versions?id=${id}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'job_not_found' });
    }
  });

  test('edit saves a new version with checks and manual edits', async () => {
    await withCv();
    const jobId = await addJob();
    const v1 = await seed(jobId, {
      versionNo: 1,
      review: { passed: true, rounds: 1, verdicts: ['pass'], unresolved: [] },
      reasons: { templateReason: 'r', changes: [], stretches: [], factRulings: [], manualEdits: ['cv.headline'] },
    });
    await stub.reset();
    const cv = { ...CV, summary: 'A new summary written by hand.' };
    const res = await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv, coverLetter: LETTER });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(Object.keys(body).sort()).toEqual(['checks', 'versionId', 'versionNo']);
    expect(body.versionNo).toBe(2);
    expect(Array.isArray(body.checks)).toBe(true);

    const [, v2] = await rows(jobId);
    expect(v2).toMatchObject({
      id: body.versionId, version_no: 2, origin: 'edited', label: 'Edited', manual_edit: true, parent_version_id: v1,
      run_id: null, instruction: null, owner_id: OWNER, template_id: 'standard-ats',
    });
    expect(v2.cv).toEqual(cv);
    expect(v2.cover_letter).toEqual(LETTER);
    expect(v2.checks).toEqual(body.checks);
    expect(v2.review).toEqual({ passed: true, rounds: 1, verdicts: ['pass'], unresolved: [], reviewedVersionNo: 1 });
    // Manual edits are kept by text. The source's old path-only entry is read as the text at that path.
    expect(v2.reasons.manualEdits).toEqual([
      { path: 'cv.headline', text: CV.headline },
      { path: 'cv.summary', text: 'A new summary written by hand.' },
    ]);
    expect(v2.reasons.templateReason).toBe('r');
    expect(v2.keyword_coverage).toEqual({ covered: [], missing: [] });
    await noClaude();

    // Editing the edit keeps the first reviewedVersionNo and unions the edited paths.
    const res2 = await post(`jobs/versions/edit?id=${jobId}`, {
      fromVersionId: body.versionId, cv: { ...cv, headline: 'Staff Engineer' }, coverLetter: LETTER,
    });
    expect(res2.status).toBe(201);
    const v3 = (await rows(jobId))[2];
    expect(v3.review.reviewedVersionNo).toBe(1);
    expect(v3.reasons.manualEdits).toEqual([
      { path: 'cv.headline', text: 'Staff Engineer' },
      { path: 'cv.summary', text: 'A new summary written by hand.' },
    ]);
    expect(v3.parent_version_id).toBe(body.versionId);
    await noClaude();
  });

  test('edit tracks manual edits by text: a removed or moved bullet is not an edit, an earlier edit follows its text', async () => {
    await withCv();
    const jobId = await addJob();
    const three = { ...CV, experience: [{ ...CV.experience[0]!, bullets: ['First bullet.', 'MY_EDIT_2201 bullet.', 'Third bullet.'] }] };
    const v1 = await seed(jobId, {
      versionNo: 1, cv: three,
      reasons: { templateReason: 'r', changes: [], stretches: [], factRulings: [], manualEdits: [{ path: 'cv.experience[0].bullets[1]', text: 'MY_EDIT_2201 bullet.' }] },
    });
    // The upload's CV reading is not part of the edit.
    await stub.reset();
    // Remove the first bullet: the others move up a place. Nothing new was written.
    const removed = { ...three, experience: [{ ...three.experience[0]!, bullets: ['MY_EDIT_2201 bullet.', 'Third bullet.'] }] };
    let res = await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv: removed, coverLetter: LETTER });
    expect(res.status).toBe(201);
    let v = (await rows(jobId))[1];
    expect(v.reasons.manualEdits).toEqual([{ path: 'cv.experience[0].bullets[0]', text: 'MY_EDIT_2201 bullet.' }]);
    // Swap the two bullets and reword the third one: only the reworded text is a new edit.
    const swapped = { ...three, experience: [{ ...three.experience[0]!, bullets: ['Third bullet, reworded.', 'MY_EDIT_2201 bullet.'] }] };
    res = await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v.id, cv: swapped, coverLetter: LETTER });
    expect(res.status).toBe(201);
    v = (await rows(jobId))[2];
    expect(v.reasons.manualEdits).toEqual([
      { path: 'cv.experience[0].bullets[0]', text: 'Third bullet, reworded.' },
      { path: 'cv.experience[0].bullets[1]', text: 'MY_EDIT_2201 bullet.' },
    ]);
    // A new skill group is recorded field by field; an emptied email is an edit with no text.
    const grouped = { ...swapped, contact: { ...swapped.contact, email: null }, skills: [...swapped.skills, { group: 'Cloud', items: ['AWS'] }] };
    res = await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v.id, cv: grouped, coverLetter: LETTER });
    expect(res.status).toBe(201);
    v = (await rows(jobId))[3];
    expect(v.reasons.manualEdits).toEqual([
      { path: 'cv.contact.email', text: null },
      { path: 'cv.experience[0].bullets[0]', text: 'Third bullet, reworded.' },
      { path: 'cv.experience[0].bullets[1]', text: 'MY_EDIT_2201 bullet.' },
      { path: 'cv.skills[1].group', text: 'Cloud' },
      { path: 'cv.skills[1].items[0]', text: 'AWS' },
    ]);
    await noClaude();
  });

  test('edit stores null for empty optional values and drops unknown keys', async () => {
    await withCv();
    const jobId = await addJob();
    const v1 = await seed(jobId, { versionNo: 1 });
    const cv: any = {
      ...CV,
      contact: { ...CV.contact, location: '', email: '', phone: '' },
      workRights: '',
      experience: [{ ...CV.experience[0], location: '', extra: 'x' }],
      evil: '<script>',
    };
    const res = await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv, coverLetter: { ...LETTER, junk: 1 }, other: 1 });
    expect(res.status).toBe(201);
    const saved = (await rows(jobId))[1];
    expect(saved.cv.contact).toMatchObject({ location: null, email: null, phone: null });
    expect(saved.cv.workRights).toBeNull();
    expect(saved.cv.experience[0].location).toBeNull();
    expect(saved.cv.experience[0]).not.toHaveProperty('extra');
    expect(saved.cv).not.toHaveProperty('evil');
    expect(saved.cover_letter).not.toHaveProperty('junk');
  });

  test('edit with an unknown fact is saved with a hard check', async () => {
    await withCv();
    const jobId = await addJob();
    const v1 = await seed(jobId, { versionNo: 1 });
    const cv = { ...CV, experience: [{ ...CV.experience[0], bullets: [...CV.experience[0].bullets, 'Led 4711 engineers across five continents.'] }] };
    const res = await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv, coverLetter: LETTER });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    const hit = body.checks.find((c: any) => c.code === 'unknown_fact' && c.severity === 'hard' && String(c.detail).includes('4711'));
    expect(hit).toBeTruthy();
    expect((await rows(jobId))[1].checks).toEqual(body.checks);
    // The version can still be downloaded.
    const dl = await get(`jobs/download?id=${jobId}&doc=cv&format=docx&versionId=${body.versionId}`);
    expect(dl.status).toBe(200);
    expect(Buffer.from(await dl.arrayBuffer()).subarray(0, 2).toString()).toBe('PK');
  }, 60_000);

  test('edit during a run keeps both', async () => {
    await withCv();
    const jobId = await addJob();
    const v1 = await seed(jobId, { versionNo: 1 });
    await db.query(`insert into generation_runs (owner_id, job_id, status, stage) values ($1,$2,'in_progress','writing')`, [OWNER, jobId]);
    const res = await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv: { ...CV, headline: 'During a run' }, coverLetter: LETTER });
    expect(res.status).toBe(201);
    // The run finishes later and saves its own version after the edit.
    await seed(jobId, { versionNo: 3, origin: 'regenerated', label: 'x' });
    const all = await rows(jobId);
    expect(all.map((r) => [r.version_no, r.origin])).toEqual([[1, 'generated'], [2, 'edited'], [3, 'regenerated']]);
    expect(all[1].cv.headline).toBe('During a run');
    expect(await db.query(`select status from generation_runs`)).toEqual([{ status: 'in_progress' }]);
  });

  test('concurrent saves get distinct versions', async () => {
    await withCv();
    const jobId = await addJob();
    const v1 = await seed(jobId, { versionNo: 1 });
    const calls = [
      ...[1, 2, 3, 4].map((i) => post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv: { ...CV, headline: `Edit ${i}` }, coverLetter: LETTER })),
      post(`jobs/versions/restore?id=${jobId}`, { versionId: v1 }),
      post(`jobs/versions/restore?id=${jobId}`, { versionId: v1 }),
    ];
    const results = await Promise.all(calls);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    const bodies = (await Promise.all(results.map((r) => r.json()))) as any[];
    expect(new Set(bodies.map((b) => b.versionNo)).size).toBe(6);
    expect((await rows(jobId)).map((r) => r.version_no)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  }, 120_000);

  test('restore copies the old version as a new one', async () => {
    const jobId = await addJob();
    const old = await seed(jobId, {
      versionNo: 1, instruction: 'Shorter', origin: 'regenerated', manualEdit: true,
      cv: { ...CV, headline: 'Old headline' },
      checks: [{ code: 'x', severity: 'hard' }],
      reasons: { templateReason: 'old', manualEdits: ['cv.headline'] },
      review: { passed: false, reviewedVersionNo: 1 },
    });
    await seed(jobId, { versionNo: 2, cv: { ...CV, headline: 'Newer' } });
    const res = await post(`jobs/versions/restore?id=${jobId}`, { versionId: old });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(Object.keys(body).sort()).toEqual(['versionId', 'versionNo']);
    expect(body.versionNo).toBe(3);
    const all = await rows(jobId);
    expect(all).toHaveLength(3);
    expect(all[2]).toMatchObject({
      id: body.versionId, origin: 'restored', label: 'Restored version 1', parent_version_id: old, run_id: null,
      manual_edit: true, template_id: 'standard-ats',
    });
    for (const k of ['cv', 'cover_letter', 'reasons', 'checks', 'review', 'keyword_coverage'] as const) {
      expect(all[2][k]).toEqual(all[0][k]);
    }
    expect(all[0].origin).toBe('regenerated'); // the old row is untouched
    await noClaude();
  });

  test('edit and restore need the header', async () => {
    await withCv();
    const jobId = await addJob();
    const v1 = await seed(jobId, { versionNo: 1 });
    for (const [path, body] of [
      [`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv: CV, coverLetter: LETTER }],
      [`jobs/versions/restore?id=${jobId}`, { versionId: v1 }],
    ] as const) {
      for (const headers of [{}, { 'X-JobHunter': '0' }]) {
        const res = await post(path, body, headers);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'missing_jobhunter_header' });
      }
      const x = await fetch(`${N8N_URL}/webhook/api/${path}`, {
        method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' }, body: JSON.stringify(body),
      });
      expect(x.status).toBe(403);
      await x.arrayBuffer();
    }
    expect(await rows(jobId)).toHaveLength(1);
  });

  test("edit or restore of another job's version is 404", async () => {
    await withCv();
    const a = await addJob();
    const b = await addJob();
    const va = await seed(a, { versionNo: 1 });
    await seed(b, { versionNo: 1 });
    for (const [path, body] of [
      [`jobs/versions/edit?id=${b}`, { fromVersionId: va, cv: CV, coverLetter: LETTER }],
      [`jobs/versions/edit?id=${b}`, { fromVersionId: MISSING, cv: CV, coverLetter: LETTER }],
      [`jobs/versions/restore?id=${b}`, { versionId: va }],
      [`jobs/versions/restore?id=${b}`, { versionId: MISSING }],
    ] as const) {
      const res = await post(path, body);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'version_not_found' });
    }
    const res = await post(`jobs/versions/edit?id=${MISSING}`, { fromVersionId: va, cv: CV, coverLetter: LETTER });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'job_not_found' });
    expect((await post(`jobs/versions/restore?id=nope`, { versionId: va })).status).toBe(404);
    expect(await rows(a)).toHaveLength(1);
    expect(await rows(b)).toHaveLength(1);
  });

  test('invalid document is 400 with the path', async () => {
    await withCv();
    const jobId = await addJob();
    const v1 = await seed(jobId, { versionNo: 1 });
    let res = await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv: { ...CV, name: '' }, coverLetter: LETTER });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_document', path: 'cv.name' });
    const { paragraphs, ...noParas } = LETTER;
    res = await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv: CV, coverLetter: noParas });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_document', path: 'coverLetter.paragraphs' });
    res = await post(`jobs/versions/edit?id=${jobId}`, {
      fromVersionId: v1, cv: { ...CV, experience: [{ ...CV.experience[0], bullets: [5] }] }, coverLetter: LETTER,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_document', path: 'cv.experience[0].bullets[0]' });
    expect(await rows(jobId)).toHaveLength(1);
  });

  test('malformed requests are 400 bad_request', async () => {
    await withCv();
    const jobId = await addJob();
    const v1 = await seed(jobId, { versionNo: 1 });
    const bads: unknown[] = [
      undefined, [], 'x', { cv: CV, coverLetter: LETTER },
      { fromVersionId: 'nope', cv: CV, coverLetter: LETTER },
      { fromVersionId: v1, coverLetter: LETTER },
      { fromVersionId: v1, cv: CV },
      { fromVersionId: v1, cv: [], coverLetter: LETTER },
      { fromVersionId: v1, cv: CV, coverLetter: 'x' },
      { fromVersionId: v1, cv: { ...CV, summary: 'a\u0000b' }, coverLetter: LETTER },
    ];
    for (const b of bads) {
      const res = await post(`jobs/versions/edit?id=${jobId}`, b);
      expect(res.status, JSON.stringify(b)?.slice(0, 80)).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
    for (const b of [undefined, {}, { versionId: 5 }, { versionId: 'nope' }]) {
      const res = await post(`jobs/versions/restore?id=${jobId}`, b);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
    expect(await rows(jobId)).toHaveLength(1);
  });

  test('over 200 KB is 413', async () => {
    await withCv();
    const jobId = await addJob();
    const v1 = await seed(jobId, { versionNo: 1 });
    await stub.reset();
    const res = await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv: { ...CV, summary: 'x'.repeat(205_000) }, coverLetter: LETTER });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'too_large' });
    expect(await rows(jobId)).toHaveLength(1);
    const ok = await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv: { ...CV, summary: 'word '.repeat(5000).trim() }, coverLetter: LETTER });
    expect(ok.status).toBe(201);
  });

  test('detail and download by versionId', async () => {
    const jobId = await addJob();
    const v1 = await seed(jobId, { versionNo: 1, cv: { ...CV, name: 'First Person' } });
    const v2 = await seed(jobId, {
      versionNo: 2, origin: 'edited', label: 'Edited', parent: v1, manualEdit: true,
      reasons: { templateReason: 'r', manualEdits: ['cv.summary', 'cv.experience[7].bullets[0]'] },
    });
    let body = (await (await get(`jobs/detail?id=${jobId}`)).json()) as any;
    // An old path-only row is answered by text: the text at that path; a path that no longer exists is left out.
    expect(body.version).toMatchObject({
      id: v2, versionNo: 2, origin: 'edited', parentVersionId: v1, manualEdits: [{ path: 'cv.summary', text: CV.summary }], isCurrent: true,
    });
    expect(body.versions).toBe(2);
    body = (await (await get(`jobs/detail?id=${jobId}&versionId=${v1}`)).json()) as any;
    expect(body.version).toMatchObject({
      id: v1, versionNo: 1, origin: 'generated', parentVersionId: null, manualEdits: [], isCurrent: false,
    });
    expect(body.version.cv.name).toBe('First Person');
    for (const q of [`versionId=${MISSING}`, 'versionId=nope']) {
      const res = await get(`jobs/detail?id=${jobId}&${q}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'version_not_found' });
    }
    // Another job's version is not found either.
    const other = await addJob();
    const vo = await seed(other, { versionNo: 1 });
    expect((await get(`jobs/detail?id=${jobId}&versionId=${vo}`)).status).toBe(404);

    const name = async (q: string) => {
      const res = await get(`jobs/download?id=${jobId}&doc=cv&format=docx${q}`);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      return /filename="([^"]*)"/.exec(res.headers.get('content-disposition')!)![1];
    };
    expect(await name('')).toBe('Jordan Testcase - CV - Acme.docx');
    // A version asked for by id carries its number, so downloads of two versions never share a name.
    expect(await name(`&versionId=${v1}`)).toBe('First Person - CV - Acme - v1.docx');
    expect(await name(`&versionId=${v2}`)).toBe('Jordan Testcase - CV - Acme - v2.docx');
    for (const q of [`&versionId=${MISSING}`, `&versionId=${vo}`]) {
      const res = await get(`jobs/download?id=${jobId}&doc=cv&format=docx${q}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'version_not_found' });
    }
    const bad = await get(`jobs/download?id=${jobId}&doc=cv&format=docx&versionId=nope`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'bad_request' });
  }, 60_000);

  test('base cv replaced', async () => {
    await withCv();
    const jobId = await addJob();
    const [base] = await db.query(`select id, source_ref from base_documents where kind='cv' and active`);
    const [{ content_hash }] = await db.query(`select content_hash from base_documents where id=$1`, [base.id]);
    const v1 = await seed(jobId, { versionNo: 1, baseCvId: base.id, baseCvHash: content_hash });
    await seed(jobId, { versionNo: 2 });
    let body = (await (await get(`jobs/detail?id=${jobId}&versionId=${v1}`)).json()) as any;
    expect(Object.keys(body.baseCv).sort()).toEqual(['isCurrentBase', 'sourceRef', 'structured']);
    expect(body.baseCv).toMatchObject({ sourceRef: base.source_ref, isCurrentBase: true });
    expect(body.baseCv.structured).toBeTruthy();
    // No base CV row on a version: null.
    expect(((await (await get(`jobs/detail?id=${jobId}`)).json()) as any).baseCv).toBeNull();
    // Replaced: the old row is no longer the active one.
    await db.query(`update base_documents set active=false where id=$1`, [base.id]);
    body = (await (await get(`jobs/detail?id=${jobId}&versionId=${v1}`)).json()) as any;
    expect(body.baseCv.isCurrentBase).toBe(false);
    expect(body.baseCv.structured).toBeTruthy();
    // The same row saved again with other content (same file name): not the version's base any more.
    await db.query(`update base_documents set active=true, content_hash='changed-in-place' where id=$1`, [base.id]);
    body = (await (await get(`jobs/detail?id=${jobId}&versionId=${v1}`)).json()) as any;
    expect(body.baseCv).toBeNull();
    // Deleted: null.
    await db.query(`delete from base_documents where id=$1`, [base.id]);
    body = (await (await get(`jobs/detail?id=${jobId}&versionId=${v1}`)).json()) as any;
    expect(body.baseCv).toBeNull();
  });

  test('no Claude request during edit or restore', async () => {
    await withCv();
    const jobId = await addJob();
    const v1 = await seed(jobId, { versionNo: 1 });
    await stub.reset();
    expect((await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv: { ...CV, headline: 'Z' }, coverLetter: LETTER })).status).toBe(201);
    expect((await post(`jobs/versions/restore?id=${jobId}`, { versionId: v1 })).status).toBe(201);
    expect((await get(`jobs/versions?id=${jobId}`)).status).toBe(200);
    await noClaude();
  });

  // Holds an uncommitted version row so the next save collides on the unique index; commits once a save is
  // blocked on it. The save then has to run its insert again to get the next number.
  async function collide(jobId: string, versionNo: number, fire: () => Promise<Response>): Promise<Response> {
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into document_versions (owner_id, job_id, version_no, label, base_cv_hash, template_id, cv, cover_letter, reasons, keyword_coverage, review, checks)
         values ($1,$2,$3,'Blocker','bh','standard-ats','{}','{}','{}','{}','{}','[]')`,
        [OWNER, jobId, versionNo],
      );
      const pending = fire();
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const waiting = await db.query(
          `select 1 from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database() and pid <> pg_backend_pid()`,
        );
        blocked = waiting.length > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 200));
      }
      expect(blocked).toBe(true);
      await client.query('commit');
      return await pending;
    } finally {
      await client.end();
    }
  }

  test('a version number clash is retried (restore)', async () => {
    const jobId = await addJob();
    const v1 = await seed(jobId, { versionNo: 1 });
    const res = await collide(jobId, 2, () => post(`jobs/versions/restore?id=${jobId}`, { versionId: v1 }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).versionNo).toBe(3);
    expect((await rows(jobId)).map((r) => [r.version_no, r.label])).toEqual([[1, 'Generated'], [2, 'Blocker'], [3, 'Restored version 1']]);
  }, 60_000);

  test('a version number clash is retried (edit)', async () => {
    await withCv();
    const jobId = await addJob();
    const v1 = await seed(jobId, { versionNo: 1 });
    const res = await collide(jobId, 2, () =>
      post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv: { ...CV, headline: 'Retried' }, coverLetter: LETTER }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.versionNo).toBe(3);
    expect((await rows(jobId))[2]).toMatchObject({ id: body.versionId, origin: 'edited' });
  }, 60_000);

  test('the edit is checked with the same input as Generate (other jobs, base cover letter, current base CV)', async () => {
    await withCv();
    await putDocument('cover_letter', 'letter.pdf', makePdf('Base letter'));
    const jobId = await addJob();
    await addJob({ title: 'Barista', employer: 'Globexia Holdings' });
    await db.query(
      `update base_documents set structured = jsonb_set(structured, '{previousTarget}', '{"company":"Initech Pty","addressee":null,"role":null}') where kind='cover_letter' and active`,
    );
    const v1 = await seed(jobId, { versionNo: 1 });
    const letter = { ...LETTER, paragraphs: ['I admire Globexia Holdings.', 'I also wrote to Initech Pty last week.'] };
    const res = await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv: CV, coverLetter: letter });
    expect(res.status).toBe(201);
    const checks = ((await res.json()) as any).checks as any[];
    const leaks = checks.filter((c) => c.code === 'company_leakage' && c.severity === 'hard').map((c) => String(c.detail));
    expect(leaks.some((d) => d.includes('Globexia Holdings') && d.includes('another job employer'))).toBe(true);
    expect(leaks.some((d) => d.includes('Initech Pty') && d.includes('previousTarget.company'))).toBe(true);
    // A fact only the CURRENT base CV has is not flagged.
    const cv = { ...CV, experience: [{ ...CV.experience[0], bullets: ['Led 4711 engineers across five continents.'] }] };
    const flagged = async () =>
      (((await (await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv, coverLetter: LETTER })).json()) as any).checks as any[]).some(
        (c) => c.code === 'unknown_fact' && String(c.detail).includes('4711'),
      );
    expect(await flagged()).toBe(true);
    await db.query(`update base_documents set structured = structured || '{"note":"Led 4711 engineers"}'::jsonb where kind='cv' and active`);
    expect(await flagged()).toBe(false);
  }, 90_000);

  test('an unpaired surrogate is bad_request; an empty or repeated versionId is not the current version', async () => {
    await withCv();
    const jobId = await addJob();
    const v1 = await seed(jobId, { versionNo: 1 });
    const bad = String.fromCharCode(0xd800);
    const res = await post(`jobs/versions/edit?id=${jobId}`, { fromVersionId: v1, cv: { ...CV, summary: `lone ${bad} surrogate` }, coverLetter: LETTER });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request' });
    for (const q of ['versionId=', `versionId=${v1}&versionId=${v1}`]) {
      const d = await get(`jobs/detail?id=${jobId}&${q}`);
      expect(d.status, q).toBe(404);
      expect(await d.json()).toEqual({ error: 'version_not_found' });
      const dl = await get(`jobs/download?id=${jobId}&doc=cv&format=docx&${q}`);
      expect(dl.status, q).toBe(400);
      await dl.arrayBuffer();
    }
  });

  test('CORS allows only the web origins', async () => {
    const jobId = await addJob();
    for (const p of ['jobs/versions/edit', 'jobs/versions/restore']) {
      const pre = await fetch(`${N8N_URL}/webhook/api/${p}`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-jobhunter' },
      });
      expect(pre.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
      await pre.arrayBuffer();
    }
    const ok = await fetch(`${N8N_URL}/webhook/api/jobs/versions?id=${jobId}`, { headers: { Origin: 'http://localhost:8080' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:8080');
    await ok.arrayBuffer();
  });
});
