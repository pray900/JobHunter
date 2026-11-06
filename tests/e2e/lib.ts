import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { makeDocx, type DocxPara } from '../helpers/makeDocx';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../..');
const COMPOSE_FILE = join(ROOT, 'docker-compose.test.yml');
export const JOB_DIR = join(ROOT, '.tmp', 'e2e-joblisting');
export const CV_DIR = join(ROOT, '.tmp', 'e2e-cv');
export const COVER_LETTER_DIR = join(ROOT, '.tmp', 'e2e-cover-letter');

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
    mkdirSync(CV_DIR, { recursive: true });
    mkdirSync(COVER_LETTER_DIR, { recursive: true });
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

export type DocumentKind = 'cv' | 'cover_letter';
const documentDir = (kind: DocumentKind) => (kind === 'cv' ? CV_DIR : COVER_LETTER_DIR);

/**
 * Writes a base CV / cover letter into its e2e folder (never the real PersonalDetails* folders).
 * `modifiedAt` sets the file's modification time: per kind only the newest file is used.
 */
export function writeDocument(kind: DocumentKind, name: string, bytes: string | Buffer, modifiedAt?: Date): void {
  mkdirSync(documentDir(kind), { recursive: true });
  writeFileSync(join(documentDir(kind), name), bytes);
  if (modifiedAt) touchDocument(kind, name, modifiedAt);
}

/** Sets a document's modification time without changing its content. */
export function touchDocument(kind: DocumentKind, name: string, modifiedAt: Date): void {
  utimesSync(join(documentDir(kind), name), modifiedAt, modifiedAt);
}

export function removeDocument(kind: DocumentKind, name: string): void {
  rmSync(join(documentDir(kind), name), { force: true });
}

/** A tiny file that starts with the PDF magic; the stub does not parse it, it only searches its text. */
export function makePdf(text: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`, 'latin1');
}

const emptyDir = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
};

/** Per-test reset: empty job and base-document tables, empty the e2e folders, clear the stub log. */
export async function resetState(): Promise<void> {
  await db.query('truncate jobs, job_status_history, cost_log, base_documents');
  emptyDir(JOB_DIR);
  emptyDir(CV_DIR);
  emptyDir(COVER_LETTER_DIR);
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

/** Deletes a document by id through the web proxy. */
export async function deleteDocument(id: string, headers: Record<string, string> = SYNC_HEADERS): Promise<Response> {
  return fetch(`${WEB_URL}/api/documents?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers });
}
