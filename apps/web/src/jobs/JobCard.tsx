import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, generate } from '../api/client';
import type { JobSummary } from '../api/types';
import { progressText } from '../job/labels';
import { statusLabel, warningText } from './labels';
import { safeHref } from './safeHref';

function generateErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'generation_in_progress') return 'Already running';
    if (err.code === 'job_not_ready') return "This job hasn't been read yet";
    if (err.code === 'base_cv_not_ready') return "Your base CV isn't ready";
  }
  return "Couldn't start generating";
}

function companyLine(job: JobSummary): string | null {
  if (job.employer && job.advertiser) return `${job.employer} via ${job.advertiser}`;
  return job.employer ?? job.advertiser;
}

export function JobCard({
  job,
  noReadyCv = false,
  onChanged,
}: {
  job: JobSummary;
  noReadyCv?: boolean;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const run = job.generation ?? null;
  const writing = run !== null && (run.status === 'pending' || run.status === 'in_progress');
  const canGenerate = job.status === 'new' && run === null && !job.hasVersion && job.extractionStatus === 'done';

  async function onGenerate() {
    setGenError(null);
    setStarting(true);
    try {
      await generate(job.id);
    } catch (err) {
      setGenError(generateErrorText(err));
    }
    setStarting(false);
    onChanged?.();
  }

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
      <h2 className="card-title">
        <Link to={`/jobs/${encodeURIComponent(job.id)}`}>{job.title ?? job.sourceRef}</Link>
      </h2>
      {company && <p className="card-company">{company}</p>}
      {job.shortDescription && <p className="card-desc">{job.shortDescription}</p>}
      {reading && <p className="note">Reading job…</p>}
      {job.extractionStatus === 'failed' && <p className="note note-bad">Details unavailable</p>}
      {scoring && <p className="note">Scoring…</p>}
      {!scored && job.scoreStatus === 'failed' && <p className="note note-bad">Couldn't score this job</p>}
      {!scored && job.scoreStatus !== 'failed' && noReadyCv && (
        <p className="note">
          <Link to="/documents">Add a base CV to get match scores</Link>
        </p>
      )}
      {writing && run && (
        <p className="note" role="status">
          {progressText(run.stage, run.round)}
        </p>
      )}
      {run?.status === 'failed' && !writing && <p className="note note-bad">Generation failed</p>}
      {genError && (
        <p className="note note-bad" role="alert">
          <span aria-hidden="true">⚠ </span>
          {genError}
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
        {canGenerate && (
          <button type="button" className="btn btn-primary btn-small" disabled={starting} onClick={() => void onGenerate()}>
            Generate
          </button>
        )}
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer">
            Open job posting ↗
          </a>
        )}
      </div>
    </article>
  );
}
