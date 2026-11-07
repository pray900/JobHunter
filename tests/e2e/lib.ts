import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { makeDocx, type DocxPara } from '../helpers/makeDocx';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../..');
const COMPOSE_FILE = join(ROOT, 'docker-compose.test.yml');
export const JOB_DIR = join(ROOT, '.tmp', 'e2e-joblisting');
/** Where the worker keeps the uploaded documents, inside its container (the test stack's own volume). */
export const DOCUMENTS_DIR = '/data/documents';

export const N8N_URL = 'http://localhost:55678';
export const STUB_URL = 'http://localhost:58081';
export const WEB_URL = 'http://localhost:58080';
const DB_URL = 'postgres://jobhunter:test@localhost:55433/jobhunter';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin. */
  input?: string;
  /** Pass the child's stdout and stderr through to this process (default: capture stdout). */
  inherit?: boolean;
  /** Discard the child's output. */
  quiet?: boolean;
}

/**
 * Runs a command without blocking the event loop (a long synchronous child call starves vitest's
 * worker RPC) and resolves with its stdout. Rejects when it exits non-zero or cannot start.
 */
export function run(command: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const out = opts.inherit ? 'inherit' : opts.quiet ? 'ignore' : 'pipe';
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', out, opts.inherit ? 'inherit' : opts.quiet ? 'ignore' : 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr?.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal}): ${stderr}`));
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}

export async function compose(args: string[]): Promise<void> {
  await run('docker', ['compose', '-f', COMPOSE_FILE, ...args], { cwd: ROOT, inherit: true });
}

/** Runs a compose command and returns its stdout. */
export function composeOutput(args: string[]): Promise<string> {
  return run('docker', ['compose', '-f', COMPOSE_FILE, ...args], { cwd: ROOT });
}

export const stack = {
  async up(): Promise<void> {
    mkdirSync(JOB_DIR, { recursive: true });
    await compose(['up', '-d', '--build', '--wait']);
    // Bootstrap is a bash script: run it through Git Bash / sh.
    await run('bash', [join(ROOT, 'scripts', 'n8n-bootstrap.sh'), COMPOSE_FILE], { cwd: ROOT, inherit: true });
  },
  async down(): Promise<void> {
    await compose(['down', '-v']);
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

export type DocumentKind = 'cv' | 'cover_letter';

/** Names of every file the worker has stored for a kind (any depth; the pointer file is left out). */
export async function storedDocuments(kind: DocumentKind): Promise<string[]> {
  const out = await composeOutput([
    'exec', '-T', 'worker', 'sh', '-c',
    `test -d ${DOCUMENTS_DIR}/${kind} || exit 0; find ${DOCUMENTS_DIR}/${kind} -type f ! -name .current.json`,
  ]);
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .map((l) => l.split('/').pop()!)
    .sort();
}

/** Empties the worker's document storage (the test stack's volume only). */
export async function clearStoredDocuments(): Promise<void> {
  await composeOutput(['exec', '-T', 'worker', 'sh', '-c', `rm -rf ${DOCUMENTS_DIR}/cv ${DOCUMENTS_DIR}/cover_letter`]);
}

/** A tiny file that starts with the PDF magic; the stub does not parse it, it only searches its text. */
export function makePdf(text: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`, 'latin1');
}

const emptyDir = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
};

/** Per-test reset: empty job and base-document tables, the e2e job folder and the document storage; clear the stub log. */
export async function resetState(): Promise<void> {
  await db.query('truncate jobs, job_status_history, cost_log, base_documents, generation_runs, document_versions');
  emptyDir(JOB_DIR);
  await clearStoredDocuments();
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

/** Runs the base documents sync workflow and returns its JSON summary. */
export async function triggerDocumentsSync(): Promise<{ ok: boolean; scanned: number; analysed: number }> {
  const res = await fetch(`${N8N_URL}/webhook/api/documents/sync`, { method: 'POST', headers: SYNC_HEADERS });
  if (!res.ok) throw new Error(`documents sync failed: ${res.status} ${await res.text()}`);
  return res.json() as any;
}

/** Runs the job match scoring workflow and returns its JSON summary. */
export async function triggerScoring(): Promise<{ ok: boolean; scored: number; basisHash: string | null }> {
  const res = await fetch(`${N8N_URL}/webhook/api/jobs/score`, { method: 'POST', headers: SYNC_HEADERS });
  if (!res.ok) throw new Error(`scoring failed: ${res.status} ${await res.text()}`);
  return res.json() as any;
}

/**
 * Runs the Generate documents workflow once (claims at most one pending run) and returns its answer
 * once the run has finished. Tests only: the stub answers at once, so this stays well inside 30 s.
 */
export async function triggerGeneration(): Promise<{ ok: boolean; claimed: number }> {
  const res = await fetch(`${N8N_URL}/webhook/api/generation/run`, { method: 'POST', headers: SYNC_HEADERS });
  if (!res.ok) throw new Error(`generation failed: ${res.status} ${await res.text()}`);
  return res.json() as any;
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
  /** Recorded requests with their headers: [{ headers, body }]. */
  async requestLog(): Promise<{ headers: Record<string, string>; body: any }[]> {
    return (await fetch(`${STUB_URL}/_request_log`)).json() as Promise<any[]>;
  },
  /** Every request whose system prompt starts with "purpose: <purpose>" answers 500 until reset. */
  async failPurpose(purpose: string): Promise<void> {
    await fetch(`${STUB_URL}/_fail_purpose`, { method: 'POST', body: JSON.stringify({ purpose }) });
  },
  /** Requests with this purpose are recorded at once but answered only after `ms` (until reset). */
  async delayPurpose(purpose: string, ms: number): Promise<void> {
    await fetch(`${STUB_URL}/_delay_purpose`, { method: 'POST', body: JSON.stringify({ purpose, ms }) });
  },
  /** The next requests with this purpose get these answers in order, then the canned one (until reset). */
  async scriptPurpose(purpose: string, answers: object[]): Promise<void> {
    await fetch(`${STUB_URL}/_script_purpose`, { method: 'POST', body: JSON.stringify({ purpose, answers }) });
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

/** Lists the base documents through the web proxy. */
export async function listDocuments(): Promise<any> {
  const res = await api.get('/api/documents');
  if (!res.ok) throw new Error(`list documents failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Uploads a document (multipart field `file`) through the web proxy. `headers` replaces the default X-JobHunter header. */
export async function uploadDocument(
  kind: string,
  name: string,
  bytes: Buffer,
  headers: Record<string, string> = SYNC_HEADERS,
): Promise<Response> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]), name);
  return fetch(`${WEB_URL}/api/documents/upload?kind=${kind}`, { method: 'POST', headers, body: form });
}

/**
 * Uploads a base CV / cover letter the way the app does and expects 201. The upload starts the
 * documents sync and answers once it has finished, so the document is analysed when this returns.
 */
export async function putDocument(kind: DocumentKind, name: string, bytes: Buffer): Promise<string> {
  const res = await uploadDocument(kind, name, bytes);
  const body = await res.text();
  if (res.status !== 201) throw new Error(`upload failed: ${res.status} ${body}`);
  return JSON.parse(body).sourceRef;
}
