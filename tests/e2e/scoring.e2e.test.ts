import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
  N8N_URL,
  ROOT,
  db,
  makePdf,
  resetState,
  stub,
  triggerDocumentsSync,
  triggerScoring,
  triggerSync,
  writeDocument,
  writeJobFile,
} from './lib';

const normalise = (s: string) => s.replace(/\r\n/g, '\n').trim();
const PROMPT = readFileSync(join(ROOT, 'n8n', 'prompts', 'score-job.md'), 'utf8');

const jobRow = async (sourceRef: string) =>
  (await db.query(`select * from jobs where source_ref=$1`, [sourceRef]))[0];
const purposeOf = (body: any) => String(body.system ?? '').split(/\r?\n/)[0];
const scoreRequests = async () => (await stub.requests()).filter((b) => purposeOf(b) === 'purpose: score_job');
/** The base CV facts a scoring request sent, parsed from inside <base_cv> tags. */
const sentCv = (body: any) => JSON.parse(/<base_cv>\n([\s\S]*)\n<\/base_cv>/.exec(body.messages[0].content)![1]);

/** Puts one base CV in the folder and analyses it; the stub records `tag` as its headline. Returns the basis hash. */
async function readyCv(tag: string): Promise<string> {
  writeDocument('cv', 'cv.pdf', makePdf(`Base CV STUB_HEADLINE:${tag}`));
  await triggerDocumentsSync();
  const [cv] = await db.query(`select content_hash, analysis_status from base_documents where kind='cv' and active`);
  expect(cv.analysis_status).toBe('done');
  return cv.content_hash;
}

/** Adds a job file and runs the intake sync, so its details are extracted. */
async function addJob(name: string, body: string): Promise<void> {
  await writeJobFile(name, [{ text: `https://x.io/${name}` }, { text: body }]);
  await triggerSync();
  expect((await jobRow(name)).extraction_status).toBe('done');
}

