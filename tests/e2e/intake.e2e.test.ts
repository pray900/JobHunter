import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  N8N_URL,
  ROOT,
  compose,
  db,
  removeJobFile,
  resetState,
  stub,
  triggerSync,
  writeJobFile,
  writeRawJobFile,
} from './lib';

const jobRow = async (sourceRef: string) =>
  (await db.query(`select * from jobs where source_ref=$1`, [sourceRef]))[0];

const normalise = (s: string) => s.replace(/\r\n/g, '\n').trim();

describe('job intake sync', () => {
  beforeEach(async () => {
    await resetState();
  });
  // Leave the stack clean for other e2e files (infra expects an empty stub log).
  afterAll(async () => {
    await resetState();
  });

  test('new file becomes a job with extracted details', async () => {
    await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'Salesforce Developer at Acme' }]);
    await triggerSync();
    const job = await jobRow('a.docx');
    expect(job).toMatchObject({
      url: 'https://x.io/a',
      title: 'Stub Title',
      employer: 'Stub Employer',
      advertiser: null,
      short_description: 'Stub description.',
      status: 'new',
      extraction_status: 'done',
      source_removed: false,
      warnings: [],
    });
    const [cost] = await db.query(`select * from cost_log where job_id=$1`, [job.id]);
    expect(cost).toMatchObject({ purpose: 'extract_job', model: 'claude-haiku-5-5', input_tokens: 1000, output_tokens: 100 });
    expect(Number(cost.cost_usd)).toBeCloseTo(0.00015, 6);
    expect(await db.query(`select from_status, to_status from job_status_history where job_id=$1`, [job.id])).toEqual([
      { from_status: null, to_status: 'new' },
    ]);
  });

  test('webhook responds with scan and extraction counts', async () => {
    await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'Job A' }]);
    await writeJobFile('b.docx', [{ text: 'https://x.io/b' }, { text: 'Job B' }]);
    const res = await fetch(`${N8N_URL}/webhook/api/jobs/sync`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, scanned: 2, extracted: 2 });
    const again = await fetch(`${N8N_URL}/webhook/api/jobs/sync`, { method: 'POST' });
    expect(await again.json()).toEqual({ ok: true, scanned: 2, extracted: 0 });
  });

  test('unchanged file is not re-extracted', async () => {
    await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'Job A' }]);
    await triggerSync();
    await triggerSync();
    expect(await stub.requests()).toHaveLength(1);
    expect(await db.query(`select id from jobs`)).toHaveLength(1);
    expect(await db.query(`select id from job_status_history`)).toHaveLength(1);
  });

  test('edited file updates the same job', async () => {
    await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'Old body' }]);
    await triggerSync();
    const before = await jobRow('a.docx');
    await db.query(`update jobs set status='applied' where id=$1`, [before.id]);
    // Commas, quotes and newlines in the body must survive query parameterisation.
    await writeJobFile('a.docx', [{ text: 'https://x.io/a2' }, { text: 'New body, with "commas", and more' }]);
    await triggerSync();
    const rows = await db.query(`select * from jobs where source_ref='a.docx'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: before.id,
      status: 'applied',
      url: 'https://x.io/a2',
      raw_text: 'New body, with "commas", and more',
      extraction_status: 'done',
      extraction_attempts: 1,
    });
    expect(rows[0].content_hash).not.toBe(before.content_hash);
    expect(await stub.requests()).toHaveLength(2);
    expect(await db.query(`select id from job_status_history where job_id=$1`, [before.id])).toHaveLength(1);
  });

  test('deleted file marks job removed', async () => {
    await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'Job A' }]);
    await writeJobFile('b.docx', [{ text: 'https://x.io/b' }, { text: 'Job B' }]);
    await triggerSync();
    removeJobFile('a.docx');
    await triggerSync();
    expect((await jobRow('a.docx')).source_removed).toBe(true);
    expect((await jobRow('b.docx')).source_removed).toBe(false);
    // Empty folder marks everything removed.
    removeJobFile('b.docx');
    await triggerSync();
    expect((await jobRow('b.docx')).source_removed).toBe(true);
    // Restoring the file clears the mark and keeps the job.
    await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'Job A' }]);
    await triggerSync();
    const restored = await jobRow('a.docx');
    expect(restored).toMatchObject({ source_removed: false, extraction_status: 'done', title: 'Stub Title' });
    expect(await stub.requests()).toHaveLength(2);
  });

  test('missing URL creates a job with warning', async () => {
    await writeJobFile('nourl.docx', [{ text: 'Salesforce Developer at Acme' }, { text: 'More details' }]);
    await triggerSync();
    expect(await jobRow('nourl.docx')).toMatchObject({
      warnings: ['missing_url'],
      url: null,
      extraction_status: 'done',
      title: 'Stub Title',
    });
  });

  test('unreadable file makes no Claude call', async () => {
    writeRawJobFile('bad.docx', 'junk');
    await triggerSync();
    expect(await jobRow('bad.docx')).toMatchObject({
      warnings: ['unreadable_file'],
      extraction_status: 'skipped',
      title: null,
    });
    expect(await stub.requests()).toEqual([]);
  });

  test('extraction failure is retried then gives up', async () => {
    await writeJobFile('fail.docx', [{ text: 'https://x.io/f' }, { text: 'STUB_FAIL please' }]);
    for (let i = 0; i < 4; i++) await triggerSync();
    expect(await jobRow('fail.docx')).toMatchObject({
      extraction_status: 'failed',
      extraction_attempts: 3,
      title: null,
    });
    expect(await stub.requests()).toHaveLength(3);
    // A 500 has no usage, so nothing is logged as cost.
    expect(await db.query(`select id from cost_log`)).toEqual([]);
  });

  test('refusal counts as failure', async () => {
    await writeJobFile('refuse.docx', [{ text: 'https://x.io/r' }, { text: 'STUB_REFUSE please' }]);
    await triggerSync();
    const job = await jobRow('refuse.docx');
    expect(job).toMatchObject({ extraction_status: 'failed', extraction_attempts: 1, title: null });
    // The refusal still reported usage, so its cost is logged.
    expect(await db.query(`select input_tokens, output_tokens from cost_log where job_id=$1`, [job.id])).toEqual([
      { input_tokens: 1000, output_tokens: 100 },
    ]);
  });

  test('overlapping syncs do not double-call Claude', async () => {
    await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'Job A' }]);
    await Promise.all([triggerSync(), triggerSync()]);
    expect(await stub.requests()).toHaveLength(1);
    expect(await db.query(`select id from jobs`)).toHaveLength(1);
    expect(await db.query(`select id from job_status_history`)).toHaveLength(1);
  });

  test('request uses structured output and the configured model', async () => {
    await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'Salesforce Developer at Acme' }]);
    await triggerSync();
    const [req] = await stub.requests(); // the stub only records requests with valid headers
    expect(req.model).toBe('claude-haiku-5-5');
    expect(req.max_tokens).toBe(1024);
    expect(req.output_config.effort).toBe('low');
    expect(req.output_config.format.type).toBe('json_schema');
    const schema = req.output_config.format.schema;
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
    expect([...schema.required].sort()).toEqual(['advertiser', 'employer', 'short_description', 'title']);
    expect(req).not.toHaveProperty('temperature');
    expect(req.messages).toEqual([{ role: 'user', content: '<job_ad>\nSalesforce Developer at Acme\n</job_ad>' }]);
    const prompt = readFileSync(join(ROOT, 'n8n', 'prompts', 'extract-job.md'), 'utf8');
    expect(normalise(req.system)).toBe(normalise(prompt));
  });

  describe('when the folder scan fails', () => {
    const FAKE_WORKER = 'jobhunter-test-fake-worker';
    const removeFakeWorker = () => {
      try {
        execFileSync('docker', ['rm', '-f', FAKE_WORKER], { stdio: 'ignore' });
      } catch {
        // not running
      }
    };

    beforeEach(async () => {
      // One synced job, then pretend its extraction is still pending: a run that got past
      // the scan would claim it and call Claude.
      await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'Job A' }]);
      await triggerSync();
      await stub.reset();
      await db.query(`update jobs set extraction_status='pending', title=null`);
      compose(['stop', 'worker']);
    });

    afterEach(() => {
      removeFakeWorker();
      compose(['up', '-d', '--wait', 'worker']);
    });

    const expectNothingChanged = async () => {
      const res = await fetch(`${N8N_URL}/webhook/api/jobs/sync`, { method: 'POST' });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ ok: false, error: 'scan_failed' });
      // Nothing marked removed and nothing claimed for extraction.
      expect(await jobRow('a.docx')).toMatchObject({ source_removed: false, extraction_status: 'pending', extraction_attempts: 1 });
      expect(await stub.requests()).toEqual([]);
    };

    test('worker unreachable: nothing changes', async () => {
      await expectNothingChanged();
    });

    test('worker answers 503 job_folder_missing: nothing changes', async () => {
      // Stand-in "worker" on the compose network whose scan always reports a missing folder.
      const server = `require('http').createServer((q, r) => { r.writeHead(503, { 'content-type': 'application/json' }); r.end(JSON.stringify({ error: 'job_folder_missing' })); }).listen(3001)`;
      execFileSync('docker', [
        'run', '-d', '--rm', '--name', FAKE_WORKER, '--network', 'jobhunter-test_default', '--network-alias', 'worker',
        '--entrypoint', 'node', 'jobhunter-test-worker', '-e', server,
      ], { stdio: 'ignore' });
      let status = '';
      for (let i = 0; i < 50 && status !== '503'; i++) {
        const out: string = execFileSync('docker', ['compose', '-f', join(ROOT, 'docker-compose.test.yml'), 'exec', '-T', 'n8n', 'node', '-e',
          `fetch('http://worker:3001/jobs/scan',{method:'POST'}).then(r=>console.log(r.status)).catch(()=>console.log(0))`], { encoding: 'utf8' });
        status = out.trim();
        if (status !== '503') await new Promise((r) => setTimeout(r, 200));
      }
      expect(status).toBe('503'); // n8n really reaches the fake worker
      await expectNothingChanged();
    });
  });
});
