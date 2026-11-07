import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { CV, LETTER } from '../../services/worker/test/fixtures';
import { N8N_URL, SYNC_HEADERS, WEB_URL, db, makePdf, putDocument, resetState, stub } from './lib';

const OWNER = '00000000-0000-0000-0000-000000000001';
const EVIL = 'https://evil.example';
const APP = 'http://localhost:8080';
const GENERIC = 'Something went wrong while generating. Try again.';
const MISSING = '00000000-0000-0000-0000-0000000000ff';

const post = (path: string, body?: unknown, headers: Record<string, string> = SYNC_HEADERS) =>
  fetch(`${WEB_URL}/api/${path}`, {
    method: 'POST',
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (path: string) => fetch(`${WEB_URL}/api/${path}`);

async function addJob(over: Record<string, unknown> = {}): Promise<string> {
  const j = { title: 'Engineer', employer: 'Acme', advertiser: null, extraction_status: 'done', ...over };
  const [row] = await db.query(
    `insert into jobs (owner_id, source, source_ref, content_hash, raw_text, title, employer, advertiser, extraction_status, url)
     values ($1, 'folder', $2, 'h', 'The ad text', $3, $4, $5, $6, 'https://x.io/a') returning id`,
    [OWNER, `j-${Math.random()}.docx`, j.title, j.employer, j.advertiser, j.extraction_status],
  );
  return row.id;
}
const withCv = () => putDocument('cv', 'cv.pdf', makePdf('Base CV of Stub Person'));
const runs = (jobId: string) => db.query(`select * from generation_runs where job_id=$1`, [jobId]);

async function addVersion(jobId: string, runId: string | null = null, versionNo = 1): Promise<string> {
  const [v] = await db.query(
    `insert into document_versions (owner_id, job_id, run_id, version_no, label, base_cv_hash, template_id, cv, cover_letter,
       reasons, keyword_coverage, review, checks)
     values ($1,$2,$3,$4,'Generated','bh','standard-ats',$5,$6,$7,$8,$9,$10) returning id`,
    [
      OWNER, jobId, runId, versionNo,
      JSON.stringify(CV), JSON.stringify(LETTER),
      JSON.stringify({ templateReason: 'r', changes: [], stretches: [], factRulings: [] }),
      JSON.stringify([]), JSON.stringify({ passed: true }), JSON.stringify([]),
    ],
  );
  return v.id;
}

describe('job page API', () => {
  beforeEach(async () => {
    await resetState();
  });
  afterAll(async () => {
    await resetState();
  });

  test('generate queues one run and answers 202', async () => {
    await withCv();
    const jobId = await addJob();
    await stub.reset();
    const res = await post(`jobs/generate?id=${jobId}`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    expect(Object.keys(body)).toEqual(['runId']);
    const rows = await runs(jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: body.runId, status: 'pending', attempts: 0, owner_id: OWNER });
    expect(await stub.requests()).toEqual([]);
  });

  test('second generate while running is 409', async () => {
    await withCv();
    const jobId = await addJob();
    expect((await post(`jobs/generate?id=${jobId}`)).status).toBe(202);
    const second = await post(`jobs/generate?id=${jobId}`);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'generation_in_progress' });
    await db.query(`update generation_runs set status='in_progress'`);
    expect((await post(`jobs/generate?id=${jobId}`)).status).toBe(409);
    expect(await runs(jobId)).toHaveLength(1);
    // Two at once: exactly one wins.
    await db.query(`update generation_runs set status='done'`);
    const both = await Promise.all([post(`jobs/generate?id=${jobId}`), post(`jobs/generate?id=${jobId}`)]);
    expect(both.map((r) => r.status).sort()).toEqual([202, 409]);
    expect(await runs(jobId)).toHaveLength(2);
  });

  test('generate refused when not ready', async () => {
    const jobId = await addJob();
    await stub.reset();
    let res = await post(`jobs/generate?id=${jobId}`);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'base_cv_not_ready' });

    await withCv();
    const failed = await addJob({ extraction_status: 'failed' });
    await stub.reset();
    res = await post(`jobs/generate?id=${failed}`);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'job_not_ready' });

    expect(await db.query(`select id from generation_runs`)).toEqual([]);
    expect(await stub.requests()).toEqual([]);
  });

  test('generate: unknown or malformed job id is 404', async () => {
    await withCv();
    for (const id of [MISSING, 'nope', '']) {
      const res = await post(`jobs/generate?id=${id}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'job_not_found' });
    }
    expect(await db.query(`select id from generation_runs`)).toEqual([]);
  });

  test('state-changing endpoints need the header', async () => {
    await withCv();
    const jobId = await addJob();
    for (const [path, body] of [
      [`jobs/generate?id=${jobId}`, undefined],
      [`jobs/status?id=${jobId}`, { status: 'applied' }],
      [`jobs/notes?id=${jobId}`, { notes: 'x' }],
    ] as const) {
      for (const headers of [{}, { 'X-JobHunter': '0' }]) {
        const res = await post(path, body, headers);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'missing_jobhunter_header' });
      }
      // A cross-site text/plain POST (no preflight) is refused as well.
      const x = await fetch(`${N8N_URL}/webhook/api/${path}`, {
        method: 'POST',
        headers: { Origin: EVIL, 'Content-Type': 'text/plain' },
        body: '{"status":"applied","notes":"x"}',
      });
      expect(x.status).toBe(403);
      await x.arrayBuffer();
    }
    expect(await db.query(`select id from generation_runs`)).toEqual([]);
    expect(await db.query(`select status, company_notes from jobs`)).toEqual([{ status: 'new', company_notes: null }]);
    expect(await db.query(`select id from job_status_history`)).toEqual([]);
  });

  test('detail returns the latest version and its cost', async () => {
    await withCv();
    const jobId = await addJob();
    await db.query(`update jobs set company_notes='Met them at a meetup' where id=$1`, [jobId]);
    const [run] = await db.query(
      `insert into generation_runs (owner_id, job_id, status, stage, round, attempts) values ($1,$2,'done','saving',2,1) returning id`,
      [OWNER, jobId],
    );
    await addVersion(jobId, run.id, 1);
    const v2 = await addVersion(jobId, run.id, 2);
    await db.query(
      `insert into cost_log (owner_id, job_id, purpose, model, input_tokens, output_tokens, cost_usd, generation_run_id)
       values ($1,$2,'write_documents','m',1,1,0.25,$3), ($1,$2,'review_documents','m',1,1,0.125,$3), ($1,$2,'other','m',1,1,9,null)`,
      [OWNER, jobId, run.id],
    );
    const res = await get(`jobs/detail?id=${jobId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Object.keys(body).sort()).toEqual(['generation', 'job', 'version']);
    expect(Object.keys(body.job).sort()).toEqual([
      'advertiser', 'companyNotes', 'employer', 'id', 'matchBreakdown', 'matchExplanation', 'matchScore',
      'rawText', 'status', 'title', 'url', 'warnings',
    ]);
    expect(body.job).toMatchObject({
      id: jobId, title: 'Engineer', employer: 'Acme', rawText: 'The ad text', status: 'new',
      companyNotes: 'Met them at a meetup', url: 'https://x.io/a',
    });
    expect(body.generation).toEqual({ status: 'done', stage: 'saving', round: 2, attempts: 1, error: null });
    expect(Object.keys(body.version).sort()).toEqual([
      'baseCvSourceRef', 'checks', 'costUsd', 'coverLetter', 'createdAt', 'cv', 'id', 'keywordCoverage', 'label',
      'reasons', 'review', 'templateId', 'versionNo',
    ]);
    expect(body.version).toMatchObject({
      id: v2, versionNo: 2, label: 'Generated', templateId: 'standard-ats', cv: CV, coverLetter: LETTER,
      baseCvSourceRef: null, costUsd: 0.375,
    });
    expect(new Date(body.version.createdAt).toISOString()).toBe(body.version.createdAt);
  });

  test('detail: no run and no version are null; unknown job is 404', async () => {
    const jobId = await addJob();
    const body = (await (await get(`jobs/detail?id=${jobId}`)).json()) as any;
    expect(body.generation).toBeNull();
    expect(body.version).toBeNull();
    for (const id of [MISSING, 'nope']) {
      const res = await get(`jobs/detail?id=${id}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'job_not_found' });
    }
  });

  test('detail hides a match score from an older CV', async () => {
    await withCv();
    const jobId = await addJob();
    const [{ content_hash }] = await db.query(`select content_hash from base_documents where kind='cv' and active`);
    await db.query(
      `update jobs set match_score=80, match_explanation='good', match_breakdown='{"a":1}', match_basis_hash='old' where id=$1`,
      [jobId],
    );
    let job = ((await (await get(`jobs/detail?id=${jobId}`)).json()) as any).job;
    expect(job).toMatchObject({ matchScore: null, matchExplanation: null, matchBreakdown: null });
    await db.query(`update jobs set match_basis_hash=$2 where id=$1`, [jobId, content_hash]);
    job = ((await (await get(`jobs/detail?id=${jobId}`)).json()) as any).job;
    expect(job).toMatchObject({ matchScore: 80, matchExplanation: 'good', matchBreakdown: { a: 1 } });
  });

  test("detail shows only the workflow's own error messages", async () => {
    const jobId = await addJob();
    const [run] = await db.query(
      `insert into generation_runs (owner_id, job_id, status) values ($1,$2,'failed') returning id`,
      [OWNER, jobId],
    );
    const shown = [
      'Claude declined to write the documents.',
      'Claude declined to review the documents.',
      "Your base CV isn't ready.",
      'Generation stopped and gave up after 3 attempts.',
      'The request to Claude failed (HTTP 529).',
      'The request to Claude failed (no response).',
      'Claude stopped unexpectedly (pause_turn).',
    ];
    const hidden = [
      'connect ECONNREFUSED 172.18.0.4:5432 password=hunter2',
      'Generation hit an unexpected error (relation "x" does not exist).',
      'Claude stopped unexpectedly (<script>alert(1)</script>).',
    ];
    for (const e of shown) {
      await db.query(`update generation_runs set error=$2 where id=$1`, [run.id, e]);
      expect(((await (await get(`jobs/detail?id=${jobId}`)).json()) as any).generation.error).toBe(e);
    }
    for (const e of hidden) {
      await db.query(`update generation_runs set error=$2 where id=$1`, [run.id, e]);
      expect(((await (await get(`jobs/detail?id=${jobId}`)).json()) as any).generation.error).toBe(GENERIC);
    }
  });

  test('status change writes history; bad status 400', async () => {
    const jobId = await addJob();
    let res = await post(`jobs/status?id=${jobId}`, { status: 'applied' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'applied' });
    expect(await db.query(`select status from jobs`)).toEqual([{ status: 'applied' }]);
    expect(await db.query(`select from_status, to_status from job_status_history`)).toEqual([
      { from_status: 'new', to_status: 'applied' },
    ]);

    // Same status again: no new history row.
    res = await post(`jobs/status?id=${jobId}`, { status: 'applied' });
    expect(res.status).toBe(200);
    expect(await db.query(`select id from job_status_history`)).toHaveLength(1);

    // Any status is allowed from the UI, including going back.
    res = await post(`jobs/status?id=${jobId}`, { status: 'new' });
    expect(res.status).toBe(200);
    expect(await db.query(`select id from job_status_history`)).toHaveLength(2);

    for (const body of [{ status: 'hired' }, { status: 5 }, {}, { status: null }]) {
      res = await post(`jobs/status?id=${jobId}`, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_status' });
    }
    expect(await db.query(`select status from jobs`)).toEqual([{ status: 'new' }]);
    expect((await post(`jobs/status?id=${MISSING}`, { status: 'applied' })).status).toBe(404);
  });

  test('notes are saved; over 4000 characters is 400', async () => {
    const jobId = await addJob();
    let res = await post(`jobs/notes?id=${jobId}`, { notes: 'Ask about the team' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ notes: 'Ask about the team' });
    expect((await db.query(`select company_notes from jobs`))[0].company_notes).toBe('Ask about the team');
    expect(((await (await get(`jobs/detail?id=${jobId}`)).json()) as any).job.companyNotes).toBe('Ask about the team');

    res = await post(`jobs/notes?id=${jobId}`, { notes: 'x'.repeat(4000) });
    expect(res.status).toBe(200);
    for (const body of [{ notes: 'x'.repeat(4001) }, { notes: 5 }, {}]) {
      res = await post(`jobs/notes?id=${jobId}`, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_notes' });
    }
    expect((await db.query(`select char_length(company_notes) as n from jobs`))[0].n).toBe(4000);
    expect((await post(`jobs/notes?id=${MISSING}`, { notes: 'x' })).status).toBe(404);
  });

  test('download docx starts with PK, pdf with %PDF, file name sanitised', async () => {
    const jobId = await addJob({ employer: 'Acme/Co "Pty" Ltd é', advertiser: 'Recruiter' });
    await addVersion(jobId);
    for (const base of [WEB_URL + '/api', N8N_URL + '/webhook/api']) {
      const docx = await fetch(`${base}/jobs/download?id=${jobId}&doc=cv&format=docx`);
      expect(docx.status).toBe(200);
      expect(docx.headers.get('content-type')).toBe(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );
      expect(docx.headers.get('content-disposition')).toBe(
        `attachment; filename="Jordan Testcase - CV - AcmeCo Pty Ltd.docx"; filename*=UTF-8''Jordan%20Testcase%20-%20CV%20-%20AcmeCo%20Pty%20Ltd.docx`,
      );
      const bytes = Buffer.from(await docx.arrayBuffer());
      expect(bytes.subarray(0, 2).toString()).toBe('PK');
      expect(bytes.length).toBeGreaterThan(1000);

      const pdf = await fetch(`${base}/jobs/download?id=${jobId}&doc=cover_letter&format=pdf`);
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get('content-type')).toBe('application/pdf');
      expect(pdf.headers.get('content-disposition')).toContain(
        'filename="Jordan Testcase - Cover letter - AcmeCo Pty Ltd.pdf"',
      );
      expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');
    }
  }, 60_000);

  test('download name: advertiser, then "Job"; at most 100 characters before the extension', async () => {
    const a = await addJob({ employer: null, advertiser: 'Hays' });
    const b = await addJob({ employer: null, advertiser: null });
    const c = await addJob({ employer: 'E'.repeat(200) });
    for (const id of [a, b, c]) await addVersion(id);
    const name = async (id: string) =>
      /filename="([^"]*)"/.exec(
        (await get(`jobs/download?id=${id}&doc=cv&format=docx`)).headers.get('content-disposition')!,
      )![1];
    expect(await name(a)).toBe('Jordan Testcase - CV - Hays.docx');
    expect(await name(b)).toBe('Jordan Testcase - CV - Job.docx');
    const long = await name(c);
    expect(long.endsWith('.docx')).toBe(true);
    expect(long.length - '.docx'.length).toBe(100);
  }, 60_000);

  test('download without a version is 404; bad parameters are 400', async () => {
    const jobId = await addJob();
    let res = await get(`jobs/download?id=${jobId}&doc=cv&format=docx`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_version' });
    await addVersion(jobId);
    for (const q of [
      `id=${jobId}&doc=letter&format=docx`,
      `id=${jobId}&doc=cv&format=odt`,
      `id=${jobId}&doc=cv`,
      `id=nope&doc=cv&format=pdf`,
      `doc=cv&format=pdf`,
    ]) {
      res = await get(`jobs/download?${q}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
    res = await get(`jobs/download?id=${MISSING}&doc=cv&format=pdf`);
    expect(res.status).toBe(404);
  });

  test('jobs list carries generation and hasVersion', async () => {
    const plain = await addJob({ title: 'Plain' });
    const gen = await addJob({ title: 'Generated' });
    await db.query(
      `insert into generation_runs (owner_id, job_id, status, stage, round, created_at) values ($1,$2,'failed','writing',1, now() - interval '1 hour')`,
      [OWNER, gen],
    );
    await db.query(
      `insert into generation_runs (owner_id, job_id, status, stage, round) values ($1,$2,'in_progress','reviewing',2)`,
      [OWNER, gen],
    );
    await addVersion(gen);
    const list = ((await (await get('jobs')).json()) as any).jobs;
    const byId = Object.fromEntries(list.map((j: any) => [j.id, j]));
    expect(byId[plain]).toMatchObject({ generation: null, hasVersion: false });
    expect(byId[gen]).toMatchObject({
      generation: { status: 'in_progress', stage: 'reviewing', round: 2 },
      hasVersion: true,
    });
  });

  test('CORS allows only the web origins', async () => {
    const jobId = await addJob();
    for (const base of [WEB_URL + '/api', N8N_URL + '/webhook/api']) {
      for (const p of ['jobs/generate', 'jobs/status', 'jobs/notes']) {
        const pre = await fetch(`${base}/${p}`, {
          method: 'OPTIONS',
          headers: { Origin: EVIL, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-jobhunter' },
        });
        expect(pre.headers.get('access-control-allow-origin')).not.toBe(EVIL);
        expect(pre.headers.get('access-control-allow-origin')).not.toBe('*');
        await pre.arrayBuffer();
      }
      for (const p of [`jobs/detail?id=${jobId}`, `jobs/download?id=${jobId}&doc=cv&format=pdf`]) {
        const res = await fetch(`${base}/${p}`, { headers: { Origin: EVIL } });
        expect(res.headers.get('access-control-allow-origin')).not.toBe(EVIL);
        expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
        await res.arrayBuffer();
      }
    }
    const ok = await fetch(`${N8N_URL}/webhook/api/jobs/detail?id=${jobId}`, { headers: { Origin: APP } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(APP);
    await ok.arrayBuffer();
    const pre = await fetch(`${N8N_URL}/webhook/api/jobs/status`, {
      method: 'OPTIONS',
      headers: { Origin: APP, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-jobhunter,content-type' },
    });
    expect(pre.headers.get('access-control-allow-origin')).toBe(APP);
    await pre.arrayBuffer();
  });
});
