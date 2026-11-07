import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, downloadUrl, fetchJobDetail, generate, saveCompanyNotes, setStatus } from '../api/client';
import type { JobDetail, JobStatus } from '../api/types';
import { STATUSES, statusLabel } from '../jobs/labels';
import { safeHref } from '../jobs/safeHref';
import { CvPreview, LetterPreview } from './DocumentPreview';
import { highlightKeywords } from './highlightKeywords';
import { progressText } from './labels';
import { ReasonsPanel } from './ReasonsPanel';

const POLL_MS = 5000;

const TEMPLATE_NAMES: Record<string, string> = { 'standard-ats': 'Standard ATS' };

function generateErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'generation_in_progress') return 'Already running. Progress will show here.';
    if (err.code === 'job_not_ready') return "This job hasn't been read yet. Try again in a moment.";
    if (err.code === 'base_cv_not_ready') return "Your base CV isn't ready. Check My documents.";
  }
  return "Couldn't start writing the documents. Try again.";
}

function JobAd({ text, keywords }: { text: string | null; keywords: string[] }) {
  const segments = useMemo(() => highlightKeywords(text ?? '', keywords), [text, keywords]);
  if (!text) return <p className="muted">No job description available.</p>;
  return (
    <div className="job-ad">
      {segments.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </div>
  );
}

export function JobPage() {
  const { id = '' } = useParams();
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [tab, setTab] = useState<'cv' | 'letter'>('cv');
  const [genError, setGenError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [status, setStatusValue] = useState<JobStatus>('new');
  const [statusError, setStatusError] = useState(false);
  const [notes, setNotes] = useState('');
  const [savedNotes, setSavedNotes] = useState('');
  const [notesState, setNotesState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const firstLoad = useRef(true);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await fetchJobDetail(id);
      if (!mounted.current) return;
      setDetail(d);
      setLoadFailed(false);
      setStatusValue(d.job.status);
      if (firstLoad.current) {
        firstLoad.current = false;
        setNotes(d.job.companyNotes ?? '');
        setSavedNotes(d.job.companyNotes ?? '');
      }
    } catch {
      if (mounted.current) setLoadFailed(true);
    }
  }, [id]);

  useEffect(() => {
    firstLoad.current = true;
    setDetail(null);
    void load();
  }, [load]);

  const running = detail?.generation?.status === 'pending' || detail?.generation?.status === 'in_progress';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  // Tabs pattern: arrow keys (and Home / End) move between the CV and the cover letter.
  function onTabKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const order = ['cv', 'letter'] as const;
    const at = order.indexOf(tab);
    const next =
      e.key === 'ArrowRight' ? order[(at + 1) % order.length]
      : e.key === 'ArrowLeft' ? order[(at + order.length - 1) % order.length]
      : e.key === 'Home' ? order[0]
      : e.key === 'End' ? order[order.length - 1]
      : null;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    document.getElementById(next === 'cv' ? 'tab-cv' : 'tab-letter')?.focus();
  }

  async function onGenerate() {
    setGenError(null);
    setStarting(true);
    try {
      await generate(id);
    } catch (err) {
      if (mounted.current) setGenError(generateErrorText(err));
    }
    await load();
    if (mounted.current) setStarting(false);
  }

  async function onStatus(next: JobStatus) {
    const previous = status;
    setStatusValue(next);
    setStatusError(false);
    try {
      await setStatus(id, next);
    } catch {
      if (mounted.current) {
        setStatusValue(previous);
        setStatusError(true);
      }
    }
  }

  async function onNotesBlur() {
    if (notes === savedNotes) return;
    setNotesState('saving');
    try {
      const out = await saveCompanyNotes(id, notes);
      if (!mounted.current) return;
      setSavedNotes(out.notes);
      setNotesState('saved');
    } catch {
      if (mounted.current) setNotesState('error');
    }
  }

  if (!detail) {
    return (
      <main className="page">
        <p>
          <Link to="/">← All jobs</Link>
        </p>
        {loadFailed ? (
          <div className="error attention" role="alert">
            <p>Couldn't load this job. Is the backend running?</p>
            <button type="button" className="btn" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : (
          <p className="muted">Loading job…</p>
        )}
      </main>
    );
  }

  const { job, generation, version } = detail;
  const href = safeHref(job.url);
  const company = job.employer && job.advertiser ? `${job.employer} via ${job.advertiser}` : (job.employer ?? job.advertiser);
  const failed = generation?.status === 'failed' && !running;

  return (
    <main className="page job-page">
      <p>
        <Link to="/">← All jobs</Link>
      </p>
      <header className="job-head">
        <div>
          <h1>{company ? `${job.title ?? 'Untitled job'} · ${company}` : (job.title ?? 'Untitled job')}</h1>
          <div className="job-meta">
            <div className="field">
              <label htmlFor="job-status" className="label">
                Status
              </label>
              <select id="job-status" value={status} onChange={(e) => void onStatus(e.target.value as JobStatus)} className={`status-select status-${status}`}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </select>
            </div>
            {href && (
              <a href={href} target="_blank" rel="noopener noreferrer">
                Open job posting ↗
              </a>
            )}
          </div>
          {statusError && (
            <p className="attention-text" role="alert">
              <span aria-hidden="true">⚠ </span>Couldn't save the status. It has been put back.
            </p>
          )}
        </div>
        {version && (
          <div className="downloads">
            <a className="btn" href={downloadUrl(id, 'cv', 'docx')}>
              Download CV DOCX
            </a>
            <a className="btn" href={downloadUrl(id, 'cv', 'pdf')}>
              Download CV PDF
            </a>
            <a className="btn" href={downloadUrl(id, 'cover_letter', 'docx')}>
              Download cover letter DOCX
            </a>
            <a className="btn" href={downloadUrl(id, 'cover_letter', 'pdf')}>
              Download cover letter PDF
            </a>
          </div>
        )}
      </header>

      <section className="gen-bar" aria-label="Generate">
        {running && generation ? (
          <p role="status" className="progress">
            {generation.status === 'pending' && generation.attempts > 0 && generation.error ? (
              <span className="attention-text">
                <span aria-hidden="true">⚠ </span>Retrying: {generation.error}
              </span>
            ) : (
              progressText(generation.stage, generation.round)
            )}
          </p>
        ) : (
          <button type="button" className="btn btn-primary" disabled={starting} onClick={() => void onGenerate()}>
            {version ? 'Generate again' : 'Generate'}
          </button>
        )}
        {genError && (
          <p className="attention-text" role="alert">
            <span aria-hidden="true">⚠ </span>
            {genError}
          </p>
        )}
      </section>

      {failed && generation && (
        <div className="panel attention" role="alert">
          <p>
            <span className="icon-warn" aria-hidden="true">
              ⚠
            </span>{' '}
            {generation.error ?? 'Something went wrong while generating. Try again.'}
          </p>
          <button type="button" className="btn" disabled={starting} onClick={() => void onGenerate()}>
            Try again
          </button>
        </div>
      )}

      {version && (
        <p className="muted basis">
          <span>Based on: {version.baseCvSourceRef ?? 'your base CV'}</span>
          <br />
          <span>
            Template: {TEMPLATE_NAMES[version.templateId] ?? version.templateId} — {version.reasons.templateReason}
          </span>
        </p>
      )}

      <div className="split">
        <section className="panel" aria-label="Job ad">
          <h2>Job ad</h2>
          <JobAd text={job.rawText} keywords={version?.keywordCoverage.covered ?? []} />
        </section>

        {version ? (
          <section className="panel" aria-label="Generated documents">
            <div role="tablist" aria-label="Documents" className="tabs" onKeyDown={onTabKey}>
              <button
                type="button"
                role="tab"
                id="tab-cv"
                aria-selected={tab === 'cv'}
                aria-controls="panel-doc"
                tabIndex={tab === 'cv' ? 0 : -1}
                onClick={() => setTab('cv')}
              >
                CV
              </button>
              <button
                type="button"
                role="tab"
                id="tab-letter"
                aria-selected={tab === 'letter'}
                aria-controls="panel-doc"
                tabIndex={tab === 'letter' ? 0 : -1}
                onClick={() => setTab('letter')}
              >
                Cover letter
              </button>
            </div>
            <div role="tabpanel" id="panel-doc" aria-labelledby={tab === 'cv' ? 'tab-cv' : 'tab-letter'}>
              {tab === 'cv' ? <CvPreview cv={version.cv} /> : <LetterPreview cv={version.cv} letter={version.coverLetter} />}
            </div>
          </section>
        ) : (
          <section className="panel" aria-label="Generated documents">
            <p className="muted">No CV or cover letter yet. Choose Generate to write them for this job.</p>
          </section>
        )}
      </div>

      <section className="panel" aria-label="Notes">
        <label htmlFor="company-notes" className="label">
          My notes about this company
        </label>
        <textarea
          id="company-notes"
          rows={4}
          maxLength={4000}
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            setNotesState('idle');
          }}
          onBlur={() => void onNotesBlur()}
        />
        {notesState === 'saving' && <p className="muted">Saving…</p>}
        {notesState === 'saved' && (
          <p className="muted" role="status">
            Saved
          </p>
        )}
        {notesState === 'error' && (
          <p className="attention-text" role="alert">
            <span aria-hidden="true">⚠ </span>Couldn't save your notes. Click out of the box again to retry.
          </p>
        )}
      </section>

      {version && <ReasonsPanel job={job} version={version} />}
    </main>
  );
}
