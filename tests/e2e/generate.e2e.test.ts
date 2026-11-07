import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  N8N_URL,
  ROOT,
  db,
  makePdf,
  putDocument,
  resetState,
  stub,
  triggerGeneration,
  triggerSync,
  writeJobFile,
} from './lib';

const OWNER = '00000000-0000-0000-0000-000000000001';
const normalise = (s: string) => s.replace(/\r\n/g, '\n').trim();
const promptFile = (name: string) => readFileSync(join(ROOT, 'n8n', 'prompts', name), 'utf8');
const WRITER_PROMPT = promptFile('write-documents.md');
const REVIEW_PROMPT = promptFile('review-documents.md');

const purposeOf = (body: any) => String(body.system ?? '').split(/\r?\n/)[0];
const requestsFor = async (purpose: string) =>
  (await stub.requests()).filter((b) => purposeOf(b) === `purpose: ${purpose}`);
const writerRequests = () => requestsFor('write_documents');
const reviewRequests = () => requestsFor('review_documents');
/** Everything a recorded request sent as user content, as text (the test PDF is plain text). */
const sentText = (body: any): string =>
  body.messages[0].content
    .map((c: any) => (c.type === 'document' ? Buffer.from(c.source.data, 'base64').toString('latin1') : c.text))
    .join('\n');
const tag = (text: string, name: string) => {
  const m = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text);
  if (!m) throw new Error(`no <${name}> in request`);
  return m[1];
};

const runRow = async (id: string) => (await db.query(`select * from generation_runs where id=$1`, [id]))[0];
const versions = (jobId: string) =>
  db.query(`select * from document_versions where job_id=$1 order by version_no`, [jobId]);
const jobRow = async (id: string) => (await db.query(`select * from jobs where id=$1`, [id]))[0];
const waitFor = async (ok: () => Promise<boolean>, ms = 20_000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out waiting');
};

/** An analysed base CV and one extracted job. Returns the job id. */
async function readyJob(): Promise<string> {
  await putDocument('cv', 'cv.pdf', makePdf('Base CV of Stub Person'));
  await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'We need a TypeScript engineer.' }]);
  await triggerSync();
  const [job] = await db.query(`select id, extraction_status from jobs where source_ref='a.docx'`);
  expect(job.extraction_status).toBe('done');
  return job.id;
}

/** What a Generate click records (Task 6's API does the same insert). */
async function queueRun(jobId: string): Promise<string> {
  const [run] = await db.query(`insert into generation_runs (owner_id, job_id) values ($1, $2) returning id`, [OWNER, jobId]);
  return run.id;
}

/** The stub's canned answers, read once before the tests start (each test's reset clears this call's record). */
const CANNED: Record<string, any> = {};
const canned = async (purpose: string) => CANNED[purpose];
const askStub = async (purpose: string) => {
  const res = await fetch('http://localhost:58081/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': 'k', 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', system: `purpose: ${purpose}`, messages: [{ role: 'user', content: 'x' }] }),
  });
  return JSON.parse(((await res.json()) as any).content[0].text);
};

