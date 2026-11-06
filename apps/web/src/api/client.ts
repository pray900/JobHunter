import type { JobSummary } from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { Accept: 'application/json' } });
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
