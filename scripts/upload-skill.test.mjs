// Tests for scripts/upload-skill.mjs against a local fake Skills API (never the real one).
// Run: node --test scripts/   (also part of `npm test` at the repo root)
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'upload-skill.mjs');
const KEY = 'sk-ant-test-secret-key-12345';

let server, baseUrl, requests, respond, tmp, skillDir;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('latin1') });
      const r = respond(req);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  tmp = mkdtempSync(join(tmpdir(), 'upload-skill-'));
});
after(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  requests = [];
  respond = (req) =>
    req.url === '/v1/skills'
      ? { status: 200, json: { id: 'skill_01Abc', latest_version_id: 'skver_1', display_name: 'CV writing', type: 'skill' } }
      : { status: 200, json: { id: 'skver_2', skill_id: 'skill_01Abc', type: 'skill_version' } };
  skillDir = join(tmp, 'cv-writing');
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(join(skillDir, 'refs'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: cv-writing\ndescription: test\n---\nBody\n');
  writeFileSync(join(skillDir, 'refs', 'extra.md'), 'extra\n');
});

function run(envContent, extraArgs = []) {
  const envFile = join(tmp, '.env');
  writeFileSync(envFile, envContent);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--env', envFile, '--dir', skillDir, '--base-url', baseUrl, ...extraArgs], {
      env: { PATH: process.env.PATH },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err, env: readFileSync(envFile, 'utf8') }));
  });
}

test('creates the skill and writes CV_SKILL_ID', async () => {
  const r = await run(`ANTHROPIC_API_KEY="${KEY}"\nCV_SKILL_ID=\nOTHER=1\n`);
  assert.equal(r.code, 0, r.err);
  assert.equal(requests.length, 1);
  const q = requests[0];
  assert.equal(q.method, 'POST');
  assert.equal(q.url, '/v1/skills');
  assert.equal(q.headers['x-api-key'], KEY);
  assert.equal(q.headers['anthropic-version'], '2026-10-21');
  assert.equal(q.headers['anthropic-beta'], undefined);
  assert.match(q.headers['content-type'], /^multipart\/form-data/);
  assert.match(q.body, /name="files\[\]"; filename="cv-writing\/SKILL\.md"/);
  assert.match(q.body, /name="files\[\]"; filename="cv-writing\/refs\/extra\.md"/);
  assert.match(q.body, /name="display_name"\r\n\r\nCV writing/);
  assert.match(r.env, /^CV_SKILL_ID=skill_01Abc$/m);
  assert.match(r.env, /^OTHER=1$/m);
  assert.equal(r.env.match(/^CV_SKILL_ID=/gm).length, 1);
  assert.match(r.out, /skill_01Abc/);
  assert.match(r.out, /skver_1/);
});

test('second upload adds a version', async () => {
  const first = await run(`ANTHROPIC_API_KEY=${KEY}\n`);
  assert.equal(first.code, 0, first.err);
  assert.match(first.env, /^CV_SKILL_ID=skill_01Abc$/m);
  requests = [];
  const envFile = join(tmp, '.env');
  const second = await run(readFileSync(envFile, 'utf8'));
  assert.equal(second.code, 0, second.err);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/skills/skill_01Abc/versions');
  assert.match(requests[0].body, /filename="cv-writing\/SKILL\.md"/);
  assert.equal(second.env.match(/^CV_SKILL_ID=/gm).length, 1);
  assert.match(second.out, /skver_2/);
});

test('a malformed CV_SKILL_ID creates a new skill', async () => {
  const r = await run(`ANTHROPIC_API_KEY=${KEY}\nCV_SKILL_ID="https://example.com/x"\n`);
  assert.equal(r.code, 0, r.err);
  assert.equal(requests[0].url, '/v1/skills');
  assert.match(r.env, /^CV_SKILL_ID=skill_01Abc$/m);
});

test('never prints the key', async () => {
  const ok = await run(`ANTHROPIC_API_KEY='${KEY}'\n`);
  assert.equal(ok.code, 0, ok.err);
  assert.ok(!ok.out.includes(KEY) && !ok.err.includes(KEY));
  respond = () => ({ status: 401, json: { type: 'error', error: { type: 'authentication_error', message: `bad key ${KEY}` } } });
  const bad = await run(`ANTHROPIC_API_KEY=${KEY}\n`);
  assert.ok(!bad.out.includes(KEY) && !bad.err.includes(KEY));
});

test('api error exits 1 with the error message', async () => {
  respond = () => ({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'name must match' } } });
  const r = await run(`ANTHROPIC_API_KEY=${KEY}\n`);
  assert.equal(r.code, 1);
  assert.match(r.err, /invalid_request_error/);
  assert.match(r.err, /name must match/);
  assert.doesNotMatch(r.env, /^CV_SKILL_ID=skill_/m);
});

test('rejects a folder without SKILL.md', async () => {
  rmSync(join(skillDir, 'SKILL.md'));
  const r = await run(`ANTHROPIC_API_KEY=${KEY}\n`);
  assert.equal(r.code, 1);
  assert.match(r.err, /SKILL\.md/);
  assert.equal(requests.length, 0);
});

test('stops when ANTHROPIC_API_KEY is empty', async () => {
  const r = await run('ANTHROPIC_API_KEY=\n');
  assert.equal(r.code, 1);
  assert.match(r.err, /ANTHROPIC_API_KEY/);
  assert.equal(requests.length, 0);
});