describe('generate documents', () => {
  beforeAll(async () => {
    for (const p of ['write_documents', 'review_documents']) CANNED[p] = await askStub(p);
    await stub.reset();
  });
  beforeEach(async () => {
    await resetState();
  });
  afterAll(async () => {
    await resetState();
  });

  test('webhook without X-JobHunter header is refused and runs nothing', async () => {
    const jobId = await readyJob();
    const runId = await queueRun(jobId);
    await stub.reset();
    const res = await fetch(`${N8N_URL}/webhook/api/generation/run`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'missing_jobhunter_header' });
    expect(await runRow(runId)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await stub.requests()).toEqual([]);
  });

  test('generates and saves version 1 with status cv ready', async () => {
    const jobId = await readyJob();
    const runId = await queueRun(jobId);
    await stub.reset();
    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 1 });

    expect(await runRow(runId)).toMatchObject({ status: 'done', attempts: 1, round: 1, error: null });
    const run = await runRow(runId);
    expect(run.rounds).toHaveLength(1);
    expect(run.rounds[0]).toMatchObject({ round: 1, passed: true, review: { verdict: 'pass' } });

    const [v, ...more] = await versions(jobId);
    expect(more).toEqual([]);
    const writer = await canned('write_documents');
    const [cv] = await db.query(`select id, content_hash from base_documents where kind='cv' and active`);
    expect(v).toMatchObject({
      owner_id: OWNER,
      run_id: runId,
      version_no: 1,
      label: 'Generated',
      base_cv_id: cv.id,
      base_cv_hash: cv.content_hash,
      base_cover_letter_id: null,
      template_id: 'standard-ats',
      cv: writer.cv,
      cover_letter: writer.coverLetter,
      keyword_coverage: writer.keywordCoverage,
      manual_edit: false,
    });
    expect(v.review).toMatchObject({ passed: true, rounds: 1, verdicts: ['pass'] });
    // The base CV has no work-rights line: that warning stays visible.
    expect(v.review.unresolved).toEqual([expect.objectContaining({ code: 'missing_work_rights', severity: 'warning' })]);
    expect(v.reasons).toEqual({
      templateReason: writer.templateReason,
      changes: writer.changes,
      stretches: [],
      factRulings: [],
    });
    expect(Array.isArray(v.checks)).toBe(true);
    expect(v.checks.filter((c: any) => c.severity === 'hard')).toEqual([]);

    expect(await jobRow(jobId)).toMatchObject({ status: 'cv_ready' });
    expect(await db.query(`select from_status, to_status from job_status_history where job_id=$1 order by changed_at`, [jobId])).toEqual([
      { from_status: null, to_status: 'new' },
      { from_status: 'new', to_status: 'cv_ready' },
    ]);
    expect(await writerRequests()).toHaveLength(1);
    expect(await reviewRequests()).toHaveLength(1);
  });

  test('writer and reviewer requests: models, limits, fallbacks and inputs', async () => {
    const jobId = await readyJob();
    await db.query(`update jobs set company_notes='Notes about the company.' where id=$1`, [jobId]);
    await putDocument('cover_letter', 'cl.pdf', makePdf('Base cover letter'));
    await queueRun(jobId);
    await stub.reset();
    await triggerGeneration();
    const log = await stub.requestLog();
    const writer = log.filter((r) => purposeOf(r.body) === 'purpose: write_documents');
    const review = log.filter((r) => purposeOf(r.body) === 'purpose: review_documents');
    expect(writer).toHaveLength(1);
    expect(review).toHaveLength(1);

    const w = writer[0];
    expect(w.headers['anthropic-version']).toBe('2026-10-21');
    expect(w.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(w.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000, fallbacks: 'default' });
    expect(w.body.output_config).toEqual({ effort: 'medium', format: { type: 'json_schema', schema: JSON.parse(promptFile('write-documents.schema.json')) } });
    expect(normalise(w.body.system)).toBe(normalise(WRITER_PROMPT));
    const r = review[0];
    expect(r.headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(r.body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 8000, fallbacks: 'default' });
    expect(r.body.output_config).toEqual({ effort: 'medium', format: { type: 'json_schema', schema: JSON.parse(promptFile('review-documents.schema.json')) } });
    expect(normalise(r.body.system)).toBe(normalise(REVIEW_PROMPT));

    for (const { body } of [w, r]) {
      for (const key of ['thinking', 'temperature', 'top_p', 'top_k']) expect(body).not.toHaveProperty(key);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe('user'); // no prefill
      // The base CV as uploaded: a PDF document block first.
      expect(body.messages[0].content[0]).toEqual({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: makePdf('Base CV of Stub Person').toString('base64') },
      });
      const text = sentText(body);
      expect(tag(text, 'job_ad')).toBe('We need a TypeScript engineer.');
      expect(JSON.parse(tag(text, 'job_facts'))).toMatchObject({ title: 'Stub Title', employer: 'Stub Employer', advertiser: null });
      const [cv] = await db.query(`select structured from base_documents where kind='cv' and active`);
      expect(JSON.parse(tag(text, 'base_cv_facts'))).toEqual(cv.structured);
      // The base cover letter goes only as its analysis.
      expect(JSON.parse(tag(text, 'base_cover_letter'))).toEqual({
        previousTarget: { company: 'Stub Company', addressee: null, role: 'Stub Role' },
        reusableParagraphs: ['Stub paragraph.'],
        toneNotes: 'Stub tone.',
      });
      expect(text).not.toContain('Base cover letter');
      expect(tag(text, 'company_notes')).toBe('Notes about the company.');
    }
    expect(sentText(w.body)).not.toContain('<previous_round>');
    // The reviewer gets the writer's output and the code checks.
    const docs = JSON.parse(tag(sentText(r.body), 'documents'));
    expect(docs).toEqual(await canned('write_documents'));
    const checks = JSON.parse(tag(sentText(r.body), 'code_checks'));
    expect(checks).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_work_rights' })]));
    const [v] = await versions(jobId);
    const [cl] = await db.query(`select id, content_hash from base_documents where kind='cover_letter' and active`);
    expect(v).toMatchObject({ base_cover_letter_id: cl.id, base_cover_letter_hash: cl.content_hash });
  });

  test('reviewer never sees the writer prompt, and the writer never sees the reviewer prompt', async () => {
    const jobId = await readyJob();
    await queueRun(jobId);
    await stub.reset();
    await triggerGeneration();
    const [w] = await writerRequests();
    const [r] = await reviewRequests();
    const writerFirst = WRITER_PROMPT.split(/\r?\n/)[0];
    const reviewFirst = REVIEW_PROMPT.split(/\r?\n/)[0];
    const writerLine = WRITER_PROMPT.split(/\r?\n/).find((l) => l.startsWith('You write a tailored CV'))!;
    const reviewLine = REVIEW_PROMPT.split(/\r?\n/).find((l) => l.startsWith('You are a senior Australian recruiter'))!;
    expect(writerLine).toBeTruthy();
    expect(reviewLine).toBeTruthy();
    expect(JSON.stringify(r)).not.toContain(writerFirst);
    expect(JSON.stringify(r)).not.toContain(writerLine.slice(0, 60));
    expect(JSON.stringify(w)).not.toContain(reviewFirst);
    expect(JSON.stringify(w)).not.toContain(reviewLine.slice(0, 60));
  });

  test('a failed review triggers a revision with the objections', async () => {
    const jobId = await readyJob();
    const runId = await queueRun(jobId);
    const pass = await canned('review_documents');
    const fail = {
      ...pass,
      verdict: 'fail',
      items: pass.items.map((i: any) => (i.id === 'ai_sounding' ? { ...i, pass: false, note: 'The summary reads as generated.' } : i)),
      objections: [{ target: 'cv.summary', problem: 'OBJECTION_7731 the summary sounds generated.', fix: 'Say it plainly.' }],
    };
    await stub.reset();
    await stub.scriptPurpose('review_documents', [fail]);
    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 1 });

    const writes = await writerRequests();
    expect(writes).toHaveLength(2);
    expect(await reviewRequests()).toHaveLength(2);
    expect(sentText(writes[0])).not.toContain('<previous_round>');
    const previous = JSON.parse(tag(sentText(writes[1]), 'previous_round'));
    expect(JSON.stringify(previous)).toContain('OBJECTION_7731');
    expect(previous.documents).toEqual(await canned('write_documents'));
    expect(previous.objections).toEqual(fail.objections);
    expect(previous.failedItems).toEqual([{ id: 'ai_sounding', pass: false, note: 'The summary reads as generated.' }]);

    const run = await runRow(runId);
    expect(run).toMatchObject({ status: 'done', round: 2 });
    expect(run.rounds.map((r: any) => [r.round, r.passed])).toEqual([[1, false], [2, true]]);
    const [v] = await versions(jobId);
    expect(v.review).toMatchObject({ passed: true, rounds: 2, verdicts: ['fail', 'pass'] });
  });

  test('stops after max rounds and keeps the best', async () => {
    const jobId = await readyJob();
    const runId = await queueRun(jobId);
    const base = await canned('write_documents');
    // Far too many bullets for one page, every round.
    const long = {
      ...base,
      cv: {
        ...base.cv,
        experience: [{ ...base.cv.experience[0], bullets: Array.from({ length: 90 }, () => 'Led a team of 5 and built a stub in TypeScript for the team.') }],
      },
    };
    await stub.reset();
    await stub.scriptPurpose('write_documents', [long, long, long, long]);
    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 1 });

    expect(await writerRequests()).toHaveLength(3);
    expect(await reviewRequests()).toHaveLength(3);
    const run = await runRow(runId);
    expect(run).toMatchObject({ status: 'done', round: 3 });
    expect(run.rounds.map((r: any) => r.passed)).toEqual([false, false, false]);
    const [v, ...more] = await versions(jobId);
    expect(more).toEqual([]);
    expect(v.review).toMatchObject({ passed: false, rounds: 3, verdicts: ['pass', 'pass', 'pass'] });
    expect(v.review.unresolved).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'cv_pages', severity: 'hard', detail: expect.stringMatching(/2 pages|[3-9] pages/) })]),
    );
    expect(v.cv.experience[0].bullets).toHaveLength(90);
    // The best version is still saved, so the job shows it (with what is unresolved).
    expect(await jobRow(jobId)).toMatchObject({ status: 'cv_ready' });
  });

  test('status stays applied when already applied', async () => {
    const jobId = await readyJob();
    await db.query(`update jobs set status='applied' where id=$1`, [jobId]);
    await queueRun(jobId);
    await stub.reset();
    await triggerGeneration();
    expect(await versions(jobId)).toHaveLength(1);
    expect(await jobRow(jobId)).toMatchObject({ status: 'applied' });
    expect(await db.query(`select to_status from job_status_history where job_id=$1`, [jobId])).toEqual([{ to_status: 'new' }]);
  });

  test('a second generation is version 2', async () => {
    const jobId = await readyJob();
    await queueRun(jobId);
    await triggerGeneration();
    await queueRun(jobId);
    await triggerGeneration();
    expect((await versions(jobId)).map((v) => v.version_no)).toEqual([1, 2]);
    expect(await db.query(`select to_status from job_status_history where job_id=$1 order by changed_at`, [jobId])).toEqual([
      { to_status: 'new' },
      { to_status: 'cv_ready' },
    ]);
  });

  test('lost claim stops the old execution', async () => {
    const jobId = await readyJob();
    const runId = await queueRun(jobId);
    await stub.reset();
    await stub.delayPurpose('write_documents', 8000);
    const running = triggerGeneration();
    await waitFor(async () => (await writerRequests()).length === 1);
    // Another execution reclaims the run while the writer call is still out.
    const [taken] = await db.query(
      `update generation_runs set claimed_at = now() + interval '1 hour', attempts = attempts + 1, stage = 'queued', round = 0
       where id=$1 returning *`,
      [runId],
    );
    expect(await running).toEqual({ ok: true, claimed: 1 });

    // The old execution wrote nothing after it lost the claim...
    const after = await runRow(runId);
    expect(after).toEqual(taken);
    expect(await versions(jobId)).toEqual([]);
    expect(await jobRow(jobId)).toMatchObject({ status: 'new' });
    expect(await reviewRequests()).toEqual([]);
    // ...but the writer call it already made is real spend, so it is logged.
    const costs = await db.query(`select purpose, job_id, generation_run_id from cost_log where generation_run_id is not null`);
    expect(costs).toEqual([{ purpose: 'write_documents', job_id: jobId, generation_run_id: runId }]);
  });

  test('a claim lost during the review records no round', async () => {
    const jobId = await readyJob();
    const runId = await queueRun(jobId);
    await stub.reset();
    await stub.delayPurpose('review_documents', 6000);
    const running = triggerGeneration();
    await waitFor(async () => (await reviewRequests()).length === 1);
    const [taken] = await db.query(
      `update generation_runs set claimed_at = now() + interval '1 hour', attempts = attempts + 1 where id=$1 returning *`,
      [runId],
    );
    expect(taken).toMatchObject({ stage: 'reviewing', round: 1, rounds: [] });
    expect(await running).toEqual({ ok: true, claimed: 1 });
    expect(await runRow(runId)).toEqual(taken);
    expect(await versions(jobId)).toEqual([]);
    expect(await writerRequests()).toHaveLength(1);
    const costs = await db.query(`select purpose from cost_log where generation_run_id=$1 order by created_at`, [runId]);
    expect(costs.map((c) => c.purpose)).toEqual(['write_documents', 'review_documents']);
  });

  test('documents the worker rejects fail the attempt before any review', async () => {
    const jobId = await readyJob();
    const runId = await queueRun(jobId);
    const base = await canned('write_documents');
    await stub.reset();
    await stub.scriptPurpose('write_documents', [{ ...base, cv: { name: 'Stub Person' } }]);
    await triggerGeneration();
    expect(await runRow(runId)).toMatchObject({ status: 'pending', attempts: 1, error: "The writer's documents were not in the expected format." });
    expect(await reviewRequests()).toEqual([]);
    expect(await versions(jobId)).toEqual([]);
  });

  test('a stuck run is handed back and done by a later run', async () => {
    const jobId = await readyJob();
    const runId = await queueRun(jobId);
    await db.query(
      `update generation_runs set status='in_progress', attempts=1, claimed_at=now() - interval '7 minutes', stage='writing', round=1 where id=$1`,
      [runId],
    );
    await stub.reset();
    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 0 }); // handed back, but waits a minute after attempt 1
    expect(await runRow(runId)).toMatchObject({ status: 'pending', attempts: 1, stage: 'queued' });
    expect(await stub.requests()).toEqual([]);
    await db.query(`update generation_runs set updated_at = updated_at - interval '2 minutes' where id=$1`, [runId]);
    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 1 });
    expect(await runRow(runId)).toMatchObject({ status: 'done', attempts: 2 });
    expect(await versions(jobId)).toHaveLength(1);
  });

  test('a stuck run with all 3 attempts used gives up, no Claude call', async () => {
    const jobId = await readyJob();
    const runId = await queueRun(jobId);
    await db.query(
      `update generation_runs set status='in_progress', attempts=3, claimed_at=now() - interval '7 minutes', stage='reviewing', round=2 where id=$1`,
      [runId],
    );
    await stub.reset();
    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 0 });
    expect(await runRow(runId)).toMatchObject({ status: 'failed', attempts: 3, error: 'Generation stopped and gave up after 3 attempts.' });
    expect(await stub.requests()).toEqual([]);
  });

  test('a run claimed less than 6 minutes ago is left alone', async () => {
    const jobId = await readyJob();
    const runId = await queueRun(jobId);
    await db.query(
      `update generation_runs set status='in_progress', attempts=1, claimed_at=now() - interval '5 minutes' where id=$1`,
      [runId],
    );
    await stub.reset();
    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 0 });
    expect(await runRow(runId)).toMatchObject({ status: 'in_progress', attempts: 1 });
    expect(await stub.requests()).toEqual([]);
  });

  test('api error retries with backoff then fails after 3', async () => {
    const jobId = await readyJob();
    const runId = await queueRun(jobId);
    await stub.reset();
    await stub.failPurpose('write_documents');
    const age = (by: string) =>
      db.query(`update generation_runs set updated_at = updated_at - $1::interval where id=$2`, [by, runId]);

    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 1 });
    expect(await runRow(runId)).toMatchObject({ status: 'pending', attempts: 1, stage: 'queued', error: expect.stringMatching(/HTTP 500/) });
    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 0 }); // within a minute of attempt 1
    expect(await writerRequests()).toHaveLength(1);
    await age('2 minutes');
    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 1 });
    expect(await writerRequests()).toHaveLength(2);
    expect(await runRow(runId)).toMatchObject({ status: 'pending', attempts: 2 });
    await age('2 minutes'); // under 5 minutes after attempt 2
    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 0 });
    await age('4 minutes');
    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 1 });
    expect(await writerRequests()).toHaveLength(3);
    expect(await runRow(runId)).toMatchObject({ status: 'failed', attempts: 3, error: expect.stringMatching(/HTTP 500/) });
    await age('1 hour');
    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 0 });
    expect(await writerRequests()).toHaveLength(3);
    expect(await reviewRequests()).toEqual([]);
    expect(await versions(jobId)).toEqual([]);
    // A 500 reports no usage, so nothing is logged as cost.
    expect(await db.query(`select id from cost_log where generation_run_id is not null`)).toEqual([]);
  });

  test('an invalid reviewer answer fails the attempt and its cost is logged', async () => {
    const jobId = await readyJob();
    const runId = await queueRun(jobId);
    await stub.reset();
    await stub.scriptPurpose('review_documents', [{ not: 'a review' }]);
    await triggerGeneration();
    expect(await runRow(runId)).toMatchObject({ status: 'pending', attempts: 1, error: expect.stringMatching(/expected format/) });
    expect(await versions(jobId)).toEqual([]);
    expect((await db.query(`select purpose from cost_log where generation_run_id=$1 order by created_at`, [runId])).map((c) => c.purpose)).toEqual([
      'write_documents',
      'review_documents',
    ]);
  });

  test('costs logged per call with run id', async () => {
    const jobId = await readyJob();
    const runId = await queueRun(jobId);
    await stub.reset();
    await triggerGeneration();
    const costs = await db.query(
      `select purpose, model, input_tokens, output_tokens, cost_usd, job_id, generation_run_id, base_document_id from cost_log
       where generation_run_id is not null order by created_at`,
    );
    expect(costs.map((c) => ({ ...c, cost_usd: Number(c.cost_usd) }))).toEqual([
      // 1000 in × $4 + 100 out × $20 per 1M (Opus); 1000 × $2 + 100 × $10 (Sonnet)
      { purpose: 'write_documents', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 100, cost_usd: 0.006, job_id: jobId, generation_run_id: runId, base_document_id: null },
      { purpose: 'review_documents', model: 'claude-sonnet-5-5', input_tokens: 1000, output_tokens: 100, cost_usd: 0.003, job_id: jobId, generation_run_id: runId, base_document_id: null },
    ]);
  });

  test('base CV not ready fails the run without a Claude call', async () => {
    const jobId = await readyJob();
    const runId = await queueRun(jobId);
    await db.query(`update base_documents set analysis_status='pending' where kind='cv'`);
    await stub.reset();
    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 1 });
    expect(await runRow(runId)).toMatchObject({ status: 'failed', error: "Your base CV isn't ready." });
    expect(await stub.requests()).toEqual([]);
    expect(await versions(jobId)).toEqual([]);
  });

  test('a base CV replaced since its analysis is not ready', async () => {
    const jobId = await readyJob();
    const runId = await queueRun(jobId);
    // The stored file no longer matches the analysed content.
    await db.query(`update base_documents set content_hash='something-else' where kind='cv'`);
    await stub.reset();
    await triggerGeneration();
    expect(await runRow(runId)).toMatchObject({ status: 'failed', error: "Your base CV isn't ready." });
    expect(await stub.requests()).toEqual([]);
  });

  test('nothing runs without a pending run', async () => {
    const jobId = await readyJob();
    await stub.reset();
    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 0 });
    // Finished runs are never picked up again.
    const done = await queueRun(jobId);
    await db.query(`update generation_runs set status='done' where id=$1`, [done]);
    const failed = await queueRun(jobId);
    await db.query(`update generation_runs set status='failed', attempts=3, updated_at=now() - interval '1 day' where id=$1`, [failed]);
    expect(await triggerGeneration()).toEqual({ ok: true, claimed: 0 });
    expect(await stub.requests()).toEqual([]);
    expect(await versions(jobId)).toEqual([]);
  });

  test('one run per execution, oldest first; overlapping executions never share a run', async () => {
    const jobA = await readyJob();
    await writeJobFile('b.docx', [{ text: 'https://x.io/b' }, { text: 'Another TypeScript role.' }]);
    await triggerSync();
    const [{ id: jobB }] = await db.query(`select id from jobs where source_ref='b.docx'`);
    const runA = await queueRun(jobA);
    const runB = await queueRun(jobB);
    await stub.reset();
    const results = await Promise.all([triggerGeneration(), triggerGeneration(), triggerGeneration()]);
    expect(results.map((r) => r.claimed).sort()).toEqual([0, 1, 1]);
    for (const id of [runA, runB]) expect(await runRow(id)).toMatchObject({ status: 'done', attempts: 1 });
    expect(await writerRequests()).toHaveLength(2);
  });

  // Checks on the workflow JSON itself, for behaviour the fixed test env cannot reach.
  describe('workflow definition', () => {
    const wf = JSON.parse(readFileSync(join(ROOT, 'n8n', 'workflows', 'generate-documents.json'), 'utf8'));
    const nodeByName = (name: string) => {
      const node = wf.nodes.find((n: { name: string }) => n.name === name);
      if (!node) throw new Error(`no node "${name}"`);
      return node;
    };
    const parentsOf = (name: string) =>
      Object.entries(wf.connections as Record<string, { main: { node: string }[][] }>)
        .filter(([, c]) => c.main.flat().some((t) => t.node === name))
        .map(([from]) => from);
    const ancestorsOf = (name: string, seen = new Set<string>()): Set<string> => {
      for (const p of parentsOf(name)) if (!seen.has(p)) ancestorsOf(p, seen.add(p));
      return seen;
    };
    const code = (name: string) => nodeByName(name).parameters.jsCode as string;
    const ENV = { WRITER_MODEL: 'claude-opus-5-5', REVIEW_MODEL: 'claude-sonnet-5-5', GENERATION_MAX_ROUNDS: '3' };
    const runPriceLookup = (env: Record<string, string | undefined>) => new Function('$env', code('Look up model prices'))(env);
    const prices = () => runPriceLookup(ENV)[0];
    const values = () =>
      Object.fromEntries(nodeByName('Writer and reviewer prompts').parameters.assignments.assignments.map((a: any) => [a.name, a.value]));

    test('stable id, webhook path, CORS origins, gate first and no saved successful runs', () => {
      expect(wf.id).toBe('jh-generate-documents');
      const hook = nodeByName('POST api/generation/run');
      expect(hook.parameters).toMatchObject({
        httpMethod: 'POST',
        path: 'api/generation/run',
        responseMode: 'responseNode',
        options: { allowedOrigins: 'http://localhost:8080,http://localhost:5173' },
      });
      expect(wf.connections['POST api/generation/run'].main).toEqual([[{ node: 'Has X-JobHunter header?', type: 'main', index: 0 }]]);
      expect(nodeByName('Has X-JobHunter header?').parameters.conditions.conditions[0]).toMatchObject({
        leftValue: "={{ $json.headers['x-jobhunter'] }}",
        rightValue: '1',
      });
      expect(nodeByName('Schedule enabled?').parameters.conditions.conditions[0].leftValue).toBe('={{ $env.JOBHUNTER_SCHEDULE_ENABLED }}');
      expect(nodeByName('Every 30 seconds').parameters.rule.interval[0]).toEqual({ field: 'seconds', secondsInterval: 30 });
      expect(parentsOf('Give up on stuck runs').sort()).toEqual(['Has X-JobHunter header?', 'Schedule enabled?']);
      expect(wf.settings).toMatchObject({ saveDataSuccessExecution: 'none', saveManualExecutions: false });
    });

    test('unknown model stops the run before anything is claimed or Claude is called', () => {
      expect(() => runPriceLookup({ ...ENV, WRITER_MODEL: 'claude-unknown-9' })).toThrow(/No price for model "claude-unknown-9" \(WRITER_MODEL\)/);
      expect(() => runPriceLookup({ ...ENV, REVIEW_MODEL: 'claude-unknown-8' })).toThrow(/No price for model "claude-unknown-8" \(REVIEW_MODEL\)/);
      expect(prices().json).toMatchObject({
        writer: { model: 'claude-opus-5-5', input_usd_per_mtok: 4, output_usd_per_mtok: 20, fallbacks: true },
        reviewer: { model: 'claude-sonnet-5-5', input_usd_per_mtok: 2, output_usd_per_mtok: 10, fallbacks: true },
        max_rounds: 3,
      });
      expect(runPriceLookup({ ...ENV, REVIEW_MODEL: 'claude-haiku-5-5' })[0].json.reviewer.fallbacks).toBe(false);
      expect(ancestorsOf('Claim one run').has('Look up model prices')).toBe(true);
      expect(ancestorsOf('Look up model prices').has('Claim one run')).toBe(false);
      for (const call of ['Ask Claude to write', 'Ask Claude to review']) expect(ancestorsOf(call).has('Claim one run')).toBe(true);
    });

    test('max rounds defaults to 3 and is kept between 1 and 5', () => {
      const max = (v: string | undefined) => runPriceLookup({ ...ENV, GENERATION_MAX_ROUNDS: v })[0].json.max_rounds;
      expect(max(undefined)).toBe(3);
      expect(max('')).toBe(3);
      expect(max('abc')).toBe(3);
      expect(max('1')).toBe(1);
      expect(max('2')).toBe(2);
      expect(max('0')).toBe(3);
      expect(max('50')).toBe(5);
    });

    test('the claim takes one due run, oldest first, inside the locked subquery, and resets the rounds', () => {
      const q: string = nodeByName('Claim one run').parameters.query;
      expect(q).toMatch(/order by r\.created_at, r\.id\s+limit 1\s+for update of r skip locked/);
      expect(q).toMatch(/interval '1 minute'/);
      expect(q).toMatch(/interval '5 minutes'/);
      expect(q).toMatch(/rounds = '\[\]'/);
      expect(q).toMatch(/claimed_at::text as claimed_at/);
      expect(nodeByName('Give up on stuck runs').parameters.query).toMatch(/interval '6 minutes'/);
    });

    test('every write after the claim is guarded by the claim token', () => {
      for (const name of ['Heartbeat: writing', 'Heartbeat: checking', 'Heartbeat: reviewing', 'Record the round', 'Save version', 'Mark attempt failed']) {
        expect(nodeByName(name).parameters.query, name).toMatch(/claimed_at = \$2::timestamptz/);
        expect(nodeByName(name).parameters.query, name).toMatch(/status = 'in_progress'/);
      }
      // Each paid call comes straight after a heartbeat that confirmed the claim.
      expect(parentsOf('Build writer request')).toEqual(['Still our claim? (writing)']);
      expect(parentsOf('Still our claim? (writing)')).toEqual(['Heartbeat: writing']);
      expect(parentsOf('Build review request')).toEqual(['Still our claim? (reviewing)']);
      expect(parentsOf('Still our claim? (reviewing)')).toEqual(['Heartbeat: reviewing']);
      expect(parentsOf('Choose the version to save')).toEqual(['Another round?']);
      // The loop goes back to the writing heartbeat only.
      expect(parentsOf('Heartbeat: writing').sort()).toEqual(['Another round?', 'Inputs ready?']);
    });

    test('Claude calls finish well inside the 6-minute stuck window', () => {
      for (const name of ['Ask Claude to write', 'Ask Claude to review']) {
        expect(nodeByName(name).parameters.options.timeout).toBe(280_000);
      }
      expect(nodeByName('Run code checks').parameters.options.timeout).toBeLessThanOrEqual(60_000);
    });

    test('cost rows carry the run id and are not guarded (the spend is real)', () => {
      for (const name of ['Log writer cost', 'Log review cost']) {
        const q = nodeByName(name).parameters.query;
        expect(q).toMatch(/generation_run_id/);
        expect(q).not.toMatch(/claimed_at/);
      }
    });

    const readAnswer = (node: string, state: object, res: object) =>
      new Function('$json', '$', code(node))(res, (name: string) => ({
        first: () => (name === 'Look up model prices' ? prices() : { json: state }),
      })).json;
    const envelope = (a: unknown, extra: object = {}) => ({
      statusCode: 200,
      body: {
        model: 'claude-opus-5-5',
        stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(a) }],
        usage: { input_tokens: 1000, output_tokens: 100 },
        ...extra,
      },
    });
    const STATE = { run_id: 'r1', claimed_at: 't1', round: 2, job_id: 'j1' };

    describe("reading the writer's answer", () => {
      let good: any;
      beforeAll(() => {
        good = CANNED.write_documents;
      });
      const read = (res: object) => readAnswer("Read the writer's answer", STATE, res);

      test('a good answer is read from the first text block, costed by the answering model', () => {
        expect(read(envelope(good))).toMatchObject({
          ...STATE,
          ok: true,
          error: null,
          writer: good,
          purpose: 'write_documents',
          model: 'claude-opus-5-5',
          has_usage: true,
          cost_usd: 0.006,
        });
        expect(read(envelope(good, { model: 'claude-sonnet-5-5' })).cost_usd).toBeCloseTo(0.003, 9);
        expect(read(envelope(good, { model: 'claude-unpriced-1' })).cost_usd).toBeCloseTo(0.006, 9);
      });

      test.each([
        ['refusal', (g: any) => envelope(g, { stop_reason: 'refusal', content: [] }), /declined/],
        ['max_tokens', (g: any) => envelope(g, { stop_reason: 'max_tokens' }), /cut off/],
        ['invalid JSON', (g: any) => envelope(g, { content: [{ type: 'text', text: '{not json' }] }), /expected format/],
        ['missing cv', (g: any) => envelope({ ...g, cv: undefined }), /expected format/],
        ['other template', (g: any) => envelope({ ...g, templateId: 'fancy' }), /expected format/],
        ['bad keyword coverage', (g: any) => envelope({ ...g, keywordCoverage: { covered: 'x', missing: [] } }), /expected format/],
        ['HTTP error', () => ({ statusCode: 529, body: { type: 'error' } }), /HTTP 529/],
        ['no response', () => ({ error: { message: 'timeout' } }), /no response/],
      ])('%s is a failed attempt', (_n, make, message) => {
        const out = read(make(good));
        expect(out).toMatchObject({ ok: false, final: false, writer: null, run_id: 'r1', claimed_at: 't1' });
        expect(out.error).toMatch(message);
      });

      test('a refusal still reports its usage for the cost log', () => {
        expect(read(envelope(good, { stop_reason: 'refusal', content: [] }))).toMatchObject({ has_usage: true, input_tokens: 1000, cost_usd: 0.006 });
        expect(read({ statusCode: 500, body: {} })).toMatchObject({ has_usage: false, cost_usd: null });
      });
    });

    describe("reading the reviewer's answer", () => {
      let pass: any;
      beforeAll(() => {
        pass = CANNED.review_documents;
      });
      const hard = { code: 'cv_pages', severity: 'hard', doc: 'cv', detail: 'The CV is 2 pages; the limit is 1.' };
      const warning = { code: 'missing_work_rights', severity: 'warning', doc: 'cv', detail: 'x' };
      const read = (res: object, checks: object[] = [warning]) =>
        readAnswer("Read the reviewer's answer", { ...STATE, writer: { w: 1 }, checks, cvPages: 1, letterPages: 1 }, res);

      test('a pass with no hard check, invented fact or misspelling passes the round', () => {
        const out = read(envelope(pass, { model: 'claude-sonnet-5-5' }));
        expect(out).toMatchObject({ ok: true, passed: true, review: pass, purpose: 'review_documents', cost_usd: 0.003 });
        expect(out.round_record).toEqual({ round: 2, writer: { w: 1 }, checks: [warning], cvPages: 1, letterPages: 1, review: pass, passed: true });
        // Unpriced answering model: the reviewer model's price.
        expect(read(envelope(pass, { model: 'claude-unpriced-1' })).cost_usd).toBeCloseTo(0.003, 9);
      });

      test.each([
        ['a hard check', (p: any) => p, [hard]],
        ['verdict fail', (p: any) => ({ ...p, verdict: 'fail' }), []],
        ['an invented fact', (p: any) => ({ ...p, factRulings: [{ text: 'Kafka', ruling: 'invented', why: 'not in CV' }] }), []],
        ['a misspelt word', (p: any) => ({ ...p, spellingRulings: [{ word: 'teh', ruling: 'misspelt', fix: 'the' }] }), []],
        ['a failed item under a pass verdict', (p: any) => ({ ...p, items: [{ ...p.items[0], pass: false }, ...p.items.slice(1)] }), []],
      ])('%s fails the round', (_n, make, checks) => {
        const out = read(envelope(make(pass)), checks as object[]);
        expect(out.ok).toBe(true);
        expect(out.passed).toBe(false);
        expect(out.round_record.passed).toBe(false);
      });

      test('honest rephrases and ok spellings do not fail the round', () => {
        const out = read(
          envelope({
            ...pass,
            factRulings: [{ text: 'component frameworks', ruling: 'honest_rephrase', why: 'LWC' }],
            spellingRulings: [{ word: 'Kubernetes', ruling: 'ok', fix: null }],
          }),
        );
        expect(out.passed).toBe(true);
      });

      test.each([
        ['refusal', (p: any) => envelope(p, { stop_reason: 'refusal', content: [] }), /declined/],
        ['bad verdict', (p: any) => envelope({ ...p, verdict: 'maybe' }), /expected format/],
        ['bad ruling', (p: any) => envelope({ ...p, factRulings: [{ text: 'x', ruling: 'unsure', why: 'y' }] }), /expected format/],
        ['items not a list', (p: any) => envelope({ ...p, items: {} }), /expected format/],
        ['HTTP error', () => ({ statusCode: 500, body: {} }), /HTTP 500/],
      ])('%s is a failed attempt', (_n, make, message) => {
        const out = read(make(pass));
        expect(out).toMatchObject({ ok: false, final: false, run_id: 'r1', claimed_at: 't1' });
        expect(out.error).toMatch(message);
      });
    });

    describe('the round loop', () => {
      const decide = (row: object) =>
        new Function('$json', '$', code('Decide the next step'))(row, () => ({ first: () => prices() })).json;
      const round = (n: number, passed: boolean) => ({ round: n, passed });

      test('a passed round is saved at once', () => {
        expect(decide({ id: 'r1', claimed_at: 't2', round: 1, rounds: [round(1, true)] })).toMatchObject({ another: false, run_id: 'r1', claimed_at: 't2' });
      });

      test('a failed round goes round again until the last round', () => {
        expect(decide({ id: 'r1', claimed_at: 't2', round: 1, rounds: [round(1, false)] })).toMatchObject({ another: true, round: 2, run_id: 'r1', claimed_at: 't2' });
        expect(decide({ id: 'r1', claimed_at: 't3', round: 2, rounds: [round(1, false), round(2, false)] })).toMatchObject({ another: true, round: 3 });
        expect(decide({ id: 'r1', claimed_at: 't4', round: 3, rounds: [round(1, false), round(2, false), round(3, false)] })).toMatchObject({ another: false });
      });

      test('rounds that do not match the round number stop the run', () => {
        expect(() => decide({ id: 'r1', claimed_at: 't2', round: 2, rounds: [round(1, false)] })).toThrow(/round/i);
      });
    });

    describe('choosing the version to save', () => {
      const choose = (rounds: object[]) =>
        new Function('$json', '$', code('Choose the version to save'))({ run_id: 'r1', claimed_at: 't9', rounds }, (name: string) => ({
          first: () => ({ json: name === 'Prepare inputs' ? { inputs: { cv_id: 'cv1', cv_hash: 'h1', cl_id: null, cl_hash: null } } : {} }),
        })).json;
      const writer = (tag: string) => ({
        templateId: 'standard-ats',
        templateReason: `reason ${tag}`,
        cv: { headline: tag },
        coverLetter: { name: 'X' },
        keywordCoverage: { covered: [tag], missing: [] },
        changes: [{ target: 'cv.headline', what: tag, why: tag }],
        stretches: [{ target: 'cv.summary', text: 'shared', why: 'w' }],
      });
      const item = (id: string, pass: boolean, note = 'n') => ({ id, pass, note });
      const review = (verdict: string, extra: object = {}) => ({
        verdict,
        items: [item('relevance', true), item('tidiness', true)],
        objections: [],
        factRulings: [],
        spellingRulings: [],
        stretches: [],
        ...extra,
      });
      const HARD = { code: 'cv_pages', severity: 'hard', doc: 'cv', detail: 'The CV is 2 pages; the limit is 1.' };
      const WARN = { code: 'missing_work_rights', severity: 'warning', doc: 'cv', detail: 'The base CV has no work-rights line.' };
      const REVIEW = { code: 'unmatched_skill', severity: 'review', doc: 'cv', detail: 'The technology "Kafka" is not in the base CV.' };

      test('the passing round is saved with its reasons and only warnings unresolved', () => {
        const out = choose([
          { round: 1, writer: writer('a'), checks: [HARD, WARN], review: review('fail'), passed: false },
          {
            round: 2,
            writer: writer('b'),
            checks: [WARN, REVIEW],
            review: review('pass', {
              factRulings: [{ text: 'Kafka', ruling: 'honest_rephrase', why: 'w' }],
              stretches: [{ target: 'cv.summary', text: 'shared', why: 'w' }, { target: 'cv.skills', text: 'reviewer only', why: 'r' }],
            }),
            passed: true,
          },
        ]);
        expect(out).toMatchObject({
          run_id: 'r1',
          claimed_at: 't9',
          template_id: 'standard-ats',
          cv: { headline: 'b' },
          cover_letter: { name: 'X' },
          keyword_coverage: { covered: ['b'], missing: [] },
          checks: [WARN, REVIEW],
          base_cv_id: 'cv1',
          base_cv_hash: 'h1',
        });
        expect(out.review).toEqual({
          passed: true,
          rounds: 2,
          verdicts: ['fail', 'pass'],
          unresolved: [{ source: 'check', code: 'missing_work_rights', severity: 'warning', doc: 'cv', detail: 'The base CV has no work-rights line.' }],
        });
        expect(out.reasons).toEqual({
          templateReason: 'reason b',
          changes: [{ target: 'cv.headline', what: 'b', why: 'b' }],
          stretches: [{ target: 'cv.summary', text: 'shared', why: 'w' }, { target: 'cv.skills', text: 'reviewer only', why: 'r' }],
          factRulings: [{ text: 'Kafka', ruling: 'honest_rephrase', why: 'w' }],
        });
      });

      test('no round passed: the one with the fewest problems is saved, unresolved lists them', () => {
        const out = choose([
          // 2 hard checks
          { round: 1, writer: writer('a'), checks: [HARD, HARD, WARN], review: review('fail'), passed: false },
          // 1 failed item: the fewest problems
          { round: 2, writer: writer('b'), checks: [WARN], review: review('fail', { items: [item('relevance', false, 'Padding in role 2.'), item('tidiness', true)] }), passed: false },
          // 1 hard check + 1 invented fact
          { round: 3, writer: writer('c'), checks: [HARD, WARN], review: review('pass', { factRulings: [{ text: 'Kafka', ruling: 'invented', why: 'not in CV' }] }), passed: false },
        ]);
        expect(out.cv).toEqual({ headline: 'b' });
        expect(out.review.passed).toBe(false);
        expect(out.review.rounds).toBe(3);
        expect(out.review.verdicts).toEqual(['fail', 'fail', 'pass']);
      });

      test('ties go to the latest round', () => {
        const out = choose([
          { round: 1, writer: writer('a'), checks: [HARD], review: review('pass'), passed: false },
          { round: 2, writer: writer('b'), checks: [HARD], review: review('pass'), passed: false },
          { round: 3, writer: writer('c'), checks: [HARD, HARD], review: review('pass'), passed: false },
        ]);
        expect(out.cv).toEqual({ headline: 'b' });
        expect(out.review.unresolved).toEqual([{ source: 'check', code: 'cv_pages', severity: 'hard', doc: 'cv', detail: 'The CV is 2 pages; the limit is 1.' }]);
      });

      test('unresolved lists hard checks, failed items with notes, invented facts, misspellings and warnings', () => {
        const out = choose([
          {
            round: 1,
            writer: writer('a'),
            checks: [HARD, WARN, REVIEW],
            review: review('fail', {
              items: [item('relevance', false, 'Padding in role 2.'), item('tidiness', true)],
              factRulings: [{ text: 'Kafka', ruling: 'invented', why: 'not in CV' }, { text: 'LWC', ruling: 'honest_rephrase', why: 'ok' }],
              spellingRulings: [{ word: 'teh', ruling: 'misspelt', fix: 'the' }, { word: 'Kubernetes', ruling: 'ok', fix: null }],
            }),
            passed: false,
          },
        ]);
        expect(out.review.unresolved).toEqual([
          { source: 'check', code: 'cv_pages', severity: 'hard', doc: 'cv', detail: 'The CV is 2 pages; the limit is 1.' },
          { source: 'review', id: 'relevance', note: 'Padding in role 2.' },
          { source: 'fact', text: 'Kafka', why: 'not in CV' },
          { source: 'spelling', word: 'teh', fix: 'the' },
          { source: 'check', code: 'missing_work_rights', severity: 'warning', doc: 'cv', detail: 'The base CV has no work-rights line.' },
        ]);
      });
    });

    test('the writer revision sends the previous round from the database row', () => {
      const build = (heartbeat: object) =>
        new Function('$json', '$', '$now', code('Build writer request'))(
          heartbeat,
          (name: string) => ({
            first: () => {
              if (name === 'Look up model prices') return prices();
              if (name === 'Writer and reviewer prompts') return { json: { writer_prompt: 'purpose: write_documents\nW', writer_schema: { type: 'object' } } };
              if (name === 'Prepare inputs')
                return {
                  json: {
                    inputs: {
                      job_id: 'j1',
                      cv_block: { type: 'text', text: '<document>\nCV\n</document>' },
                      job_ad: 'Ad',
                      job_facts: { title: 'T', employer: 'E', advertiser: null, shortDescription: null },
                      base_cv_facts: { name: 'N' },
                      base_cover_letter: null,
                      company_notes: '',
                    },
                  },
                };
              return { json: {} };
            },
          }),
          { toFormat: () => '7 November 2026' },
        ).json;
      const first = build({ id: 'r1', claimed_at: 't1', round: 1, rounds: [] });
      expect(first.request.messages[0].content[1].text).not.toContain('<previous_round>');
      expect(first.request.messages[0].content[1].text).toContain('7 November 2026');
      const prev = {
        round: 1,
        writer: { cv: { headline: 'old' } },
        checks: [
          { code: 'cv_pages', severity: 'hard', doc: 'cv', detail: 'pages' },
          { code: 'unmatched_skill', severity: 'review', doc: 'cv', detail: 'The technology "Kafka" is not in the base CV.' },
          { code: 'unmatched_skill', severity: 'review', doc: 'cv', detail: 'The technology "LWC" is not in the base CV.' },
          { code: 'missing_work_rights', severity: 'warning', doc: 'cv', detail: 'w' },
        ],
        review: {
          verdict: 'fail',
          items: [{ id: 'relevance', pass: false, note: 'pad' }, { id: 'tidiness', pass: true, note: 'ok' }],
          objections: [{ target: 'cv.summary', problem: 'p', fix: 'f' }],
          factRulings: [{ text: 'Kafka', ruling: 'invented', why: 'no' }, { text: 'LWC', ruling: 'honest_rephrase', why: 'ok' }],
          spellingRulings: [],
          stretches: [],
        },
        passed: false,
      };
      const second = build({ id: 'r1', claimed_at: 't2', round: 2, rounds: [prev] });
      expect(second).toMatchObject({ run_id: 'r1', claimed_at: 't2', round: 2, job_id: 'j1' });
      const text = second.request.messages[0].content[1].text;
      const previous = JSON.parse(/<previous_round>\n([\s\S]*?)\n<\/previous_round>/.exec(text)![1]);
      expect(previous).toEqual({
        documents: { cv: { headline: 'old' } },
        failedChecks: [prev.checks[0], prev.checks[1]],
        warnings: [prev.checks[3]],
        failedItems: [{ id: 'relevance', pass: false, note: 'pad' }],
        rulingsAgainst: { facts: [prev.review.factRulings[0]], spelling: [] },
        objections: prev.review.objections,
      });
      expect(() => build({ id: 'r1', claimed_at: 't2', round: 2, rounds: [] })).toThrow(/round/i);
    });

    test('prompts and schemas in the workflow match n8n/prompts', () => {
      const v = values();
      expect(normalise(v.writer_prompt)).toBe(normalise(WRITER_PROMPT));
      expect(normalise(v.review_prompt)).toBe(normalise(REVIEW_PROMPT));
      expect(JSON.parse(v.writer_schema)).toEqual(JSON.parse(promptFile('write-documents.schema.json')));
      expect(JSON.parse(v.review_schema)).toEqual(JSON.parse(promptFile('review-documents.schema.json')));
      expect(WRITER_PROMPT.split(/\r?\n/)[0]).toBe('purpose: write_documents');
      expect(REVIEW_PROMPT.split(/\r?\n/)[0]).toBe('purpose: review_documents');
    });

    test('readable: every numbered step has a sticky note', () => {
      const notes = wf.nodes.filter((n: any) => n.type === 'n8n-nodes-base.stickyNote').map((n: any) => n.parameters.content as string);
      const headings = notes.map((c: string) => c.split('\n')[0]).filter((h: string) => h.startsWith('## '));
      for (const step of [1, 2, 3, 4, 5, 6, 7]) {
        expect(headings.some((h: string) => new RegExp(`(## |· )${step}\\. `).test(h)), `step ${step}`).toBe(true);
      }
      // The round loop is explained where it is built.
      expect(notes.some((c: string) => /back-edge/.test(c) && /back from that row/.test(c))).toBe(true);
    });

    test('no SQL comment contains a dollar placeholder', () => {
      for (const node of wf.nodes.filter((n: any) => n.type === 'n8n-nodes-base.postgres')) {
        for (const line of String(node.parameters.query).split('\n')) {
          const comment = line.split('--')[1];
          if (comment !== undefined) expect(comment, node.name).not.toMatch(/\$\d/);
        }
      }
    });
  });
});
