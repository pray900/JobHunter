import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest';
import { makeDocx } from '../helpers/makeDocx';
import {
  N8N_URL,
  ROOT,
  SYNC_HEADERS,
  compose,
  db,
  makePdf,
  removeDocument,
  resetState,
  stub,
  triggerDocumentsSync,
  writeDocument,
} from './lib';

const PDF = 'application/pdf';
const normalise = (s: string) => s.replace(/\r\n/g, '\n').trim();
const prompt = (name: string) => readFileSync(join(ROOT, 'n8n', 'prompts', name), 'utf8');
const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
/** basis_hash = sha256 of the ready CVs' content hashes, sorted and joined with "\n". */
const basisOf = (files: Buffer[]) => sha256(files.map((f) => sha256(f)).sort().join('\n'));

const docRow = async (sourceRef: string) =>
  (await db.query(`select * from base_documents where source_ref=$1`, [sourceRef]))[0];
const purposeOf = (body: any) => String(body.system ?? '').split(/\r?\n/)[0];
const userText = (body: any) =>
  body.messages[0].content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n');

describe('base documents sync', () => {
  beforeEach(async () => {
    await resetState();
  });
  afterAll(async () => {
    await resetState();
  });

  test('webhook without X-JobHunter header is refused and runs nothing', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A'));
    const res = await fetch(`${N8N_URL}/webhook/api/documents/sync`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'missing_jobhunter_header' });
    expect(await db.query(`select id from base_documents`)).toEqual([]);
    expect(await stub.requests()).toEqual([]);
  });

  test('new PDF CV is analysed, labelled and checked', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A STUB_LABEL:LLM / QA'));
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 1, analysed: 1, conflictsChecked: true });
    const doc = await docRow('a.pdf');
    expect(doc).toMatchObject({
      kind: 'cv',
      media_type: PDF,
      label: 'LLM / QA',
      label_suggested: 'LLM / QA',
      analysis_status: 'done',
      analysis_attempts: 1,
      analysis_error: null,
      source_removed: false,
    });
    expect(doc.structured.workRights).toBeNull();
    expect(doc.structured).not.toHaveProperty('labelSuggestion');
    expect(doc.warnings).toContainEqual(expect.objectContaining({ code: 'missing_work_rights' }));
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
  });

  test('unchanged document is not analysed again', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A'));
    await triggerDocumentsSync();
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 1, analysed: 0, conflictsChecked: false });
    expect(await stub.requests()).toHaveLength(1);
  });

  test('overlapping syncs do not double-call Claude', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A'));
    await Promise.all([triggerDocumentsSync(), triggerDocumentsSync()]);
    expect((await stub.requests()).map(purposeOf)).toEqual(['purpose: analyse_cv']);
    expect(await db.query(`select id from base_documents`)).toHaveLength(1);
  });

  test('relabel survives re-analysis', async () => {
    writeDocument('cv', 'a.pdf', makePdf('v1 STUB_LABEL:LLM / QA'));
    await triggerDocumentsSync();
    const before = await docRow('a.pdf');
    await db.query(`update base_documents set label='My own label' where id=$1`, [before.id]);
    writeDocument('cv', 'a.pdf', makePdf('v2 STUB_LABEL:Data engineering'));
    await triggerDocumentsSync();
    const after = await docRow('a.pdf');
    expect(after).toMatchObject({
      id: before.id,
      label: 'My own label',
      label_suggested: 'Data engineering',
      analysis_status: 'done',
      analysis_attempts: 1,
    });
    expect(after.content_hash).not.toBe(before.content_hash);
    expect(await stub.requests()).toHaveLength(2);
  });

  test('cover letter uses cover-letter prompt', async () => {
    writeDocument('cover_letter', 'cl.docx', await makeDocx([{ text: 'Dear Ms Li,' }, { text: 'I would like to apply.' }]));
    await triggerDocumentsSync();
    const doc = await docRow('cl.docx');
    expect(doc).toMatchObject({ kind: 'cover_letter', analysis_status: 'done', label_suggested: 'Stub cover letter' });
    expect(doc.structured).toMatchObject({ previousTarget: { company: 'Stub Company' }, toneNotes: expect.any(String) });
    const reqs = await stub.requests();
    expect(reqs).toHaveLength(1); // cover letters are not CVs: no conflict check
    expect(purposeOf(reqs[0])).toBe('purpose: analyse_cover_letter');
    expect(normalise(reqs[0].system)).toBe(normalise(prompt('analyse-cover-letter.md')));
    // DOCX goes as extracted text inside <document> tags.
    expect(reqs[0].messages[0].content[0]).toEqual({ type: 'text', text: '<document>\nDear Ms Li,\nI would like to apply.\n</document>' });
    expect([...reqs[0].output_config.format.schema.required].sort()).toEqual(
      ['labelSuggestion', 'previousTarget', 'reusableParagraphs', 'toneNotes'],
    );
    expect((await db.query(`select purpose from cost_log`))).toEqual([{ purpose: 'analyse_cover_letter' }]);
  });

  test('request is a PDF document block and sends fallbacks for opus', async () => {
    const bytes = makePdf('CV A');
    writeDocument('cv', 'a.pdf', bytes);
    await triggerDocumentsSync();
    const [{ headers, body }] = await stub.requestLog();
    expect(headers['anthropic-beta']).toBe('server-side-fallback-2026-07-01');
    expect(headers['anthropic-version']).toBe('2026-10-21');
    expect(body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000, fallbacks: 'default' });
    expect(body.output_config.effort).toBe('medium');
    expect(body.output_config.format.type).toBe('json_schema');
    const schema = body.output_config.format.schema;
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect([...schema.required].sort()).toEqual(
      ['contact', 'education', 'headline', 'labelSuggestion', 'metrics', 'projects', 'roles', 'skills', 'summary', 'workRights'],
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

  test('two CVs trigger one conflict check, unchanged basis does not repeat it', async () => {
    const a = makePdf('CV A');
    const b = makePdf('CV B');
    writeDocument('cv', 'a.pdf', a);
    writeDocument('cv', 'b.pdf', b);
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 2, analysed: 2, conflictsChecked: true });
    const reqs = await stub.requests();
    expect(reqs.map(purposeOf).sort()).toEqual(['purpose: analyse_cv', 'purpose: analyse_cv', 'purpose: check_cv_conflicts']);
    const conflictReq = reqs.find((r) => purposeOf(r) === 'purpose: check_cv_conflicts');
    expect(normalise(conflictReq.system)).toBe(normalise(prompt('check-cv-conflicts.md')));
    expect(conflictReq).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000, fallbacks: 'default' });
    expect(userText(conflictReq)).toContain('"sourceRef":"a.pdf"');
    expect(userText(conflictReq)).toContain('"sourceRef":"b.pdf"');
    const checks = await db.query(`select basis_hash, conflicts from base_document_checks`);
    expect(checks).toHaveLength(1);
    expect(checks[0].basis_hash).toBe(basisOf([a, b]));
    expect(checks[0].conflicts).toEqual([
      {
        fact: 'Team size',
        values: [
          { sourceRef: 'a.pdf', text: 'Led a team of 5' },
          { sourceRef: 'b.pdf', text: 'for a 5-developer team' },
        ],
        suggestion: 'Worked in a 5-developer team',
      },
    ]);
    const conflictCost = await db.query(`select base_document_id, purpose from cost_log where purpose='check_cv_conflicts'`);
    expect(conflictCost).toEqual([{ base_document_id: null, purpose: 'check_cv_conflicts' }]);

    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 2, analysed: 0, conflictsChecked: false });
    expect(await stub.requests()).toHaveLength(3);
    expect(await db.query(`select id from base_document_checks`)).toHaveLength(1);
  });

  test('one CV gives conflicts [] with no Claude call', async () => {
    const a = makePdf('CV A');
    writeDocument('cv', 'a.pdf', a);
    await triggerDocumentsSync();
    expect((await stub.requests()).map(purposeOf)).toEqual(['purpose: analyse_cv']);
    expect(await db.query(`select basis_hash, conflicts from base_document_checks`)).toEqual([
      { basis_hash: basisOf([a]), conflicts: [] },
    ]);
  });

  test('one failed document does not block others', async () => {
    const a = makePdf('CV A');
    const b = makePdf('CV B');
    writeDocument('cv', 'a.pdf', a);
    writeDocument('cv', 'b.pdf', b);
    writeDocument('cv', 'bad.pdf', makePdf('STUB_FAIL please'));
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 3, analysed: 2, conflictsChecked: true });
    expect(await docRow('bad.pdf')).toMatchObject({
      analysis_status: 'failed',
      analysis_attempts: 1,
      analysis_error: expect.stringMatching(/HTTP 500/),
      structured: null,
      label: null,
    });
    expect((await docRow('a.pdf')).analysis_status).toBe('done');
    expect((await docRow('b.pdf')).analysis_status).toBe('done');
    const conflictReq = (await stub.requests()).find((r) => purposeOf(r) === 'purpose: check_cv_conflicts');
    expect(userText(conflictReq)).not.toContain('bad.pdf');
    expect(await db.query(`select basis_hash from base_document_checks`)).toEqual([{ basis_hash: basisOf([a, b]) }]);
  });

  test('refusal counts as failure and its cost is logged', async () => {
    writeDocument('cv', 'r.pdf', makePdf('STUB_REFUSE please'));
    await triggerDocumentsSync();
    const doc = await docRow('r.pdf');
    expect(doc).toMatchObject({ analysis_status: 'failed', analysis_error: expect.stringMatching(/declined/i), structured: null });
    expect(await db.query(`select base_document_id from cost_log`)).toEqual([{ base_document_id: doc.id }]);
  });

  test('failed analysis is retried with backoff then gives up', async () => {
    writeDocument('cv', 'fail.pdf', makePdf('STUB_FAIL please'));
    await triggerDocumentsSync();
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

  test('over-5 MB file is skipped without a Claude call', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x20)]);
    writeDocument('cv', 'big.pdf', big);
    await triggerDocumentsSync();
    expect(await docRow('big.pdf')).toMatchObject({
      analysis_status: 'skipped',
      warnings: [expect.objectContaining({ code: 'unreadable_file' })],
      analysis_error: expect.any(String),
      structured: null,
    });
    expect(await stub.requests()).toEqual([]);
  });

  test('removed file is marked removed and leaves the conflict basis', async () => {
    const a = makePdf('CV A');
    writeDocument('cv', 'a.pdf', a);
    writeDocument('cv', 'b.pdf', makePdf('CV B'));
    await triggerDocumentsSync();
    await stub.reset();
    removeDocument('cv', 'b.pdf');
    await triggerDocumentsSync();
    expect(await docRow('b.pdf')).toMatchObject({ source_removed: true, analysis_status: 'done' });
    expect(await stub.requests()).toEqual([]); // one ready CV left: no Claude call
    const basis = await db.query(`select conflicts from base_document_checks where basis_hash=$1`, [basisOf([a])]);
    expect(basis).toEqual([{ conflicts: [] }]);
  });

  test('failed conflict check stores nothing and the next sync from the app retries it', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A'));
    writeDocument('cv', 'b.pdf', makePdf('CV B'));
    await stub.failPurpose('check_cv_conflicts');
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 2, analysed: 2, conflictsChecked: false });
    expect(await db.query(`select id from base_document_checks`)).toEqual([]);
    // A 500 has no usage, so only the two analyses are logged as cost.
    expect(await db.query(`select purpose from cost_log order by purpose`)).toEqual([{ purpose: 'analyse_cv' }, { purpose: 'analyse_cv' }]);
    await stub.reset();
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 2, analysed: 0, conflictsChecked: true });
    expect((await stub.requests()).map(purposeOf)).toEqual(['purpose: check_cv_conflicts']);
    expect(await db.query(`select id from base_document_checks`)).toHaveLength(1);
  });

  describe('missing cv folder', () => {
    const ALT_WORKER = 'jobhunter-test-worker-no-cv-folder';
    const removeAltWorker = () => {
      try {
        execFileSync('docker', ['rm', '-f', ALT_WORKER], { stdio: 'ignore' });
      } catch {
        // not running
      }
    };

    afterEach(() => {
      removeAltWorker();
      compose(['up', '-d', '--wait', 'worker']);
    });

    test('missing cv folder stops the run, nothing changed', async () => {
      writeDocument('cv', 'a.pdf', makePdf('CV A'));
      await triggerDocumentsSync();
      await stub.reset();
      // A run that got past the scan would claim this and call Claude, or mark it removed.
      await db.query(`update base_documents set analysis_status='pending'`);
      compose(['stop', 'worker']);
      // The real worker image, but its CV folder does not exist.
      execFileSync('docker', [
        'run', '-d', '--rm', '--name', ALT_WORKER, '--network', 'jobhunter-test_default', '--network-alias', 'worker',
        '-e', 'DATABASE_URL=postgres://jobhunter:test@postgres:5432/jobhunter',
        '-e', 'JOBLISTING_DIR=/data/joblisting', '-e', 'CV_DIR=/data/no-such-cv-folder', '-e', 'COVER_LETTER_DIR=/tmp',
        'jobhunter-test-worker',
      ], { stdio: 'ignore' });
      let status = '';
      for (let i = 0; i < 100 && status !== '503'; i++) {
        const out: string = execFileSync('docker', ['compose', '-f', join(ROOT, 'docker-compose.test.yml'), 'exec', '-T', 'n8n', 'node', '-e',
          `fetch('http://worker:3001/documents/scan',{method:'POST'}).then(r=>console.log(r.status)).catch(()=>console.log(0))`], { encoding: 'utf8' });
        status = out.trim();
        if (status !== '503') await new Promise((r) => setTimeout(r, 300));
      }
      expect(status).toBe('503'); // n8n really reaches a worker reporting document_folder_missing

      const res = await fetch(`${N8N_URL}/webhook/api/documents/sync`, { method: 'POST', headers: SYNC_HEADERS });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ ok: false, error: 'scan_failed' });
      expect(await docRow('a.pdf')).toMatchObject({ source_removed: false, analysis_status: 'pending', analysis_attempts: 1 });
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

    test('stable id', () => {
      expect(wf.id).toBe('jh-base-documents-sync');
    });

    test('unknown model stops the run before any document is claimed or Claude is called', () => {
      expect(() => runPriceLookup('claude-unknown-9')).toThrow(/No price for model "claude-unknown-9"/);
      expect(runPriceLookup('claude-opus-5-5')[0].json).toEqual({
        model: 'claude-opus-5-5', input_usd_per_mtok: 4, output_usd_per_mtok: 20, fallbacks: true,
      });
      expect(runPriceLookup('claude-sonnet-5-5')[0].json).toMatchObject({ input_usd_per_mtok: 2, output_usd_per_mtok: 10, fallbacks: true });
      expect(runPriceLookup('claude-haiku-5-5')[0].json).toMatchObject({ input_usd_per_mtok: 0.1, output_usd_per_mtok: 0.5, fallbacks: false });
      expect(parentsOf('Claim pending analyses')).toEqual(['Look up model price']);
      for (const call of ['Ask Claude to analyse', 'Ask Claude about conflicts']) {
        expect(ancestorsOf(call).has('Claim pending analyses')).toBe(true);
      }
      expect(ancestorsOf('Look up model price').has('Ask Claude to analyse')).toBe(false);
    });

    test('saves only apply to the claim made by this run', () => {
      for (const name of ['Save analysis', 'Mark analysis failed', 'Mark failed: checks unavailable']) {
        expect(nodeByName(name).parameters.query).toMatch(/analysis_claimed_at = \$2::timestamptz/);
      }
      expect(nodeByName('Claim pending analyses').parameters.query).toMatch(/for update of d skip locked/);
    });

    test('prompts in the workflow match n8n/prompts', () => {
      const values = (name: string) =>
        Object.fromEntries(nodeByName(name).parameters.assignments.assignments.map((a: any) => [a.name, a.value]));
      const analysis = values('Analysis prompts and schemas');
      expect(normalise(analysis.cv_prompt)).toBe(normalise(prompt('analyse-cv.md')));
      expect(normalise(analysis.cover_letter_prompt)).toBe(normalise(prompt('analyse-cover-letter.md')));
      expect(normalise(values('Conflict prompt and schema').system_prompt)).toBe(normalise(prompt('check-cv-conflicts.md')));
      for (const file of ['analyse-cv.md', 'analyse-cover-letter.md', 'check-cv-conflicts.md']) {
        expect(prompt(file).split(/\r?\n/)[0]).toBe(`purpose: ${file.replace('.md', '').replace(/-/g, '_')}`);
      }
    });

    test('a schedule run that changed nothing does not retry a failed conflict check', () => {
      const decide = (ready: object, executed: Record<string, object[]>) =>
        new Function('$input', '$', nodeByName('Decide conflict check').parameters.jsCode)(
          { first: () => ({ json: ready }) },
          (name: string) => ({ isExecuted: name in executed, all: () => (executed[name] ?? []).map((json) => ({ json })) }),
        )[0].json.action;
      const twoCvs = { basis_hash: 'h', ready_count: 2, cvs: [], already_checked: false };
      const nothingChanged = { 'Save analysis': [], 'Mark removed documents': [{ success: true }] };
      expect(decide(twoCvs, nothingChanged)).toBe('wait');
      expect(decide(twoCvs, { ...nothingChanged, 'POST api/documents/sync': [{}] })).toBe('ask_claude');
      expect(decide(twoCvs, { ...nothingChanged, 'Save analysis': [{ id: 'x' }] })).toBe('ask_claude');
      expect(decide(twoCvs, { ...nothingChanged, 'Mark removed documents': [{ id: 'x' }] })).toBe('ask_claude');
      expect(decide({ ...twoCvs, ready_count: 1 }, nothingChanged)).toBe('none');
      expect(decide({ ...twoCvs, already_checked: true }, { ...nothingChanged, 'POST api/documents/sync': [{}] })).toBe('skip');
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
