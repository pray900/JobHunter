import type { DocumentKind, DocumentsResponse, JobSummary } from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Sent on every request. The n8n sync webhook refuses POSTs without it, so another site
// cannot trigger a sync with a "simple" cross-site form/text POST (CSRF guard).
const JOBHUNTER_HEADERS = { 'X-JobHunter': '1' };

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { Accept: 'application/json', ...JOBHUNTER_HEADERS } });
  } catch (err) {
    throw new ApiError(0, `GET ${path} failed: ${err instanceof Error ? err.message : 'network error'}`);
  }
  if (!res.ok) throw new ApiError(res.status, `GET ${path} failed with ${res.status}`);
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

async function send(method: string, path: string, body?: FormData): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, { method, body, headers: { Accept: 'application/json', ...JOBHUNTER_HEADERS } });
  } catch (err) {
    throw new ApiError(0, `${method} ${path} failed: ${err instanceof Error ? err.message : 'network error'}`);
  }
  if (!res.ok) throw new ApiError(res.status, `${method} ${path} failed with ${res.status}`);
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
