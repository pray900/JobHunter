import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { makeDocx, type DocxPara } from '../helpers/makeDocx';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../..');
const COMPOSE_FILE = join(ROOT, 'docker-compose.test.yml');
export const JOB_DIR = join(ROOT, '.tmp', 'e2e-joblisting');

export const N8N_URL = 'http://localhost:55678';
export const STUB_URL = 'http://localhost:58081';
export const WEB_URL = 'http://localhost:58080';
const DB_URL = 'postgres://jobhunter:test@localhost:55433/jobhunter';

export function compose(args: string[]): void {
  execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], { cwd: ROOT, stdio: 'inherit' });
}

export const stack = {
  async up(): Promise<void> {
    mkdirSync(JOB_DIR, { recursive: true });
    compose(['up', '-d', '--build', '--wait']);
    // Bootstrap is a bash script: run it through Git Bash / sh.
    execFileSync('bash', [join(ROOT, 'scripts', 'n8n-bootstrap.sh'), COMPOSE_FILE], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  },
  async down(): Promise<void> {
    compose(['down', '-v']);
  },
};

export async function writeJobFile(name: string, paras: DocxPara[]): Promise<void> {
  mkdirSync(JOB_DIR, { recursive: true });
  writeFileSync(join(JOB_DIR, name), await makeDocx(paras));
}

/** Writes arbitrary bytes (e.g. a corrupt .docx) into the job folder. */
export function writeRawJobFile(name: string, bytes: string | Buffer): void {
  mkdirSync(JOB_DIR, { recursive: true });
  writeFileSync(join(JOB_DIR, name), bytes);
}

export function removeJobFile(name: string): void {
  rmSync(join(JOB_DIR, name), { force: true });
}

/** Per-test reset: empty job tables, empty job folder, clear stub request log. */
export async function resetState(): Promise<void> {
  await db.query('truncate jobs, job_status_history, cost_log');
  mkdirSync(JOB_DIR, { recursive: true });
  for (const f of readdirSync(JOB_DIR)) rmSync(join(JOB_DIR, f), { recursive: true, force: true });
  await stub.reset();
}

/** The sync webhook refuses requests without this header (CSRF guard); the web app sends it too. */
export const SYNC_HEADERS = { 'X-JobHunter': '1' };

/** Runs the sync workflow and resolves once it responds (needs Task 5's webhook). */
export async function triggerSync(): Promise<void> {
  const res = await fetch(`${N8N_URL}/webhook/api/jobs/sync`, { method: 'POST', headers: SYNC_HEADERS });
  if (!res.ok) throw new Error(`sync failed: ${res.status} ${await res.text()}`);
  await res.arrayBuffer();
}

export const db = {
  async query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const client = new pg.Client({ connectionString: DB_URL });
    await client.connect();
    try {
      return (await client.query<T>(sql, params as any[])).rows;
    } finally {
      await client.end();
    }
  },
};

export const stub = {
  async requests(): Promise<any[]> {
    return (await fetch(`${STUB_URL}/_requests`)).json() as Promise<any[]>;
  },
  async reset(): Promise<void> {
    await fetch(`${STUB_URL}/_reset`, { method: 'POST' });
  },
};

/** Goes through the web container (nginx proxies /api/* to n8n webhooks). */
export const api = {
  async get(path: string): Promise<Response> {
    return fetch(`${WEB_URL}/${path.replace(/^\//, '')}`);
  },
};
