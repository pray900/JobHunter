import type {
  BaseCoverLetterFacts,
  BaseCvFacts,
  BaseDocumentFacts,
  DocumentKind,
  DocumentsResponse,
  DownloadDoc,
  DownloadFormat,
  JobDetail,
  JobStatus,
  JobSummary,
  SaveEditResult,
  TailoredCv,
  TailoredLetter,
  VersionSummary,
} from './types';
import { isCheck, parseJobDetail, parseVersionList } from './parseJobDetail';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    // The `error` code from the API's `{ error }` body, when there was one.
    public readonly code?: string,
    // The `path` of an invalid_document answer (e.g. cv.headline).
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Sent on every request. The n8n sync webhook refuses POSTs without it, so another site
// cannot trigger a sync with a "simple" cross-site form/text POST (CSRF guard).
const JOBHUNTER_HEADERS = { 'X-JobHunter': '1' };

async function failure(res: Response, message: string): Promise<ApiError> {
  let code: string | undefined;
  let path: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown; path?: unknown } | null;
    if (body && typeof body.error === 'string') code = body.error;
    if (body && typeof body.path === 'string') path = body.path;
  } catch {
    // no JSON body
  }
  return new ApiError(res.status, message, code, path);
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { Accept: 'application/json', ...JOBHUNTER_HEADERS } });
  } catch (err) {
    throw new ApiError(0, `GET ${path} failed: ${err instanceof Error ? err.message : 'network error'}`);
  }
  if (!res.ok) throw await failure(res, `GET ${path} failed with ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(502, `GET ${path} returned a non-JSON body`);
  }
}

export async function fetchJobs(): Promise<JobSummary[]> {
  const body = await getJson<{ jobs?: unknown } | null>('/api/jobs');
  if (!body || !Array.isArray(body.jobs)) throw new ApiError(502, 'GET /api/jobs returned an unexpected shape');
  return body.jobs as JobSummary[];
}

export async function fetchDocuments(): Promise<DocumentsResponse> {
  const body = await getJson<Partial<DocumentsResponse> | null>('/api/documents');
  if (!body || !('cv' in body) || !('coverLetter' in body)) {
    throw new ApiError(502, 'GET /api/documents returned an unexpected shape');
  }
  return { cv: body.cv ?? null, coverLetter: body.coverLetter ?? null };
}

async function send(method: string, path: string, body?: FormData | object): Promise<Response> {
  let res: Response;
  const isForm = body instanceof FormData;
  try {
    res = await fetch(path, {
      method,
      body: body === undefined || isForm ? (body as FormData | undefined) : JSON.stringify(body),
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}),
        ...JOBHUNTER_HEADERS,
      },
    });
  } catch (err) {
    throw new ApiError(0, `${method} ${path} failed: ${err instanceof Error ? err.message : 'network error'}`);
  }
  if (!res.ok) throw await failure(res, `${method} ${path} failed with ${res.status}`);
  return res;
}

export async function uploadDocument(kind: DocumentKind, file: File): Promise<{ sourceRef: string }> {
  const form = new FormData();
  form.append('file', file);
  const path = `/api/documents/upload?kind=${kind}`;
  const res = await send('POST', path, form);
  try {
    const body = (await res.json()) as { sourceRef?: unknown } | null;
    if (body && typeof body.sourceRef === 'string') return { sourceRef: body.sourceRef };
  } catch {
    // fall through
  }
  throw new ApiError(502, `POST ${path} returned an unexpected shape`);
}

// No versionId = the current version.
export async function fetchJobDetail(id: string, versionId?: string): Promise<JobDetail> {
  const path = `/api/jobs/detail?id=${encodeURIComponent(id)}${versionId ? `&versionId=${encodeURIComponent(versionId)}` : ''}`;
  const detail = parseJobDetail(await getJson<unknown>(path));
  if (!detail) throw new ApiError(502, `GET ${path} returned an unexpected shape`);
  return detail;
}

async function postJson<T>(path: string, body: object | undefined, pick: (b: unknown) => T | null): Promise<T> {
  const res = await send('POST', path, body);
  let parsed: T | null = null;
  try {
    parsed = pick(await res.json());
  } catch {
    // fall through
  }
  if (parsed === null) throw new ApiError(502, `POST ${path} returned an unexpected shape`);
  return parsed;
}

const field = (b: unknown, k: string): unknown => (b && typeof b === 'object' ? (b as Record<string, unknown>)[k] : undefined);

// Queues a run; it does not wait for it. Poll fetchJobDetail for progress.
// With an instruction it rewrites from that version (both or neither are sent).
export function generate(id: string, regenerate?: { instruction: string; fromVersionId: string }): Promise<{ runId: string }> {
  const body = regenerate ? { instruction: regenerate.instruction, fromVersionId: regenerate.fromVersionId } : undefined;
  return postJson(`/api/jobs/generate?id=${encodeURIComponent(id)}`, body, (b) => {
    const runId = field(b, 'runId');
    return typeof runId === 'string' ? { runId } : null;
  });
}

export function setStatus(id: string, status: JobStatus): Promise<{ status: JobStatus }> {
  return postJson(`/api/jobs/status?id=${encodeURIComponent(id)}`, { status }, (b) => {
    const st = field(b, 'status');
    return typeof st === 'string' ? { status: st as JobStatus } : null;
  });
}

export function saveCompanyNotes(id: string, notes: string): Promise<{ notes: string }> {
  return postJson(`/api/jobs/notes?id=${encodeURIComponent(id)}`, { notes }, (b) => {
    const n = field(b, 'notes');
    return typeof n === 'string' ? { notes: n } : null;
  });
}

// The template for the next Generate; null clears the choice (the suggestion applies again).
export function setTemplate(
  id: string,
  templateId: 'standard-ats' | 'au-government' | null,
): Promise<{ templateChoice: string | null }> {
  return postJson(`/api/jobs/template?id=${encodeURIComponent(id)}`, { templateId }, (b) => {
    const t = field(b, 'templateChoice');
    return t === null || typeof t === 'string' ? { templateChoice: t } : null;
  });
}

// Newest first.
export async function fetchVersions(id: string): Promise<VersionSummary[]> {
  const path = `/api/jobs/versions?id=${encodeURIComponent(id)}`;
  const list = parseVersionList(await getJson<unknown>(path));
  if (!list) throw new ApiError(502, `GET ${path} returned an unexpected shape`);
  return list;
}

// Saves the documents as a new "edited" version and answers with the code checks run on it.
export function saveEdit(id: string, fromVersionId: string, cv: TailoredCv, coverLetter: TailoredLetter): Promise<SaveEditResult> {
  return postJson(`/api/jobs/versions/edit?id=${encodeURIComponent(id)}`, { fromVersionId, cv, coverLetter }, (b) => {
    const versionId = field(b, 'versionId');
    const versionNo = field(b, 'versionNo');
    const checks = field(b, 'checks');
    if (typeof versionId !== 'string' || typeof versionNo !== 'number' || !Array.isArray(checks) || !checks.every(isCheck)) return null;
    return { versionId, versionNo, checks: checks as SaveEditResult['checks'] };
  });
}

// Adds a new version that copies an old one.
export function restoreVersion(id: string, versionId: string): Promise<{ versionId: string; versionNo: number }> {
  return postJson(`/api/jobs/versions/restore?id=${encodeURIComponent(id)}`, { versionId }, (b) => {
    const v = field(b, 'versionId');
    const n = field(b, 'versionNo');
    return typeof v === 'string' && typeof n === 'number' ? { versionId: v, versionNo: n } : null;
  });
}

// A plain link: downloads are GETs, so the browser handles them (no fetch).
export function downloadUrl(id: string, doc: DownloadDoc, format: DownloadFormat, versionId?: string): string {
  const version = versionId ? `&versionId=${encodeURIComponent(versionId)}` : '';
  return `/api/jobs/download?id=${encodeURIComponent(id)}&doc=${doc}&format=${format}${version}`;
}

function parseBaseFacts(b: unknown): BaseDocumentFacts | null {
  const facts = field(b, 'facts');
  const kind = field(b, 'kind');
  const editedAt = field(b, 'editedAt');
  if (
    typeof field(b, 'id') !== 'string' ||
    (kind !== 'cv' && kind !== 'cover_letter') ||
    typeof field(b, 'sourceRef') !== 'string' ||
    typeof field(b, 'mediaType') !== 'string' ||
    typeof field(b, 'contentHash') !== 'string' ||
    !facts ||
    typeof facts !== 'object' ||
    Array.isArray(facts) ||
    typeof field(b, 'edited') !== 'boolean' ||
    (editedAt !== null && typeof editedAt !== 'string') ||
    !Array.isArray(field(b, 'warnings')) ||
    typeof field(b, 'rescoreJobs') !== 'number'
  ) {
    return null;
  }
  return b as BaseDocumentFacts;
}

// The facts of a base document (edited facts if edited). 404 no_document when the slot is empty or unread.
export async function fetchBaseFacts(kind: DocumentKind): Promise<BaseDocumentFacts> {
  const path = `/api/documents/facts?kind=${kind}`;
  const out = parseBaseFacts(await getJson<unknown>(path));
  if (!out) throw new ApiError(502, `GET ${path} returned an unexpected shape`);
  return out;
}

// Saves edited facts; null undoes all edits. contentHash is the file the facts were opened from
// (409 document_changed if it was replaced since). 400 invalid_facts carries the bad `path`.
export function saveBaseFacts(
  kind: DocumentKind,
  id: string,
  contentHash: string,
  facts: BaseCvFacts | BaseCoverLetterFacts | null,
): Promise<BaseDocumentFacts> {
  return postJson('/api/documents/facts', { kind, id, contentHash, facts }, parseBaseFacts);
}

// A plain link to the original file (PDF inline, Word as a download).
export function baseFileUrl(kind: DocumentKind): string {
  return `/api/documents/file?kind=${kind}`;
}

// The original file's bytes as a PDF blob. The page shows it from a blob: URL, because the n8n
// response carries a sandbox Content-Security-Policy that stops Chromium's PDF viewer rendering it directly.
export async function fetchBaseFile(kind: DocumentKind): Promise<Blob> {
  const path = baseFileUrl(kind);
  let res: Response;
  try {
    res = await fetch(path, { headers: JOBHUNTER_HEADERS });
  } catch (err) {
    throw new ApiError(0, `GET ${path} failed: ${err instanceof Error ? err.message : 'network error'}`);
  }
  if (!res.ok) throw await failure(res, `GET ${path} failed with ${res.status}`);
  return new Blob([await res.arrayBuffer()], { type: 'application/pdf' });
}
