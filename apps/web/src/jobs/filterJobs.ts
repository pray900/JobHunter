import type { JobStatus, JobSummary } from '../api/types';

export interface JobFilter {
  status: JobStatus | 'all';
  query: string;
}

export function filterJobs(jobs: JobSummary[], f: JobFilter): JobSummary[] {
  const q = f.query.trim().toLowerCase();
  return jobs.filter((j) => {
    if (f.status !== 'all' && j.status !== f.status) return false;
    if (!q) return true;
    return [j.title, j.employer, j.advertiser, j.shortDescription].some((v) => v?.toLowerCase().includes(q));
  });
}

/** matchScore desc (unscored last), then createdAt desc. Same rule as the API. */
export function sortJobs(jobs: JobSummary[]): JobSummary[] {
  return [...jobs].sort((a, b) => {
    if (a.matchScore !== b.matchScore) {
      if (a.matchScore === null) return 1;
      if (b.matchScore === null) return -1;
      return b.matchScore - a.matchScore;
    }
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}
