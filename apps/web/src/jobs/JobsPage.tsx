import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJobs } from '../api/client';
import type { JobStatus, JobSummary } from '../api/types';
import { JobCard } from './JobCard';
import { filterJobs, sortJobs } from './filterJobs';
import { STATUSES, statusLabel } from './labels';

const REFRESH_MS = 15_000;

export function JobsPage() {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<JobStatus | 'all'>('all');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    try {
      setJobs(await fetchJobs());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const sorted = useMemo(() => (jobs ? sortJobs(jobs) : []), [jobs]);
  const visible = useMemo(() => filterJobs(sorted, { status, query }), [sorted, status, query]);
  const count = (s: JobStatus) => sorted.filter((j) => j.status === s).length;

  return (
    <main className="page">
      <header className="page-header">
        <h1>Jobs</h1>
        <input
          type="search"
          aria-label="Search jobs"
          placeholder="Search jobs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </header>

      <div className="chips">
        <button type="button" className={status === 'all' ? 'chip active' : 'chip'} onClick={() => setStatus('all')}>
          All ({sorted.length})
        </button>
        {STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            className={status === s ? 'chip active' : 'chip'}
            onClick={() => setStatus(s)}
          >
            {statusLabel(s)} ({count(s)})
          </button>
        ))}
      </div>

      {failed && (
        <div className="error" role="alert">
          <p>Couldn't load jobs. Is the backend running?</p>
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {!failed && jobs === null && <p className="muted">Loading jobs…</p>}
      {jobs !== null && jobs.length === 0 && !failed && (
        <p className="muted">No jobs yet. Add a Word file to your Joblisting folder.</p>
      )}
      {jobs !== null && jobs.length > 0 && visible.length === 0 && <p className="muted">No jobs match your filters.</p>}

      <div className="grid">
        {visible.map((j) => (
          <JobCard key={j.id} job={j} />
        ))}
      </div>
    </main>
  );
}
