import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { JobSummary } from '../api/types';
import { statusLabel, warningText } from './labels';

function companyLine(job: JobSummary): string | null {
  if (job.employer && job.advertiser) return `${job.employer} via ${job.advertiser}`;
  return job.employer ?? job.advertiser;
}

function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function JobCard({ job, noReadyCv = false }: { job: JobSummary; noReadyCv?: boolean }) {
  const [open, setOpen] = useState(false);
  const company = companyLine(job);
  const href = safeHref(job.url);
  const reading = job.extractionStatus === 'pending' || job.extractionStatus === 'in_progress';
  const scored = job.scoreStatus === 'done' && job.matchScore !== null;
  const scoring =
    !scored && !noReadyCv && job.extractionStatus === 'done' && (job.scoreStatus === 'pending' || job.scoreStatus === 'in_progress');
  const breakdown = job.matchBreakdown;
  return (
    <article className="card">
      <div className="card-top">
        <span className={`status status-${job.status}`}>{statusLabel(job.status)}</span>
        {scored ? (
          <span className="score">{job.matchScore}% match</span>
        ) : (
          <span className="score score-none">Not scored yet</span>
        )}
      </div>
      <h2 className="card-title">{job.title ?? job.sourceRef}</h2>
      {company && <p className="card-company">{company}</p>}
      {job.shortDescription && <p className="card-desc">{job.shortDescription}</p>}
      {reading && <p className="note">Reading job…</p>}
      {job.extractionStatus === 'failed' && <p className="note note-bad">Details unavailable</p>}
      {scoring && <p className="note">Scoring�</p>}
      {!scored && job.scoreStatus === 'failed' && <p className="note note-bad">Couldn't score this job</p>}
      {!scored && job.scoreStatus !== 'failed' && noReadyCv && (
        <p className="note">
          <Link to="/documents">Add a base CV to get match scores</Link>
        </p>
      )}
      {scored && (
        <div className="why">
          <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            Why this score?
          </button>
          {open && (
            <div className="why-body">
              {job.matchExplanation && <p>{job.matchExplanation}</p>}
              {breakdown && breakdown.matched.length > 0 && (
                <div>
                  <strong>Matched:</strong>
                  <ul>
                    {breakdown.matched.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </div>
              )}
              {breakdown && breakdown.missing.length > 0 && (
                <div>
                  <strong>Missing:</strong>
                  <ul>
                    {breakdown.missing.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {job.warnings.length > 0 && (
        <ul className="warnings">
          {job.warnings.map((w) => (
            <li key={w}>{warningText(w)}</li>
          ))}
        </ul>
      )}
      <div className="card-bottom">
        {job.sourceRemoved && <span className="badge">Source file removed</span>}
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer">
            Open job posting ↗
          </a>
        )}
      </div>
    </article>
  );
}
