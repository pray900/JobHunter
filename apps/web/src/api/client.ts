import type {
  DocumentKind,
  DocumentsResponse,
  DownloadDoc,
  DownloadFormat,
  JobDetail,
  JobStatus,
  JobSummary,
} from './types';
import { parseJobDetail } from './parseJobDetail';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    // The `error` code from the API's `{ error }` body, when there was one.
    public readonly code?: string,
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
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    if (body && typeof body.error === 'string') code = body.error;
  } catch {
    // no JSON body
  }
  return new ApiError(res.status, message, code);
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

export async function fetchJobDetail(id: string): Promise<JobDetail> {
  const path = `/api/jobs/detail?id=${encodeURIComponent(id)}`;
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
export function generate(id: string): Promise<{ runId: string }> {
  return postJson(`/api/jobs/generate?id=${encodeURIComponent(id)}`, undefined, (b) => {
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

// A plain link: downloads are GETs, so the browser handles them (no fetch).
export function downloadUrl(id: string, doc: DownloadDoc, format: DownloadFormat): string {
  return `/api/jobs/download?id=${encodeURIComponent(id)}&doc=${doc}&format=${format}`;
}
