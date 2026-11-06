import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { N8N_URL, ROOT } from './lib';

// Sourcing the bootstrap only defines its settings and functions: no stack is touched.
// The env file is always a temp copy (JOBHUNTER_ENV_FILE), never the real .env.
const SCRIPT = join(ROOT, 'scripts', 'n8n-bootstrap.sh');

function sourced(body: string, envFile: string, args: string[] = []): string {
  return execFileSync('bash', ['-c', `. "$SCRIPT" "$@"\n${body}`, 'bash', ...args], {
    cwd: tmpdir(),
    env: { ...process.env, SCRIPT, JOBHUNTER_ENV_FILE: envFile },
    encoding: 'utf8',
  });
}

/** C:\a\b -> /c/a/b, the form Git Bash itself produces. */
const gitBashPath = (p: string) => p.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, '/');

describe('bootstrap script helpers', () => {
  let dir: string;
  let envFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jh-bootstrap-'));
    envFile = join(dir, '.env');
    copyFileSync(join(ROOT, '.env.example'), envFile);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test.each([
    ['native path', (p: string) => p],
    ['Git Bash path', gitBashPath],
  ])('fills empty owner lines from a fresh .env.example (%s)', (_, toPath) => {
    const out = sourced('ensure_owner_login', toPath(envFile));
    expect(out).toContain('n8n owner login saved in .env');
    const lines = readFileSync(envFile, 'utf8').split(/\r?\n/);
    expect(lines.filter((l) => l.startsWith('N8N_OWNER_EMAIL='))).toEqual(['N8N_OWNER_EMAIL=prayush@jobhunter.local']);
    const pw = lines.filter((l) => l.startsWith('N8N_OWNER_PASSWORD='));
    expect(pw).toHaveLength(1);
    expect(pw[0]).toMatch(/^N8N_OWNER_PASSWORD=[A-Za-z0-9_-]{32}Aa1$/);
    // Every other line is unchanged.
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8').split(/\r?\n/);
    expect(lines.filter((l) => !l.startsWith('N8N_OWNER_'))).toEqual(example.filter((l) => !l.startsWith('N8N_OWNER_')));
  });

  test('keeps an existing owner login', () => {
    writeFileSync(envFile, 'N8N_OWNER_EMAIL=me@x.io\nN8N_OWNER_PASSWORD=Keep-Me-1\n');
    const out = sourced('ensure_owner_login', envFile);
    expect(out).not.toContain('saved');
    expect(readFileSync(envFile, 'utf8')).toBe('N8N_OWNER_EMAIL=me@x.io\nN8N_OWNER_PASSWORD=Keep-Me-1\n');
  });

  test('env_value strips one pair of matching surrounding quotes', () => {
    writeFileSync(envFile, ['A="sk-dq"', "B='sk-sq'", 'C=plain', 'D="unmatched', 'E=""', 'F="a"b"', 'G=x=y\r', ''].join('\n'));
    const out = sourced('for k in A B C D E F G; do printf "%s=[%s]\\n" "$k" "$(env_value "$k")"; done', envFile);
    expect(out.trim().split('\n')).toEqual(['A=[sk-dq]', 'B=[sk-sq]', 'C=[plain]', 'D=["unmatched]', 'E=[]', 'F=[a"b]', 'G=[x=y]']);
  });

  test('default compose file resolves to a path docker and node can open', () => {
    const out = sourced('printf "%s\\n%s\\n" "$COMPOSE_FILE" "$IS_TEST_STACK"; docker compose -f "$COMPOSE_FILE" config -q', envFile);
    const [composeFile, isTest] = out.trim().split('\n');
    expect(existsSync(composeFile)).toBe(true);
    expect(composeFile.replace(/\\/g, '/').toLowerCase()).toBe(join(ROOT, 'docker-compose.yml').replace(/\\/g, '/').toLowerCase());
    expect(isTest).toBe('0');
  });

  test('a Git Bash compose path is converted and detected as the test stack', () => {
    const out = sourced('printf "%s\\n%s\\n" "$COMPOSE_FILE" "$IS_TEST_STACK"', envFile, [gitBashPath(join(ROOT, 'docker-compose.test.yml'))]);
    const [composeFile, isTest] = out.trim().split('\n');
    expect(existsSync(composeFile)).toBe(true);
    expect(isTest).toBe('1');
  });
});

