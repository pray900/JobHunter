import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest';
import { makeDocx } from '../helpers/makeDocx';
import {
  DOCUMENTS_DIR,
  N8N_URL,
  ROOT,
  SYNC_HEADERS,
  compose,
  composeOutput,
  db,
  makePdf,
  putDocument,
  resetState,
  storedDocuments,
  stub,
  triggerDocumentsSync,
} from './lib';

const OWNER = '00000000-0000-0000-0000-000000000001';
const PDF = 'application/pdf';
const normalise = (s: string) => s.replace(/\r\n/g, '\n').trim();
const prompt = (name: string) => readFileSync(join(ROOT, 'n8n', 'prompts', name), 'utf8');

const docRow = async (sourceRef: string) =>
  (await db.query(`select * from base_documents where source_ref=$1`, [sourceRef]))[0];
const purposeOf = (body: any) => String(body.system ?? '').split(/\r?\n/)[0];
/** The document a recorded request carried, as text (test PDFs are plain text). */
const sentText = (body: any): string =>
  body.messages[0].content
    .map((c: any) => (c.type === 'document' ? Buffer.from(c.source.data, 'base64').toString('latin1') : c.text))
    .join('\n');

describe('base documents sync', () => {
  beforeEach(async () => {
    await resetState();
  });
  afterAll(async () => {
    await resetState();
  });

  test('webhook without X-JobHunter header is refused and runs nothing', async () => {
    await putDocument('cv', 'a.pdf', makePdf('CV A'));
    // A run that got past the check would insert this stored document again and call Claude.
    await db.query('truncate cost_log, base_documents, document_versions');
    await stub.reset();
    const res = await fetch(`${N8N_URL}/webhook/api/documents/sync`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'missing_jobhunter_header' });
    expect(await db.query(`select id from base_documents`)).toEqual([]);
    expect(await stub.requests()).toEqual([]);
  });

  test('an upload into the empty slot is analysed, checked and active straight away', async () => {
    await putDocument('cv', 'a.pdf', makePdf('CV A'));
    const doc = await docRow('a.pdf');
    expect(doc).toMatchObject({
      kind: 'cv',
      media_type: PDF,
      active: true,
      analysis_status: 'done',
      analysis_attempts: 1,
      analysis_error: null,
      source_removed: false,
    });
    expect(doc.structured.workRights).toBeNull();
    expect(doc.structured.name).toBe('Stub Person');
    expect(doc.warnings).toEqual([expect.objectContaining({ code: 'missing_work_rights' })]);
    const costs = await db.query(`select * from cost_log`);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toMatchObject({
      base_document_id: doc.id,
      job_id: null,
      purpose: 'analyse_cv',
      model: 'claude-opus-5-5',
      input_tokens: 1000,
      output_tokens: 100,
    });
    expect(Number(costs[0].cost_usd)).toBeCloseTo(0.006, 6); // 1000 x $4 + 100 x $20 per 1M
    expect(storedDocuments('cv')).toEqual(['a.pdf']);
  });

  test('cost is priced by the model that answered', async () => {
    await putDocument('cv', 'a.pdf', makePdf('CV A STUB_MODEL:claude-sonnet-5-5'));
    const [cost] = await db.query(`select model, cost_usd from cost_log`);
    expect(cost.model).toBe('claude-sonnet-5-5');
    expect(Number(cost.cost_usd)).toBeCloseTo(0.003, 6); // 1000 x $2 + 100 x $10 per 1M
  });

  test('an answering model without a price is costed at the requested model price', async () => {
    await putDocument('cover_letter', 'cl.pdf', makePdf('CL STUB_MODEL:claude-unpriced-1'));
    const [cost] = await db.query(`select model, cost_usd from cost_log`);
    expect(cost.model).toBe('claude-unpriced-1');
    expect(Number(cost.cost_usd)).toBeCloseTo(0.006, 6);
  });

  test('unchanged document is not analysed again', async () => {
    await putDocument('cv', 'a.pdf', makePdf('CV A'));
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 1, analysed: 0 });
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 1, analysed: 0 });
    expect(await stub.requests()).toHaveLength(1);
  });

  test('overlapping syncs do not double-call Claude', async () => {
    await stub.failPurpose('analyse_cv');
    await putDocument('cv', 'a.pdf', makePdf('CV A'));
    await stub.reset();
    // Past the 1-minute wait after attempt 1: both runs want to retry it, only one may.
    await db.query(`update base_documents set analysis_claimed_at = analysis_claimed_at - interval '10 minutes'`);
    await Promise.all([triggerDocumentsSync(), triggerDocumentsSync()]);
    expect((await stub.requests()).map(purposeOf)).toEqual(['purpose: analyse_cv']);
    expect(await docRow('a.pdf')).toMatchObject({ analysis_status: 'done', analysis_attempts: 2 });
  });

  test('replace with the same name: same row, old content gone, the new content analysed', async () => {
    await putDocument('cv', 'a.pdf', makePdf('v1'));
    const before = await docRow('a.pdf');
    await putDocument('cv', 'a.pdf', makePdf('v2'));
    const after = await docRow('a.pdf');
    expect(after).toMatchObject({ id: before.id, active: true, analysis_status: 'done', analysis_attempts: 1 });
    expect(after.content_hash).not.toBe(before.content_hash);
    expect((await stub.requests()).map(sentText)).toEqual([expect.stringContaining('v1'), expect.stringContaining('v2')]);
    expect(storedDocuments('cv')).toEqual(['a.pdf']);
    expect(await db.query(`select id from base_documents`)).toHaveLength(1);
  });

  test('replace with a different name: the old document is gone and retired, the new one active and analysed', async () => {
    await putDocument('cv', 'old.pdf', makePdf('OLD CV'));
    await putDocument('cv', 'new.pdf', makePdf('NEW CV'));
    expect(storedDocuments('cv')).toEqual(['new.pdf']);
    expect(await docRow('new.pdf')).toMatchObject({ active: true, source_removed: false, analysis_status: 'done' });
    expect(await docRow('old.pdf')).toMatchObject({ active: false, source_removed: true, analysis_status: 'done' });
    expect((await stub.requests()).map(sentText)).toEqual([expect.stringContaining('OLD CV'), expect.stringContaining('NEW CV')]);
    expect(await db.query(`select source_ref from base_documents where active`)).toEqual([{ source_ref: 'new.pdf' }]);
  });

  test('uploading the same file again does not analyse it again', async () => {
    const bytes = makePdf('CV A');
    await putDocument('cv', 'a.pdf', bytes);
    await putDocument('cv', 'a.pdf', bytes);
    expect(await stub.requests()).toHaveLength(1);
    expect(await docRow('a.pdf')).toMatchObject({ active: true, analysis_status: 'done', analysis_attempts: 1 });
  });

  test('uploading an earlier document again makes it current and reuses its analysis', async () => {
    const first = makePdf('FIRST CV');
    await putDocument('cv', 'first.pdf', first);
    await putDocument('cv', 'second.pdf', makePdf('SECOND CV'));
    await putDocument('cv', 'first.pdf', first);
    expect(storedDocuments('cv')).toEqual(['first.pdf']);
    expect(await docRow('first.pdf')).toMatchObject({ active: true, source_removed: false, analysis_status: 'done' });
    expect(await docRow('second.pdf')).toMatchObject({ active: false, source_removed: true });
    expect(await stub.requests()).toHaveLength(2);
  });

  test('a document that was replaced before its analysis finished is analysed when it comes back', async () => {
    await stub.failPurpose('analyse_cv');
    const bytes = makePdf('CV A');
    await putDocument('cv', 'a.pdf', bytes);
    await stub.reset();
    await putDocument('cv', 'b.pdf', makePdf('CV B'));
    await putDocument('cv', 'a.pdf', bytes);
    expect(await docRow('a.pdf')).toMatchObject({ active: true, analysis_status: 'done', analysis_attempts: 1 });
  });

  test('replacing the CV leaves the cover letter alone', async () => {
    await putDocument('cv', 'cv.pdf', makePdf('CV ONE'));
    await putDocument('cover_letter', 'cl.pdf', makePdf('CL ONE'));
    const letter = await docRow('cl.pdf');
    await putDocument('cv', 'cv2.pdf', makePdf('CV TWO'));
    expect(storedDocuments('cover_letter')).toEqual(['cl.pdf']);
    expect(await docRow('cl.pdf')).toMatchObject({ id: letter.id, active: true, source_removed: false, analysis_status: 'done' });
    expect(await db.query(`select kind, source_ref from base_documents where active order by kind`)).toEqual([
      { kind: 'cover_letter', source_ref: 'cl.pdf' },
      { kind: 'cv', source_ref: 'cv2.pdf' },
    ]);
    expect((await stub.requests()).map(purposeOf)).toEqual([
      'purpose: analyse_cv',
      'purpose: analyse_cover_letter',
      'purpose: analyse_cv',
    ]);
  });

  test('cover letter uses cover-letter prompt', async () => {
    await putDocument('cover_letter', 'cl.docx', await makeDocx([{ text: 'Dear Ms Li,' }, { text: 'I would like to apply.' }]));
    const doc = await docRow('cl.docx');
    expect(doc).toMatchObject({ kind: 'cover_letter', active: true, analysis_status: 'done' });
    expect(doc.structured).toMatchObject({ previousTarget: { company: 'Stub Company' }, toneNotes: expect.any(String) });
    const reqs = await stub.requests();
    expect(reqs).toHaveLength(1);
    expect(purposeOf(reqs[0])).toBe('purpose: analyse_cover_letter');
    expect(normalise(reqs[0].system)).toBe(normalise(prompt('analyse-cover-letter.md')));
    // DOCX goes as extracted text inside <document> tags.
    expect(reqs[0].messages[0].content[0]).toEqual({ type: 'text', text: '<document>\nDear Ms Li,\nI would like to apply.\n</document>' });
    expect([...reqs[0].output_config.format.schema.required].sort()).toEqual(['previousTarget', 'reusableParagraphs', 'toneNotes']);
    expect(await db.query(`select purpose from cost_log`)).toEqual([{ purpose: 'analyse_cover_letter' }]);
  });

  test('request is a PDF document block and sends fallbacks for opus', async () => {
    const bytes = makePdf('CV A');
    await putDocument('cv', 'a.pdf', bytes);
    const [{ headers, body }] = await stub.requestLog();
    expect(headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(headers['anthropic-version']).toBe('2026-10-21');
    expect(body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000, fallbacks: 'default' });
    expect(body.output_config.effort).toBe('medium');
    expect(body.output_config.format.type).toBe('json_schema');
    const schema = body.output_config.format.schema;
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect([...schema.required].sort()).toEqual(
      ['contact', 'education', 'headline', 'metrics', 'name', 'projects', 'roles', 'skills', 'summary', 'workRights'],
    );
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) expect(body).not.toHaveProperty(key);
    expect(purposeOf(body)).toBe('purpose: analyse_cv');
    expect(normalise(body.system)).toBe(normalise(prompt('analyse-cv.md')));
    const content = body.messages[0].content;
    expect(body.messages).toHaveLength(1);
    expect(content[0]).toEqual({ type: 'document', source: { type: 'base64', media_type: PDF, data: bytes.toString('base64') } });
    expect(content[1].type).toBe('text');
    expect(body.messages[body.messages.length - 1].role).toBe('user'); // no prefill
  });

  test('no conflict check is ever called', async () => {
    await putDocument('cv', 'a.pdf', makePdf('CV A'));
    await putDocument('cv', 'b.pdf', makePdf('CV B'));
    await triggerDocumentsSync();
    expect((await stub.requests()).map(purposeOf)).toEqual(['purpose: analyse_cv', 'purpose: analyse_cv']);
    expect(await db.query(`select to_regclass('base_document_checks') as t`)).toEqual([{ t: null }]);
  });

  test('a failed CV does not block the cover letter', async () => {
    await putDocument('cv', 'bad.pdf', makePdf('STUB_FAIL please'));
    await putDocument('cover_letter', 'cl.pdf', makePdf('CL'));
    expect(await docRow('bad.pdf')).toMatchObject({
      active: true,
      analysis_status: 'failed',
      analysis_attempts: 1,
      analysis_error: expect.stringMatching(/HTTP 500/),
      structured: null,
    });
    expect((await docRow('cl.pdf')).analysis_status).toBe('done');
  });

  test('refusal counts as failure and its cost is logged', async () => {
    await putDocument('cv', 'r.pdf', makePdf('STUB_REFUSE please'));
    const doc = await docRow('r.pdf');
    expect(doc).toMatchObject({ analysis_status: 'failed', analysis_error: expect.stringMatching(/declined/i), structured: null });
    expect(await db.query(`select base_document_id from cost_log`)).toEqual([{ base_document_id: doc.id }]);
  });

  test('failed analysis is retried with backoff then gives up', async () => {
    await putDocument('cv', 'fail.pdf', makePdf('STUB_FAIL please'));
    // Within a minute of attempt 1: not retried.
    await triggerDocumentsSync();
    expect(await stub.requests()).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      await db.query(`update base_documents set analysis_claimed_at = analysis_claimed_at - interval '10 minutes'`);
      await triggerDocumentsSync();
    }
    expect(await docRow('fail.pdf')).toMatchObject({ analysis_status: 'failed', analysis_attempts: 3 });
    expect(await stub.requests()).toHaveLength(3);
  });

  test('re-uploading identical content of a failed document retries it; a plain sync never does', async () => {
    const bytes = makePdf('CV A');
    await stub.failPurpose('analyse_cv');
    await putDocument('cv', 'a.pdf', bytes);
    for (let i = 0; i < 2; i++) {
      await db.query(`update base_documents set analysis_claimed_at = analysis_claimed_at - interval '10 minutes'`);
      await triggerDocumentsSync();
    }
    expect(await docRow('a.pdf')).toMatchObject({ analysis_status: 'failed', analysis_attempts: 3 });
    expect(await stub.requests()).toHaveLength(3);

    // Syncs alone (also with an invalid flag, the other kind's flag, or past the wait) leave the failed row alone: no new paid call.
    await db.query(`update base_documents set analysis_claimed_at = analysis_claimed_at - interval '10 minutes'`);
    await triggerDocumentsSync();
    for (const q of ['?retryFailedKind=resume', '?retryFailedKind=%27%3B%20drop', '?retryFailedKind=cover_letter', '?retryFailedKind=']) {
      const res = await fetch(`${N8N_URL}/webhook/api/documents/sync${q}`, { method: 'POST', headers: SYNC_HEADERS });
      expect(res.status).toBe(200);
    }
    await stub.reset();
    await triggerDocumentsSync();
    expect(await stub.requests()).toEqual([]);
    expect(await docRow('a.pdf')).toMatchObject({ analysis_status: 'failed', analysis_attempts: 3 });
  });

  test('re-uploading identical content of a failed document starts a fresh analysis', async () => {
    const bytes = makePdf('CV A');
    await stub.failPurpose('analyse_cv');
    await putDocument('cv', 'a.pdf', bytes);
    for (let i = 0; i < 2; i++) {
      await db.query(`update base_documents set analysis_claimed_at = analysis_claimed_at - interval '10 minutes'`);
      await triggerDocumentsSync();
    }
    expect(await docRow('a.pdf')).toMatchObject({ analysis_status: 'failed', analysis_attempts: 3 });
    await stub.reset();
    await putDocument('cv', 'a.pdf', bytes);
    expect(await docRow('a.pdf')).toMatchObject({
      active: true,
      analysis_status: 'done',
      analysis_attempts: 1,
      analysis_error: null,
    });
    expect((await stub.requests()).map(purposeOf)).toEqual(['purpose: analyse_cv']);
  });

  test('re-uploading a failed CV does not touch a failed cover letter', async () => {
    await stub.failPurpose('analyse_cv');
    await stub.failPurpose('analyse_cover_letter');
    await putDocument('cv', 'a.pdf', makePdf('CV A'));
    await putDocument('cover_letter', 'cl.pdf', makePdf('CL'));
    await db.query(`update base_documents set analysis_status='failed', analysis_attempts=3`);
    await stub.reset();
    await putDocument('cv', 'a.pdf', makePdf('CV A'));
    expect(await docRow('a.pdf')).toMatchObject({ analysis_status: 'done' });
    expect(await docRow('cl.pdf')).toMatchObject({ analysis_status: 'failed', analysis_attempts: 3 });
    expect((await stub.requests()).map(purposeOf)).toEqual(['purpose: analyse_cv']);
  });

  test('a Word file with no text is the current document but is never sent to Claude', async () => {
    await putDocument('cv', 'empty.docx', await makeDocx([{ text: '   ' }]));
    expect(await docRow('empty.docx')).toMatchObject({
      active: true,
      analysis_status: 'skipped',
      warnings: [expect.objectContaining({ code: 'unreadable_file' })],
      analysis_error: expect.any(String),
      structured: null,
    });
    expect(await stub.requests()).toEqual([]);
  });

  test('documents are only kept in the worker volume, never in a host folder', () => {
    const id = composeOutput(['ps', '-q', 'worker']).trim();
    const mounts: { Type: string; Destination: string; Name?: string }[] = JSON.parse(
      execFileSync('docker', ['inspect', '--format', '{{json .Mounts}}', id], { encoding: 'utf8' }),
    );
    const byTarget = Object.fromEntries(mounts.map((m) => [m.Destination, m]));
    expect(Object.keys(byTarget).sort()).toEqual(['/app/config', DOCUMENTS_DIR, '/data/joblisting']);
    expect(byTarget[DOCUMENTS_DIR]).toMatchObject({ Type: 'volume', Name: 'jobhunter-test_documents_test_data' });
  });

  describe('worker down', () => {
    afterEach(() => {
      compose(['up', '-d', '--wait', 'worker']);
    });

    test('a failed read of the storage stops the run, nothing changed', async () => {
      await putDocument('cv', 'a.pdf', makePdf('CV A'));
      await stub.reset();
      // A run that got past the read would claim this and call Claude, or retire it.
      await db.query(`update base_documents set analysis_status='pending'`);
      compose(['stop', 'worker']);
      const res = await fetch(`${N8N_URL}/webhook/api/documents/sync`, { method: 'POST', headers: SYNC_HEADERS });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ ok: false, error: 'scan_failed' });
      expect(await docRow('a.pdf')).toMatchObject({
        source_removed: false,
        active: true,
        analysis_status: 'pending',
        analysis_attempts: 1,
      });
      expect(await stub.requests()).toEqual([]);
    }, 180_000);
  });

  // Checks on the workflow JSON itself, for behaviour the fixed test env cannot reach.
  describe('workflow definition', () => {
    const wf = JSON.parse(readFileSync(join(ROOT, 'n8n', 'workflows', 'base-documents-sync.json'), 'utf8'));
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
      new Function('$env', nodeByName('Look up model price').parameters.jsCode)({ ANALYSE_MODEL: model });
    const analysisValues = () =>
      Object.fromEntries(
        nodeByName('Analysis prompts and schemas').parameters.assignments.assignments.map((a: any) => [a.name, a.value]),
      );

    test('stable id', () => {
      expect(wf.id).toBe('jh-base-documents-sync');
    });

    test('unknown model stops the run before any document is claimed or Claude is called', () => {
      expect(() => runPriceLookup('claude-unknown-9')).toThrow(/No price for model "claude-unknown-9"/);
      expect(runPriceLookup('claude-opus-5-5')[0].json).toMatchObject({
        model: 'claude-opus-5-5', input_usd_per_mtok: 4, output_usd_per_mtok: 20, fallbacks: true,
      });
      expect(runPriceLookup('claude-sonnet-5-5')[0].json).toMatchObject({ input_usd_per_mtok: 2, output_usd_per_mtok: 10, fallbacks: true });
      expect(runPriceLookup('claude-haiku-5-5')[0].json).toMatchObject({ input_usd_per_mtok: 0.1, output_usd_per_mtok: 0.5, fallbacks: false });
      expect(parentsOf('Claim pending analyses')).toEqual(['Look up model price']);
      expect(ancestorsOf('Ask Claude to analyse').has('Claim pending analyses')).toBe(true);
      expect(ancestorsOf('Look up model price').has('Ask Claude to analyse')).toBe(false);
    });

    test('cost uses the answering model price, else the requested one', () => {
      const workOut = (json: object) =>
        new Function('$json', '$', nodeByName('Work out cost').parameters.jsCode)(json, () => ({
          first: () => runPriceLookup('claude-opus-5-5')[0],
        })).json;
      const usage = { has_usage: true, input_tokens: 1000, output_tokens: 100 };
      expect(workOut({ ...usage, model: 'claude-sonnet-5-5' }).cost_usd).toBeCloseTo(0.003, 9);
      expect(workOut({ ...usage, model: 'claude-unpriced-1' }).cost_usd).toBeCloseTo(0.006, 9);
      expect(workOut({ ...usage, model: 'claude-opus-5-5' }).cost_usd).toBeCloseTo(0.006, 9);
      expect(workOut({ has_usage: false, model: 'claude-opus-5-5' }).cost_usd).toBeNull();
    });

    test('an analysis request may take up to 280 s, inside the 5-minute claim window', () => {
      // Longer than 5 minutes and a later run could reclaim the document and pay for it twice.
      expect(nodeByName('Ask Claude to analyse').parameters.options.timeout).toBe(280_000);
    });

    test('only the active document is claimed, and documents are activated after the old one is retired', () => {
      expect(nodeByName('Claim pending analyses').parameters.query).toMatch(/and d\.active\b/);
      expect(parentsOf('Activate stored documents')).toEqual(['Retire replaced documents']);
      expect(ancestorsOf('Give up on stuck analyses').has('Activate stored documents')).toBe(true);
    });

    test('no folder scan, newest-file or ignored-file rule is left', () => {
      expect(JSON.stringify(wf)).not.toMatch(/extra_file_ignored|modifiedAt|newest|folder/i);
    });

    test('the schedule reads the documents only when something is due', () => {
      expect(parentsOf('Read stored documents').sort()).toEqual(['Has X-JobHunter header?', 'Run needed?']);
      expect(parentsOf('Run needed?')).toEqual(['Anything to do?']);
      expect(parentsOf('Anything to do?')).toEqual(['Worker answered?']);
      expect(parentsOf('Worker answered?')).toEqual(['List stored documents']);
      expect(parentsOf('List stored documents')).toEqual(['Schedule enabled?']);
      expect(nodeByName('List stored documents').parameters).toMatchObject({ method: 'GET', url: '={{ $env.WORKER_URL }}/documents' });
      // Only the "true" branches go on.
      expect(wf.connections['Run needed?'].main[1]).toEqual([]);
      expect(wf.connections['Worker answered?'].main[1]).toEqual([]);
    });

    describe('"Anything to do?" query', () => {
      const due = async (stored: { kind: string; sourceRef: string; contentHash: string }[]) =>
        (await db.query(nodeByName('Anything to do?').parameters.query, [OWNER, JSON.stringify(stored)]))[0].due;
      const insert = (over: Record<string, unknown>) =>
        db.query(
          `insert into base_documents (owner_id, kind, source_ref, content_hash, media_type, analysis_status,
                                       analysis_attempts, analysis_claimed_at, active, source_removed)
           values ($1, $2, $3, $4, 'application/pdf', $5, $6, $7, $8, $9)`,
          [OWNER, over.kind ?? 'cv', over.ref ?? 'a.pdf', over.hash ?? 'h1', over.status ?? 'done', over.attempts ?? 1,
           over.claimedAt ?? null, over.active ?? true, over.removed ?? false],
        );
      const CV = { kind: 'cv', sourceRef: 'a.pdf', contentHash: 'h1' };
      beforeEach(async () => {
        await resetState();
      });

      test('nothing stored and nothing in the database: not due', async () => {
        expect(await due([])).toBe(false);
      });

      test('an analysed current document that is still stored: not due', async () => {
        await insert({});
        await insert({ ref: 'old.pdf', hash: 'h0', active: false, removed: true });
        expect(await due([CV])).toBe(false);
      });

      test('a stored document whose sync did not run, a changed one, or a missing one: due', async () => {
        expect(await due([CV])).toBe(true);
        await insert({});
        expect(await due([{ ...CV, contentHash: 'h2' }])).toBe(true);
        expect(await due([])).toBe(true);
      });

      test('analyses: pending, failed past its wait, stuck with attempts left are due; others not', async () => {
        await insert({ status: 'pending', attempts: 0 });
        expect(await due([CV])).toBe(true);
        await db.query(`update base_documents set analysis_status='failed', analysis_attempts=1, analysis_claimed_at=now()`);
        expect(await due([CV])).toBe(false);
        await db.query(`update base_documents set analysis_claimed_at=now() - interval '2 minutes'`);
        expect(await due([CV])).toBe(true);
        await db.query(`update base_documents set analysis_attempts=2`);
        expect(await due([CV])).toBe(false);
        await db.query(`update base_documents set analysis_attempts=3, analysis_claimed_at=now() - interval '1 hour'`);
        expect(await due([CV])).toBe(false);
        await db.query(`update base_documents set analysis_status='in_progress', analysis_attempts=2`);
        expect(await due([CV])).toBe(true);
      });

      test('gives up on a stuck analysis with all attempts used', async () => {
        await insert({ status: 'in_progress', attempts: 3, claimedAt: new Date(Date.now() - 10 * 60_000) });
        expect(await due([CV])).toBe(false);
        expect(await docRow('a.pdf')).toMatchObject({ analysis_status: 'failed', analysis_error: expect.stringMatching(/3 attempts/) });
      });
    });

    test('saves only apply to the claim made by this run', () => {
      for (const name of ['Save analysis', 'Mark analysis failed', 'Mark failed: checks unavailable']) {
        expect(nodeByName(name).parameters.query).toMatch(/analysis_claimed_at = \$2::timestamptz/);
      }
      expect(nodeByName('Claim pending analyses').parameters.query).toMatch(/for update of d skip locked/);
    });

    test('prompts in the workflow match n8n/prompts', () => {
      const values = analysisValues();
      expect(normalise(values.cv_prompt)).toBe(normalise(prompt('analyse-cv.md')));
      expect(normalise(values.cover_letter_prompt)).toBe(normalise(prompt('analyse-cover-letter.md')));
      for (const file of ['analyse-cv.md', 'analyse-cover-letter.md']) {
        expect(prompt(file).split(/\r?\n/)[0]).toBe(`purpose: ${file.replace('.md', '').replace(/-/g, '_')}`);
      }
    });

    test('analysis schema has no labelSuggestion', () => {
      const values = analysisValues();
      for (const key of ['cv_schema', 'cover_letter_schema']) {
        const schema = JSON.parse(values[key]);
        expect(schema.required).not.toContain('labelSuggestion');
        expect(schema.properties).not.toHaveProperty('labelSuggestion');
      }
      for (const file of ['analyse-cv.md', 'analyse-cover-letter.md']) expect(prompt(file)).not.toMatch(/label/i);
      expect(JSON.stringify(wf)).not.toMatch(/label_suggest|labelSuggestion/);
    });

    test('no conflict check stage, prompt or table is left', () => {
      expect(JSON.stringify(wf)).not.toMatch(/check_cv_conflicts|conflict check|conflictsChecked|cross-CV|base_document_checks/i);
      expect(existsSync(join(ROOT, 'n8n', 'prompts', 'check-cv-conflicts.md'))).toBe(false);
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

describe('shipped workflows', () => {
  const dir = join(ROOT, 'n8n', 'workflows');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  test("shipped workflows don't save successful runs", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const { settings } = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      expect(settings, file).toMatchObject({ saveDataSuccessExecution: 'none', saveManualExecutions: false });
      // Failed runs are still kept for debugging.
      expect(settings.saveDataErrorExecution ?? 'all', file).toBe('all');
    }
  });

  test('no workflow refers to the removed document folders, ignored files or delete', () => {
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text, file).not.toMatch(/extra_file_ignored|CV_DIR|COVER_LETTER_DIR|PersonalDetails|\/data\/cv|cover-letter folder/);
    }
    const api = JSON.parse(readFileSync(join(dir, 'documents-api.json'), 'utf8'));
    expect(api.nodes.filter((n: any) => n.type === 'n8n-nodes-base.webhook').map((n: any) => n.parameters.httpMethod).sort()).toEqual([
      'GET',
      'POST',
    ]);
  });
});