describe('job match scoring', () => {
  beforeEach(async () => {
    await resetState();
  });
  afterAll(async () => {
    await resetState();
  });

  test('webhook without X-JobHunter header is refused and runs nothing', async () => {
    await readyCv('v1');
    await addJob('a.docx', 'Job A');
    await stub.reset();
    const res = await fetch(`${N8N_URL}/webhook/api/jobs/score`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'missing_jobhunter_header' });
    expect(await jobRow('a.docx')).toMatchObject({ score_status: 'pending', score_attempts: 0, match_score: null });
    expect(await stub.requests()).toEqual([]);
  });

  test('scores a job against the base CV', async () => {
    const basis = await readyCv('v1');
    await addJob('a.docx', 'Salesforce Developer at Acme');
    await stub.reset();
    expect(await triggerScoring()).toEqual({ ok: true, scored: 1, basisHash: basis });
    const job = await jobRow('a.docx');
    expect(job).toMatchObject({
      score_status: 'done',
      score_attempts: 1,
      match_score: 82,
      match_explanation: '82%: Stub match explanation.',
      match_breakdown: { matched: ['TypeScript'], missing: [], notes: [] },
      match_basis_hash: basis,
    });
    expect(job.match_explanation).toMatch(/^\d{1,3}%: /);
    const costs = await db.query(`select * from cost_log where purpose='score_job'`);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      job_id: job.id,
      base_document_id: null,
      model: 'claude-sonnet-5-5',
      input_tokens: 1000,
      output_tokens: 100,
    });
    expect(Number(costs[0].cost_usd)).toBeCloseTo(0.003, 6); // 1000 × $2 + 100 × $10 per 1M
  });

  test('no base CVs means no scoring calls', async () => {
    await addJob('a.docx', 'Job A');
    // A cover letter alone is not a basis, and neither is a CV whose analysis failed.
    writeDocument('cover_letter', 'cl.pdf', makePdf('Cover letter'));
    writeDocument('cv', 'bad.pdf', makePdf('STUB_FAIL please'));
    await triggerDocumentsSync();
    await stub.reset();
    expect(await triggerScoring()).toEqual({ ok: true, scored: 0, basisHash: null });
    expect(await stub.requests()).toEqual([]);
    expect(await jobRow('a.docx')).toMatchObject({
      score_status: 'pending',
      score_attempts: 0,
      match_score: null,
      match_basis_hash: null,
    });
  });

  test('unchanged basis does not rescore', async () => {
    const basis = await readyCv('v1');
    await addJob('a.docx', 'Job A');
    await stub.reset();
    await triggerScoring();
    expect(await triggerScoring()).toEqual({ ok: true, scored: 0, basisHash: basis });
    expect(await scoreRequests()).toHaveLength(1);
    expect(await jobRow('a.docx')).toMatchObject({ score_status: 'done', score_attempts: 1, match_basis_hash: basis });
  });

  test('CV change rescores all jobs', async () => {
    const oldBasis = await readyCv('v1');
    await addJob('a.docx', 'Job A');
    await addJob('b.docx', 'Job B');
    await triggerScoring();
    const newBasis = await readyCv('v2');
    expect(newBasis).not.toBe(oldBasis);
    await stub.reset();
    expect(await triggerScoring()).toEqual({ ok: true, scored: 2, basisHash: newBasis });
    const requests = await scoreRequests();
    expect(requests).toHaveLength(2);
    for (const body of requests) expect(sentCv(body).headline).toBe('v2');
    for (const name of ['a.docx', 'b.docx']) {
      expect(await jobRow(name)).toMatchObject({ score_status: 'done', score_attempts: 1, match_basis_hash: newBasis, match_score: 82 });
    }
  });

  test('basis change during scoring rescores (claim from a crashed run with the old basis)', async () => {
    const oldBasis = await readyCv('v1');
    await addJob('a.docx', 'Job A');
    await triggerScoring();
    // A run that claimed the job with the old basis crashed more than 5 minutes ago.
    await db.query(
      `update jobs set score_status='in_progress', score_claimed_at=now() - interval '10 minutes', score_attempts=1 where source_ref='a.docx'`,
    );
    const newBasis = await readyCv('v2');
    await stub.reset();
    expect(await triggerScoring()).toEqual({ ok: true, scored: 1, basisHash: newBasis });
    const [req] = await scoreRequests();
    expect(sentCv(req).headline).toBe('v2');
    expect(await jobRow('a.docx')).toMatchObject({ score_status: 'done', score_attempts: 1, match_basis_hash: newBasis });
    expect(oldBasis).not.toBe(newBasis);
  });

  test('basis change during a scoring call: the old score is never saved', async () => {
    const oldBasis = await readyCv('v1');
    await addJob('a.docx', 'Job A');
    await stub.reset();
    await stub.delayPurpose('score_job', 6000);
    const running = triggerScoring();
    // Wait until Claude has the request (with the old CV), then change the CV.
    for (let i = 0; i < 50 && (await scoreRequests()).length === 0; i++) await new Promise((r) => setTimeout(r, 200));
    const [oldReq] = await scoreRequests();
    expect(sentCv(oldReq).headline).toBe('v1');
    const newBasis = await readyCv('v2');
    expect(await running).toEqual({ ok: true, scored: 0, basisHash: oldBasis });
    expect(await jobRow('a.docx')).toMatchObject({ score_status: 'pending', match_score: null, match_explanation: null, match_breakdown: null });
    // The thrown-away answer still cost money, so it is logged.
    expect(await db.query(`select id from cost_log where purpose='score_job'`)).toHaveLength(1);

    await stub.reset();
    expect(await triggerScoring()).toEqual({ ok: true, scored: 1, basisHash: newBasis });
    const [newReq] = await scoreRequests();
    expect(sentCv(newReq).headline).toBe('v2');
    expect(await jobRow('a.docx')).toMatchObject({ score_status: 'done', score_attempts: 1, match_basis_hash: newBasis, match_score: 82 });
  });

  test('job file edit rescores that job', async () => {
    const basis = await readyCv('v1');
    await addJob('a.docx', 'Job A');
    await addJob('b.docx', 'Job B');
    await triggerScoring();
    await writeJobFile('a.docx', [{ text: 'https://x.io/a.docx' }, { text: 'Job A, edited' }]);
    await triggerSync();
    // The intake sync re-extracted the job and cleared its score.
    expect(await jobRow('a.docx')).toMatchObject({
      extraction_status: 'done',
      score_status: 'pending',
      score_attempts: 0,
      match_score: null,
      match_explanation: null,
      match_breakdown: null,
      match_basis_hash: null,
    });
    await stub.reset();
    expect(await triggerScoring()).toEqual({ ok: true, scored: 1, basisHash: basis });
    const requests = await scoreRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].messages[0].content).toContain('<job_ad>\nJob A, edited\n</job_ad>');
    expect(await jobRow('a.docx')).toMatchObject({ score_status: 'done', match_basis_hash: basis, match_score: 82 });
    expect(await jobRow('b.docx')).toMatchObject({ score_status: 'done', score_attempts: 1 });
  });

  test('a job not yet extracted, or whose file is gone, is not scored', async () => {
    await readyCv('v1');
    await addJob('a.docx', 'Job A');
    await addJob('b.docx', 'Job B');
    await db.query(`update jobs set extraction_status='pending' where source_ref='a.docx'`);
    await db.query(`update jobs set source_removed=true where source_ref='b.docx'`);
    await stub.reset();
    expect((await triggerScoring()).scored).toBe(0);
    expect(await stub.requests()).toEqual([]);
  });

  test('scoring failure is retried with backoff then gives up', async () => {
    await readyCv('v1');
    await addJob('a.docx', 'Job A');
    await stub.reset();
    await stub.failPurpose('score_job');
    const age = (by: string) =>
      db.query(`update jobs set score_claimed_at = score_claimed_at - $1::interval where source_ref='a.docx'`, [by]);

    await triggerScoring();
    expect(await jobRow('a.docx')).toMatchObject({ score_status: 'failed', score_attempts: 1, match_score: null });
    await triggerScoring(); // within a minute of attempt 1: not retried
    expect(await scoreRequests()).toHaveLength(1);
    await age('2 minutes'); // over a minute after attempt 1: retried
    await triggerScoring();
    expect(await scoreRequests()).toHaveLength(2);
    await age('2 minutes'); // under 5 minutes after attempt 2: not retried
    await triggerScoring();
    expect(await scoreRequests()).toHaveLength(2);
    await age('6 minutes'); // over 5 minutes after attempt 2: retried
    await triggerScoring();
    expect(await scoreRequests()).toHaveLength(3);
    await age('1 hour'); // all 3 attempts used: gives up
    await triggerScoring();
    expect(await scoreRequests()).toHaveLength(3);
    expect(await jobRow('a.docx')).toMatchObject({ score_status: 'failed', score_attempts: 3, match_score: null });
    // A 500 has no usage, so nothing is logged as cost.
    expect(await db.query(`select id from cost_log where purpose='score_job'`)).toEqual([]);
  });

  test('stuck scoring claim with all 3 attempts used is marked failed, no Claude call', async () => {
    const basis = await readyCv('v1');
    await addJob('a.docx', 'Job A');
    await db.query(
      `update jobs set score_status='in_progress', score_claimed_at=now() - interval '10 minutes', score_attempts=3,
         match_basis_hash=$1 where source_ref='a.docx'`,
      [basis],
    );
    await stub.reset();
    await triggerScoring();
    expect(await jobRow('a.docx')).toMatchObject({ score_status: 'failed', score_attempts: 3 });
    expect(await stub.requests()).toEqual([]);
  });

  test('overlapping scoring runs do not double-call Claude', async () => {
    await readyCv('v1');
    await addJob('a.docx', 'Job A');
    await stub.reset();
    await Promise.all([triggerScoring(), triggerScoring()]);
    expect(await scoreRequests()).toHaveLength(1);
    expect(await jobRow('a.docx')).toMatchObject({ score_status: 'done', score_attempts: 1 });
  });

  test('sends fallbacks for sonnet', async () => {
    await readyCv('v1');
    await addJob('a.docx', 'Salesforce Developer at Acme');
    await stub.reset();
    await triggerScoring();
    const log = (await stub.requestLog()).filter((r) => purposeOf(r.body) === 'purpose: score_job');
    expect(log).toHaveLength(1);
    const { headers, body } = log[0];
    expect(headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 4000, fallbacks: 'default' });
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
    const schema = body.output_config.format.schema;
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect([...schema.required].sort()).toEqual(['explanation', 'matched', 'missing', 'notes', 'score']);
    expect(schema.properties.score.type).toBe('integer');
    for (const key of ['thinking', 'temperature', 'top_p', 'top_k']) expect(body).not.toHaveProperty(key);
    expect(normalise(body.system)).toBe(normalise(PROMPT));
    // One user message, no prefill: the job ad, then the base CV facts.
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toMatch(/^<job_ad>\nSalesforce Developer at Acme\n<\/job_ad>\n\n<base_cv>\n/);
    const [cv] = await db.query(`select structured from base_documents where kind='cv' and active`);
    expect(sentCv(body)).toEqual(cv.structured);
  });

  // Checks on the workflow JSON itself, for behaviour the fixed test env cannot reach.
  describe('workflow definition', () => {
    const wf = JSON.parse(readFileSync(join(ROOT, 'n8n', 'workflows', 'job-match-scoring.json'), 'utf8'));
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
    const runPriceLookup = (model: string) =>
      new Function('$env', nodeByName('Look up model price').parameters.jsCode)({ SCORE_MODEL: model });

    test('stable id, webhook path, CORS origins and no saved successful runs', () => {
      expect(wf.id).toBe('jh-job-match-scoring');
      const hook = nodeByName('POST api/jobs/score');
      expect(hook.parameters).toMatchObject({
        httpMethod: 'POST',
        path: 'api/jobs/score',
        options: { allowedOrigins: 'http://localhost:8080,http://localhost:5173' },
      });
      expect(parentsOf('Find the current basis').sort()).toEqual(['Has X-JobHunter header?', 'Schedule enabled?']);
      expect(wf.settings).toMatchObject({ saveDataSuccessExecution: 'none', saveManualExecutions: false });
    });

    test('unknown model stops the run before any job is claimed or Claude is called', () => {
      expect(() => runPriceLookup('claude-unknown-9')).toThrow(/No price for model "claude-unknown-9" \(SCORE_MODEL\)/);
      expect(runPriceLookup('claude-sonnet-5-5')[0].json).toMatchObject({
        model: 'claude-sonnet-5-5', input_usd_per_mtok: 2, output_usd_per_mtok: 10, fallbacks: true,
      });
      expect(runPriceLookup('claude-opus-5-5')[0].json).toMatchObject({ input_usd_per_mtok: 4, output_usd_per_mtok: 20, fallbacks: true });
      expect(runPriceLookup('claude-haiku-5-5')[0].json).toMatchObject({ fallbacks: false });
      expect(parentsOf('Claim jobs to score')).toEqual(['Look up model price']);
      expect(ancestorsOf('Ask Claude to score').has('Claim jobs to score')).toBe(true);
      expect(ancestorsOf('Look up model price').has('Ask Claude to score')).toBe(false);
    });

    test('cost uses the answering model price, else the requested one', () => {
      const workOut = (json: object) =>
        new Function('$json', '$', nodeByName('Work out cost').parameters.jsCode)(json, () => ({
          first: () => runPriceLookup('claude-sonnet-5-5')[0],
        })).json;
      const usage = { has_usage: true, input_tokens: 1000, output_tokens: 100 };
      expect(workOut({ ...usage, model: 'claude-opus-5-5' }).cost_usd).toBeCloseTo(0.006, 9);
      expect(workOut({ ...usage, model: 'claude-unpriced-1' }).cost_usd).toBeCloseTo(0.003, 9);
      expect(workOut({ has_usage: false, model: 'claude-sonnet-5-5' }).cost_usd).toBeNull();
    });

    describe("reading Claude's answer", () => {
      const read = (res: object) =>
        new Function('$json', '$', nodeByName("Read Claude's answer").parameters.jsCode)(res, (name: string) => ({
          item: { json: { job_id: 'j1', claimed_at: 't1', basis_hash: 'h1' } },
          first: () => (name === 'Look up model price' ? runPriceLookup('claude-sonnet-5-5')[0] : { json: {} }),
        })).json;
      const answer = (a: object, extra: object = {}) => ({
        statusCode: 200,
        body: {
          model: 'claude-sonnet-5-5',
          stop_reason: 'end_turn',
          content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(a) }],
          usage: { input_tokens: 10, output_tokens: 5 },
          ...extra,
        },
      });
      const good = { score: 70, explanation: '70%: matches 5 of 7 required skills.', matched: ['A'], missing: ['B'], notes: [] };

      test('a good answer is read from the first text block', () => {
        expect(read(answer(good))).toMatchObject({
          ok: true,
          job_id: 'j1',
          claimed_at: 't1',
          basis_hash: 'h1',
          score: 70,
          explanation: '70%: matches 5 of 7 required skills.',
          breakdown: { matched: ['A'], missing: ['B'], notes: [] },
          has_usage: true,
          model: 'claude-sonnet-5-5',
        });
      });

      test('the explanation always starts with "<score>%:"', () => {
        expect(read(answer({ ...good, explanation: 'Matches 5 of 7.' })).explanation).toBe('70%: Matches 5 of 7.');
        expect(read(answer({ ...good, explanation: '65 %: Matches 5 of 7.' })).explanation).toBe('70%: Matches 5 of 7.');
      });

      test.each([
        ['refusal', answer(good, { stop_reason: 'refusal', content: [] }), /declined/],
        ['max_tokens', answer(good, { stop_reason: 'max_tokens' }), /cut off/],
        ['invalid JSON', answer(good, { content: [{ type: 'text', text: '{not json' }] }), /expected format/],
        ['score over 100', answer({ ...good, score: 101 }), /expected format/],
        ['score not a whole number', answer({ ...good, score: 70.5 }), /expected format/],
        ['missing list', answer({ score: 70, explanation: '70%: x', matched: [], missing: [] }), /expected format/],
        ['HTTP error', { statusCode: 529, body: { type: 'error' } }, /HTTP 529/],
      ])('%s is a failure', (_name, res, message) => {
        const out = read(res);
        expect(out.ok).toBe(false);
        expect(out.error).toMatch(message);
        expect(out.score).toBeNull();
      });

      test('a refusal still reports its usage for the cost log', () => {
        expect(read(answer(good, { stop_reason: 'refusal', content: [] }))).toMatchObject({ has_usage: true, input_tokens: 10 });
      });
    });

    test('a score is saved only with this run\'s claim and the current basis', () => {
      const save = nodeByName('Save score').parameters.query;
      expect(save).toMatch(/score_claimed_at = \$2::timestamptz/);
      expect(save).toMatch(/d\.content_hash = \$3/);
      expect(save).toMatch(/match_basis_hash = \$3/);
      expect(nodeByName('Mark scoring failed').parameters.query).toMatch(/score_claimed_at = \$2::timestamptz/);
      const claim = nodeByName('Claim jobs to score').parameters.query;
      expect(claim).toMatch(/for update of j skip locked/);
      expect(claim).toMatch(/score_claimed_at::text as claimed_at/);
      expect(claim).toMatch(/j\.match_basis_hash = \$2/);
    });

    test('a scoring request finishes well inside the 5-minute claim window', () => {
      expect(nodeByName('Ask Claude to score').parameters.options.timeout).toBeLessThanOrEqual(280_000);
    });

    test('prompt in the workflow matches n8n/prompts/score-job.md', () => {
      const values = Object.fromEntries(
        nodeByName('Scoring prompt and schema').parameters.assignments.assignments.map((a: any) => [a.name, a.value]),
      );
      expect(normalise(values.system_prompt)).toBe(normalise(PROMPT));
      expect(PROMPT.split(/\r?\n/)[0]).toBe('purpose: score_job');
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
