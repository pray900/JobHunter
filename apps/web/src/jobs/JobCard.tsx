import type { JobSummary } from '../api/types';
import { statusLabel, warningText } from './labels';

function companyLine(job: JobSummary): string | null {
  if (job.employer && job.advertiser) return `${job.employer} via ${job.advertiser}`;
  return job.employer ?? job.advertiser;
}

export function JobCard({ job }: { job: JobSummary }) {
  const company = companyLine(job);
  const reading = job.extractionStatus === 'pending' || job.extractionStatus === 'in_progress';
  return (
    <article className="card">
      <div className="card-top">
        <span className={`status status-${job.status}`}>{statusLabel(job.status)}</span>
        {job.matchScore === null ? (
          <span className="score score-none">Not scored yet</span>
        ) : (
          <span className="score">{job.matchScore}%</span>
        )}
      </div>
      <h2 className="card-title">{job.title ?? job.sourceRef}</h2>
      {company && <p className="card-company">{company}</p>}
      {job.shortDescription && <p className="card-desc">{job.shortDescription}</p>}
      {reading && <p className="note">Reading job…</p>}
      {job.extractionStatus === 'failed' && <p className="note note-bad">Details unavailable</p>}
      {job.warnings.length > 0 && (
        <ul className="warnings">
          {job.warnings.map((w) => (
            <li key={w}>{warningText(w)}</li>
          ))}
        </ul>
      )}
      <div className="card-bottom">
        {job.sourceRemoved && <span className="badge">Source file removed</span>}
        {job.url && (
          <a href={job.url} target="_blank" rel="noopener noreferrer">
            Open job posting ↗
          </a>
        )}
      </div>
    </article>
  );
}