// check_anthropic_key runs inside the TEST stack's n8n container against the stub
// (JOBHUNTER_ANTHROPIC_BASE_URL override), never against the real API or real key.
describe('bootstrap Anthropic key check', () => {
  const TEST_COMPOSE = join(ROOT, 'docker-compose.test.yml');
  const check = (key: string, baseUrl: string) => {
    const r = spawnSync('bash', ['-c', '. "$SCRIPT" "$@"\ncheck_anthropic_key', 'bash', TEST_COMPOSE], {
      cwd: tmpdir(),
      env: { ...process.env, SCRIPT, JOBHUNTER_ENV_FILE: join(tmpdir(), 'jh-no-such.env'), ANTHROPIC_KEY: key, JOBHUNTER_ANTHROPIC_BASE_URL: baseUrl },
      encoding: 'utf8',
    });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  const STUB = 'http://anthropic-stub:8080';

  test('accepted key: continues', () => {
    const { status, out } = check('sk-good-secret-123', STUB);
    expect(status).toBe(0);
    expect(out).toContain('Anthropic API key accepted');
    expect(out).not.toContain('sk-good-secret-123');
  });

  test('rejected key (401): stops with a clear message', () => {
    const { status, out } = check('bad-key', STUB);
    expect(status).toBe(1);
    expect(out).toContain('Your Anthropic API key was rejected — check ANTHROPIC_API_KEY in .env');
    expect(out).not.toContain('bad-key');
  });

  test('other status: stops and names the status, not the key', () => {
    const { status, out } = check('sk-good-secret-123', `${STUB}/nowhere`);
    expect(status).toBe(1);
    expect(out).toContain('HTTP 404');
    expect(out).not.toContain('sk-good-secret-123');
  });

  test('network error: stops with a clear message', () => {
    const { status, out } = check('sk-good-secret-123', 'http://no-such-host.invalid');
    expect(status).toBe(1);
    expect(out).toMatch(/Could not reach the Anthropic API/);
    expect(out).not.toContain('sk-good-secret-123');
  });

  test('runs on the main stack only, before credentials are imported', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const main = script.slice(script.indexOf('\nensure_owner_login\n'));
    const realKey = main.indexOf('ANTHROPIC_KEY="$(env_value ANTHROPIC_API_KEY)"');
    const call = main.indexOf('check_anthropic_key || exit 1');
    expect(realKey).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(realKey);
    expect(call).toBeLessThan(main.indexOf('import:credentials'));
    // Inside the else (main stack) branch, not after the fi.
    expect(main.slice(realKey, call)).not.toMatch(/^fi$/m);
  });
});

