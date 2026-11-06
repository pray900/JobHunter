import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  touchDocument,
  triggerDocumentsSync,
  writeDocument,
} from './lib';

const PDF = 'application/pdf';
const normalise = (s: string) => s.replace(/\r\n/g, '\n').trim();
const prompt = (name: string) => readFileSync(join(ROOT, 'n8n', 'prompts', name), 'utf8');
const JAN = new Date('2026-01-01T00:00:00Z');
const FEB = new Date('2026-02-01T00:00:00Z');
const MAR = new Date('2026-03-01T00:00:00Z');
const CV_IGNORED = { code: 'extra_file_ignored', detail: 'Only one CV is used; this file is ignored.' };
const bigPdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x20)]);

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
    writeDocument('cv', 'a.pdf', makePdf('CV A'));
    const res = await fetch(`${N8N_URL}/webhook/api/documents/sync`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'missing_jobhunter_header' });
    expect(await db.query(`select id from base_documents`)).toEqual([]);
    expect(await stub.requests()).toEqual([]);
  });

  test('new PDF CV is analysed, checked and active', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A'));
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 1, analysed: 1 });
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
    expect(doc).not.toHaveProperty('label');
    expect(doc).not.toHaveProperty('label_suggested');
    expect(doc.structured.workRights).toBeNull();
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

  test('cost is priced by the model that answered', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A STUB_MODEL:claude-sonnet-5-5'));
    await triggerDocumentsSync();
    const [cost] = await db.query(`select model, cost_usd from cost_log`);
    expect(cost.model).toBe('claude-sonnet-5-5');
    expect(Number(cost.cost_usd)).toBeCloseTo(0.003, 6); // 1000 x $2 + 100 x $10 per 1M
  });

  test('an answering model without a price is costed at the requested model price', async () => {
    writeDocument('cover_letter', 'cl.pdf', makePdf('CL STUB_MODEL:claude-unpriced-1'));
    await triggerDocumentsSync();
    const [cost] = await db.query(`select model, cost_usd from cost_log`);
    expect(cost.model).toBe('claude-unpriced-1');
    expect(Number(cost.cost_usd)).toBeCloseTo(0.006, 6);
  });

  test('unchanged document is not analysed again', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A'));
    await triggerDocumentsSync();
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 1, analysed: 0 });
    expect(await stub.requests()).toHaveLength(1);
  });

  test('overlapping syncs do not double-call Claude', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A'));
    await Promise.all([triggerDocumentsSync(), triggerDocumentsSync()]);
    expect((await stub.requests()).map(purposeOf)).toEqual(['purpose: analyse_cv']);
    expect(await db.query(`select id from base_documents`)).toHaveLength(1);
  });

  test('changed file is analysed again', async () => {
    writeDocument('cv', 'a.pdf', makePdf('v1'));
    await triggerDocumentsSync();
    const before = await docRow('a.pdf');
    writeDocument('cv', 'a.pdf', makePdf('v2'));
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 1, analysed: 1 });
    const after = await docRow('a.pdf');
    expect(after).toMatchObject({ id: before.id, active: true, analysis_status: 'done', analysis_attempts: 1 });
    expect(after.content_hash).not.toBe(before.content_hash);
    expect((await stub.requests()).map(sentText)).toEqual([expect.stringContaining('v1'), expect.stringContaining('v2')]);
  });

  test('cover letter uses cover-letter prompt', async () => {
    writeDocument('cover_letter', 'cl.docx', await makeDocx([{ text: 'Dear Ms Li,' }, { text: 'I would like to apply.' }]));
    await triggerDocumentsSync();
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
      ['contact', 'education', 'headline', 'metrics', 'projects', 'roles', 'skills', 'summary', 'workRights'],
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

  test('two CVs: only the newest is analysed, the other is ignored', async () => {
    writeDocument('cv', 'old.pdf', makePdf('OLD CV'), JAN);
    writeDocument('cv', 'new.pdf', makePdf('NEW CV'), FEB);
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 2, analysed: 1 });
    const reqs = await stub.requests();
    expect(reqs.map(purposeOf)).toEqual(['purpose: analyse_cv']);
    expect(sentText(reqs[0])).toContain('NEW CV');
    expect(await docRow('new.pdf')).toMatchObject({ active: true, analysis_status: 'done' });
    expect(await docRow('old.pdf')).toMatchObject({
      active: false,
      analysis_status: 'skipped',
      analysis_attempts: 0,
      structured: null,
      warnings: [CV_IGNORED],
    });
    // Nothing changed in the folders: nothing more is sent.
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 2, analysed: 0 });
    expect(await stub.requests()).toHaveLength(1);
  });

  test('same modification time: the first name in order is used', async () => {
    writeDocument('cv', 'b.pdf', makePdf('CV B'), JAN);
    writeDocument('cv', 'a.pdf', makePdf('CV A'), JAN);
    await triggerDocumentsSync();
    expect((await docRow('a.pdf')).active).toBe(true);
    expect((await docRow('b.pdf')).active).toBe(false);
  });

  test('newer CV takes over', async () => {
    writeDocument('cv', 'first.pdf', makePdf('FIRST CV'), JAN);
    writeDocument('cv', 'second.pdf', makePdf('SECOND CV'), FEB);
    await triggerDocumentsSync();
    expect((await docRow('second.pdf')).structured).not.toBeNull();
    touchDocument('cv', 'first.pdf', MAR); // same content, now the newest file
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 2, analysed: 1 });
    const reqs = await stub.requests();
    expect(reqs.map(sentText)).toEqual([expect.stringContaining('SECOND CV'), expect.stringContaining('FIRST CV')]);
    expect(await docRow('first.pdf')).toMatchObject({
      active: true,
      analysis_status: 'done',
      analysis_attempts: 1,
      warnings: [expect.objectContaining({ code: 'missing_work_rights' })],
    });
    // The one no longer used keeps no analysis facts and no analysis warnings.
    expect(await docRow('second.pdf')).toMatchObject({
      active: false,
      analysis_status: 'skipped',
      structured: null,
      warnings: [CV_IGNORED],
    });
  });

  test('CV and cover letter are each picked on their own', async () => {
    writeDocument('cv', 'cv-old.pdf', makePdf('CV OLD'), JAN);
    writeDocument('cv', 'cv-new.pdf', makePdf('CV NEW'), FEB);
    writeDocument('cover_letter', 'cl-new.pdf', makePdf('CL NEW'), MAR);
    writeDocument('cover_letter', 'cl-old.pdf', makePdf('CL OLD'), JAN);
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 4, analysed: 2 });
    const sent = (await stub.requests()).map(sentText).join('\n');
    expect(sent).toContain('CV NEW');
    expect(sent).toContain('CL NEW');
    expect(sent).not.toContain('OLD');
    expect(await db.query(`select source_ref from base_documents where active order by kind`)).toEqual([
      { source_ref: 'cl-new.pdf' },
      { source_ref: 'cv-new.pdf' },
    ]);
    expect((await docRow('cl-old.pdf')).warnings).toEqual([
      { code: 'extra_file_ignored', detail: 'Only one cover letter is used; this file is ignored.' },
    ]);
  });

  test('removing the active CV makes the remaining one active', async () => {
    writeDocument('cv', 'old.pdf', makePdf('OLD CV'), JAN);
    writeDocument('cv', 'new.pdf', makePdf('NEW CV'), FEB);
    await triggerDocumentsSync();
    removeDocument('cv', 'new.pdf');
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 1, analysed: 1 });
    expect(await docRow('new.pdf')).toMatchObject({ source_removed: true, active: false });
    expect(await docRow('old.pdf')).toMatchObject({
      active: true,
      analysis_status: 'done',
      warnings: [expect.objectContaining({ code: 'missing_work_rights' })],
    });
    expect((await stub.requests()).map(sentText)).toEqual([expect.stringContaining('NEW CV'), expect.stringContaining('OLD CV')]);
  });

  test('an unreadable newest file is ignored and the readable one is used', async () => {
    writeDocument('cv', 'big.pdf', bigPdf(), FEB);
    writeDocument('cv', 'ok.pdf', makePdf('OK CV'), JAN);
    await triggerDocumentsSync();
    expect(await docRow('ok.pdf')).toMatchObject({ active: true, analysis_status: 'done' });
    const big = await docRow('big.pdf');
    expect(big).toMatchObject({ active: false, analysis_status: 'skipped', structured: null });
    expect(big.warnings.map((w: any) => w.code)).toEqual(['unreadable_file', 'extra_file_ignored']);
    expect((await stub.requests()).map(sentText)).toEqual([expect.stringContaining('OK CV')]);
  });

  test('no conflict check is ever called', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A'), JAN);
    writeDocument('cv', 'b.pdf', makePdf('CV B'), FEB);
    await triggerDocumentsSync();
    touchDocument('cv', 'a.pdf', MAR);
    await triggerDocumentsSync();
    await triggerDocumentsSync();
    expect((await stub.requests()).map(purposeOf)).toEqual(['purpose: analyse_cv', 'purpose: analyse_cv']);
    expect(await db.query(`select to_regclass('base_document_checks') as t`)).toEqual([{ t: null }]);
  });

  test('a failed CV does not block the cover letter', async () => {
    writeDocument('cv', 'bad.pdf', makePdf('STUB_FAIL please'));
    writeDocument('cover_letter', 'cl.pdf', makePdf('CL'));
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 2, analysed: 1 });
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
    writeDocument('cv', 'big.pdf', bigPdf());
    await triggerDocumentsSync();
    expect(await docRow('big.pdf')).toMatchObject({
      active: false,
      analysis_status: 'skipped',
      warnings: [expect.objectContaining({ code: 'unreadable_file' })],
      analysis_error: expect.any(String),
      structured: null,
    });
    expect(await stub.requests()).toEqual([]);
  });

  test('removed file is marked removed and is no longer active', async () => {
    writeDocument('cv', 'a.pdf', makePdf('CV A'));
    await triggerDocumentsSync();
    await stub.reset();
    removeDocument('cv', 'a.pdf');
    expect(await triggerDocumentsSync()).toEqual({ ok: true, scanned: 0, analysed: 0 });
    expect(await docRow('a.pdf')).toMatchObject({ source_removed: true, active: false, analysis_status: 'done' });
    expect(await stub.requests()).toEqual([]);
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

    test('an analysis request may take up to 600 s', () => {
      expect(nodeByName('Ask Claude to analyse').parameters.options.timeout).toBe(600_000);
    });

    test('active document rule: newest readable file per kind, ties by name', () => {
      const pick = (documents: object[]) =>
        new Function('$', nodeByName('Pick the active documents').parameters.jsCode)(() => ({
          first: () => ({ json: { documents } }),
        }))[0].json.active;
      const doc = (kind: string, sourceRef: string, modifiedAt: string, warnings: string[] = []) => ({
        kind, sourceRef, modifiedAt, warnings,
      });
      expect(
        pick([
          doc('cv', 'b.pdf', '2026-01-01T00:00:00.000Z'),
          doc('cv', 'a.pdf', '2026-01-01T00:00:00.000Z'),
          doc('cv', 'z.pdf', '2025-12-01T00:00:00.000Z'),
          doc('cv', 'big.pdf', '2026-05-01T00:00:00.000Z', ['unreadable_file']),
          doc('cover_letter', 'old.docx', '2026-01-01T00:00:00.000Z'),
          doc('cover_letter', 'new.docx', '2026-04-01T00:00:00.000Z'),
        ]),
      ).toEqual([
        { kind: 'cv', sourceRef: 'a.pdf' },
        { kind: 'cover_letter', sourceRef: 'new.docx' },
      ]);
      expect(pick([doc('cv', 'big.pdf', '2026-05-01T00:00:00.000Z', ['unreadable_file'])])).toEqual([]);
      expect(pick([])).toEqual([]);
      // Only the active document is ever claimed for analysis.
      expect(nodeByName('Claim pending analyses').parameters.query).toMatch(/and d\.active\b/);
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
});
