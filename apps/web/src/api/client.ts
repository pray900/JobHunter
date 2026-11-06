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
  const res = await fetch(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new ApiError(res.status, `GET ${path} failed with ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchJobs(): Promise<JobSummary[]> {
  const body = await getJson<{ jobs: JobSummary[] }>('/api/jobs');
  return body.jobs;
}