// wait_publication against a local temp SQLite file shaped like n8n's tables: n8n_exec is
// replaced by a plain local run, N8N_USER_FOLDER points at the temp folder, and
// JOBHUNTER_PUBLISH_WAIT_S keeps timeouts short. No container is touched.
describe('bootstrap wait_publication', () => {
  let dir: string;
  let dbFile: string;
  const SCHEMA = `
    create table workflow_publication_outbox (id integer primary key, workflowId text, publishedVersionId text, status text,
      createdAt datetime(3) not null default (strftime('%Y-%m-%d %H:%M:%f', 'now')));
    create table workflow_entity (id text primary key, versionId text, activeVersionId text);
    create table workflow_published_version (workflowId text primary key, publishedVersionId text);`;
  /** Runs SQL against the temp database in a separate node process (busy timeout 5 s). */
  const sql = (statements: string) =>
    execFileSync(
      'node',
      [
        '--no-warnings',
        '-e',
        'const { DatabaseSync } = require("node:sqlite"); new DatabaseSync(process.argv[1], { timeout: 5000 }).exec(process.argv[2]);',
        dbFile,
        statements,
      ],
      { encoding: 'utf8' },
    );
  /** Starts `wait_publication <args>`; resolves with exit status, output and elapsed ms. */
  const children: ChildProcess[] = [];
  const wait = (args: string, waitS: number | string = 3) =>
    new Promise<{ status: number | null; out: string; ms: number }>((resolve) => {
      const started = Date.now();
      const body = `. "$SCRIPT" "$@"\nn8n_exec() { "$@"; }\nwait_publication ${args}`;
      const child = spawn('bash', ['-c', body, 'bash', join(ROOT, 'docker-compose.test.yml')], {
        cwd: tmpdir(),
        env: {
          ...process.env,
          SCRIPT,
          JOBHUNTER_ENV_FILE: join(dir, 'no.env'),
          N8N_USER_FOLDER: dir,
          JOBHUNTER_PUBLISH_WAIT_S: String(waitS),
        },
      });
      children.push(child);
      let out = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (out += c));
      child.on('close', (status) => resolve({ status, out, ms: Date.now() - started }));
    });
  const later = (ms: number, fn: () => void) => new Promise<void>((r) => setTimeout(() => (fn(), r()), ms));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jh-wait-'));
    mkdirSync(join(dir, '.n8n'));
    dbFile = join(dir, '.n8n', 'database.sqlite');
    sql(SCHEMA);
  });
  afterEach(() => {
    // A wait still running (failed test) keeps the database open: on Windows that blocks the
    // folder removal, so kill the whole process tree first.
    for (const c of children.splice(0)) {
      if (c.exitCode !== null || c.signalCode !== null || c.pid === undefined) continue;
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F']);
      else c.kill('SIGKILL');
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test('drained: an empty outbox returns at once', async () => {
    const r = await wait('drained jh-a jh-b');
    expect(r.status).toBe(0);
    expect(r.ms).toBeLessThan(8000);
  });

  test('drained: only terminal statuses count as processed; other workflows are ignored', async () => {
    sql(`insert into workflow_publication_outbox (workflowId, status) values
      ('jh-a', 'completed'), ('jh-a', 'partial_success'), ('jh-a', 'failed'), ('user-own', 'pending')`);
    expect((await wait('drained jh-a')).status).toBe(0);
  });

  test('drained: blocks while a record is in flight and returns once n8n processed it', async () => {
    sql(`insert into workflow_publication_outbox (workflowId, status) values ('jh-a', 'pending')`);
    const running = wait('drained jh-a', 20);
    await later(2500, () => sql(`update workflow_publication_outbox set status = 'completed'`));
    const r = await running;
    expect(r.status).toBe(0);
    expect(r.ms).toBeGreaterThan(2500);
  });

  test.each(['pending', 'in_progress', 'some_future_status'])('drained: fails after the deadline while a record is %s', async (status) => {
    sql(`insert into workflow_publication_outbox (workflowId, status) values ('jh-a', '${status}')`);
    const r = await wait('drained jh-a', 2);
    expect(r.status).toBe(1);
    expect(r.out).toContain('jh-a: publication still queued after 2s');
  });

  test('drained: the timeout names the stuck row status and age', async () => {
    sql(`insert into workflow_publication_outbox (workflowId, status, createdAt) values
      ('jh-a', 'in_progress', strftime('%Y-%m-%d %H:%M:%f', 'now', '-3 hours'))`);
    const r = await wait('drained jh-a', 2);
    expect(r.status).toBe(1);
    expect(r.out).toContain('jh-a: publication still queued after 2s (status in_progress, queued 3h ago)');
  });

  test.each(['abc', '2m', '0', '-5', '1.5'])('rejects JOBHUNTER_PUBLISH_WAIT_S=%j at once', async (value) => {
    // A pending row: an unvalidated (NaN) deadline would wait forever here.
    sql(`insert into workflow_publication_outbox (workflowId, status) values ('jh-a', 'pending')`);
    const r = await wait('drained jh-a', value);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`JOBHUNTER_PUBLISH_WAIT_S must be a whole number of seconds (1 or more), got: ${value}`);
    expect(r.ms).toBeLessThan(8000);
  }, 15_000);

  test('missing tables: fails and names the missing table', async () => {
    rmSync(dbFile);
    writeFileSync(dbFile, '');
    const r = await wait('drained jh-a', 2);
    expect(r.status).toBe(1);
    expect(r.out).toContain('no such table: workflow_publication_outbox');
  });

  test('published: passes when published = active = current version', async () => {
    sql(`insert into workflow_entity values ('jh-a', 'v2', 'v2'); insert into workflow_published_version values ('jh-a', 'v2')`);
    expect((await wait('published jh-a')).status).toBe(0);
  });

  test.each([
    ['the old version is still published', `insert into workflow_entity values ('jh-a', 'v2', 'v2'); insert into workflow_published_version values ('jh-a', 'v1')`],
    ['nothing is published', `insert into workflow_entity values ('jh-a', 'v2', 'v2')`],
    ['the active version is not the imported one', `insert into workflow_entity values ('jh-a', 'v2', 'v1'); insert into workflow_published_version values ('jh-a', 'v1')`],
    ['the workflow is missing', ''],
  ])('published: fails after the deadline when %s', async (_, seed) => {
    if (seed) sql(seed);
    const r = await wait('published jh-a', 2);
    expect(r.status).toBe(1);
    expect(r.out).toContain('jh-a: published version is not the imported one after 2s');
  });

  test('published: blocks while the old version is published and passes once n8n publishes the new one', async () => {
    sql(`insert into workflow_entity values ('jh-a', 'v2', 'v2'); insert into workflow_published_version values ('jh-a', 'v1')`);
    const running = wait('published jh-a', 20);
    await later(2500, () => sql(`update workflow_published_version set publishedVersionId = 'v2'`));
    const r = await running;
    expect(r.status).toBe(0);
    expect(r.ms).toBeGreaterThan(2500);
  });

  test('published: an in-flight record blocks even when the versions match', async () => {
    sql(`insert into workflow_entity values ('jh-a', 'v2', 'v2'); insert into workflow_published_version values ('jh-a', 'v2');
      insert into workflow_publication_outbox (workflowId, status) values ('jh-a', 'pending')`);
    const r = await wait('published jh-a', 2);
    expect(r.status).toBe(1);
    expect(r.out).toContain('jh-a: publication still queued after 2s');
  });

  test('order: drained after the import and before publishing; published after the restart and before the webhook probe', () => {
    const script = readFileSync(SCRIPT, 'utf8');
    const main = script.slice(script.indexOf('\nensure_owner_login\n'));
    const at = (s: string, from = 0) => {
      const i = main.indexOf(s, from);
      expect(i, s).toBeGreaterThan(-1);
      return i;
    };
    const imported = at('n8n_cli import:workflow');
    const drained = at('wait_publication drained $IDS');
    const publish = at('n8n_cli publish:workflow');
    const restart = at('dc restart n8n');
    const healthy = at('wait_healthy', restart);
    const published = at('wait_publication published $IDS');
    const probe = at('"verified " + hooks.length');
    expect(imported).toBeLessThan(drained);
    expect(drained).toBeLessThan(publish);
    expect(publish).toBeLessThan(restart);
    expect(healthy).toBeLessThan(published);
    expect(published).toBeLessThan(probe);
  });
});

// A stack that already published the previous workflow JSON: ONE bootstrap run must make
// the current JSON in n8n/workflows the version that serves requests. The "previous"
// versions are copies of the shipped workflows whose responses carry `stale: true`.
describe('bootstrap after a workflow JSON change', () => {
  const TEST_COMPOSE = join(ROOT, 'docker-compose.test.yml');
  const n8n = (args: string[], input?: string) =>
    execFileSync('docker', ['compose', '-f', TEST_COMPOSE, 'exec', '-T', 'n8n', ...args], { cwd: ROOT, encoding: 'utf8', input });
  const bootstrap = () => execFileSync('bash', [SCRIPT, TEST_COMPOSE], { cwd: ROOT, stdio: 'inherit' });

  /** "<status> <body>" of GET api/jobs and of POST api/jobs/sync without the header (refused: nothing runs). */
  const served = async () => {
    // A new connection per request (agent: false): pooled keep-alive sockets die with the
    // n8n restarts and would fail the request for reasons unrelated to the bootstrap.
    const body = (path: string, method: string) =>
      new Promise<string>((resolve) => {
        const req = request(`${N8N_URL}/webhook/${path}`, { method, agent: false }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve(`${res.statusCode} ${text}`));
        });
        req.on('error', (e) => resolve(String(e)));
        req.end();
      });
    return { jobs: await body('api/jobs', 'GET'), sync: await body('api/jobs/sync', 'POST') };
  };
  const waitFor = async (ok: () => Promise<boolean>, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      if (await ok()) return true;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  };

  test('one run makes the current JSON the live version', async () => {
    const previous = ['jobs-api.json', 'job-intake-sync.json'].map((f) => {
      const wf = JSON.parse(readFileSync(join(ROOT, 'n8n', 'workflows', f), 'utf8'));
      for (const n of wf.nodes) {
        if (n.name === 'Respond with jobs') n.parameters.responseBody = '={{ { jobs: $json.jobs, stale: true } }}';
        if (n.name === 'Respond: missing X-JobHunter header')
          n.parameters.responseBody = '={{ { error: "missing_jobhunter_header", stale: true } }}';
      }
      return wf;
    });
    n8n(['sh', '-c', 'cat >/tmp/jh-previous.json'], JSON.stringify(previous));
    n8n(['n8n', 'import:workflow', '--input=/tmp/jh-previous.json']);
    n8n(['rm', '-f', '/tmp/jh-previous.json']);
    for (const wf of previous) n8n(['n8n', 'publish:workflow', `--id=${wf.id}`]);
    execFileSync('docker', ['compose', '-f', TEST_COMPOSE, 'restart', 'n8n'], { cwd: ROOT, stdio: 'inherit' });
    const previousLive = async () => {
      const s = await served();
      return s.jobs.includes('"stale"') && s.sync.includes('"stale"');
    };
    expect(await waitFor(previousLive, 120_000), 'the previous versions are live before the bootstrap').toBe(true);

    try {
      bootstrap();
      // Straight after the single run, without waiting: the current JSON answers.
      const now = await served();
      expect(now.jobs).toBe('200 {"jobs":[]}');
      expect(now.sync).toBe('403 {"error":"missing_jobhunter_header"}');
    } finally {
      // Leave the current JSON live for later tests even if the assertions failed.
      const current = async () => {
        const s = await served();
        return s.jobs.startsWith('200 ') && !s.jobs.includes('"stale"') && !s.sync.includes('"stale"');
      };
      if (!(await waitFor(current, 30_000))) bootstrap();
    }
  }, 600_000);
});
