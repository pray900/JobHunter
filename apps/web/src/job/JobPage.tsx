import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, downloadUrl, fetchJobDetail, fetchVersions, generate, restoreVersion, saveCompanyNotes, saveEdit, setStatus } from '../api/client';
import type { CheckResult, JobDetail, JobStatus, TailoredCv, TailoredLetter, VersionSummary } from '../api/types';
import { STATUSES, statusLabel } from '../jobs/labels';
import { safeHref } from '../jobs/safeHref';
import { ConfirmDialog } from './ConfirmDialog';
import { DocumentEditor } from './DocumentEditor';
import { CvPreview, LetterPreview } from './DocumentPreview';
import { highlightKeywords } from './highlightKeywords';
import { checkLabel, progressText } from './labels';
import { ReasonsPanel } from './ReasonsPanel';
import { SHORTCUTS, useShortcuts } from './useShortcuts';
import { VersionHistory } from './VersionHistory';

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

function saveErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'base_cv_not_ready') return "Your base CV isn't ready. Check My documents.";
    if (err.code === 'invalid_document') {
      return `Something in the documents is missing or not allowed${err.path ? ` (${err.path})` : ''}. Fix it and save again.`;
    }
    if (err.code === 'too_large') return 'Your edit is too long to save. Shorten it and try again.';
    if (err.code === 'version_not_found') return 'That version no longer exists. Reload the page.';
  }
  return "Couldn't save your edit. Try again.";
}

type Notice = { kind: 'saved'; versionNo: number; hard: CheckResult[] } | { kind: 'restored'; from: number; to: number };

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
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  // The version on screen; null = the current one. The ref lets load() read it without changing identity.
  const [viewId, setViewId] = useState<string | null>(null);
  const viewIdRef = useRef<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoreError, setRestoreError] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
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
      const d = await fetchJobDetail(id, viewIdRef.current ?? undefined);
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
      if (!mounted.current) return;
      if (viewIdRef.current) {
        // That version could not be opened: go back to the current one rather than losing the page.
        viewIdRef.current = null;
        setViewId(null);
        setVersionsError("Couldn't open that version.");
      } else {
        setLoadFailed(true);
      }
    }
  }, [id]);

  useEffect(() => {
    firstLoad.current = true;
    viewIdRef.current = null;
    setViewId(null);
    setEditing(false);
    setNotice(null);
    setDetail(null);
    void load();
  }, [load]);

  // The history list follows the number of versions (a save, a restore or a finished run changes it).
  const versionCount = detail?.versions ?? 0;
  useEffect(() => {
    if (versionCount === 0) {
      setVersions([]);
      return;
    }
    let cancelled = false;
    fetchVersions(id)
      .then((list) => {
        if (cancelled) return;
        setVersions(list);
        setVersionsError(null);
      })
      .catch(() => {
        if (!cancelled) setVersionsError("Couldn't load the version history.");
      });
    return () => {
      cancelled = true;
    };
  }, [id, versionCount]);

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

  function startEdit() {
    setNotice(null);
    setEditError(null);
    setEditing(true);
  }

  async function onSaveEdit(cv: TailoredCv, letter: TailoredLetter) {
    if (!detail?.version) return;
    setSaving(true);
    setEditError(null);
    try {
      const out = await saveEdit(id, detail.version.id, cv, letter);
      if (!mounted.current) return;
      viewIdRef.current = null;
      setViewId(null);
      setEditing(false);
      setNotice({ kind: 'saved', versionNo: out.versionNo, hard: out.checks.filter((c) => c.severity === 'hard') });
      await load();
    } catch (err) {
      if (mounted.current) setEditError(saveErrorText(err));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  function onSelectVersion(v: VersionSummary) {
    const next = v.id === versions[0]?.id ? null : v.id;
    viewIdRef.current = next;
    setViewId(next);
    setNotice(null);
    setVersionsError(null);
    setRestoreError(false);
    void load();
  }

  async function onRestore() {
    const shown = detail?.version;
    if (!shown) return;
    setConfirmRestore(false);
    setRestoring(true);
    setRestoreError(false);
    try {
      const out = await restoreVersion(id, shown.id);
      if (!mounted.current) return;
      viewIdRef.current = null;
      setViewId(null);
      setNotice({ kind: 'restored', from: shown.versionNo, to: out.versionNo });
      await load();
    } catch {
      if (mounted.current) setRestoreError(true);
    } finally {
      if (mounted.current) setRestoring(false);
    }
  }

  // G (focus the regenerate box) arrives with Regenerate in Task 5; the key is already routed here.
  function focusRegenerate() {}

  useShortcuts(
    {
      e: detail?.version?.isCurrent ? startEdit : undefined,
      a: detail ? () => void onStatus('applied') : undefined,
      s: detail ? () => void onStatus('closed') : undefined,
      g: focusRegenerate,
    },
    !!detail && !editing && !confirmRestore,
  );

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
  const dlVersion = version && !version.isCurrent ? version.id : undefined;
  const reviewedNo = version?.review.reviewedVersionNo;

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
            <a className="btn" href={downloadUrl(id, 'cv', 'docx', dlVersion)}>
              Download CV DOCX
            </a>
            <a className="btn" href={downloadUrl(id, 'cv', 'pdf', dlVersion)}>
              Download CV PDF
            </a>
            <a className="btn" href={downloadUrl(id, 'cover_letter', 'docx', dlVersion)}>
              Download cover letter DOCX
            </a>
            <a className="btn" href={downloadUrl(id, 'cover_letter', 'pdf', dlVersion)}>
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
        <button
          type="button"
          className="btn btn-small keys-btn"
          aria-label="Keyboard shortcuts"
          aria-expanded={showKeys}
          aria-controls="shortcut-list"
          onClick={() => setShowKeys((v) => !v)}
        >
          ?
        </button>
      </section>
      {showKeys && (
        <ul id="shortcut-list" className="panel shortcut-list" aria-label="Shortcuts">
          {SHORTCUTS.map((k) => (
            <li key={k.key}>
              <kbd>{k.key}</kbd> {k.text}
            </li>
          ))}
        </ul>
      )}

      {notice?.kind === 'saved' && notice.hard.length > 0 && (
        <section className="panel attention" role="alert" aria-label="Edit saved">
          <h3>
            <span className="icon-warn" aria-hidden="true">
              ⚠
            </span>
            Your edit broke {notice.hard.length} {notice.hard.length === 1 ? 'rule' : 'rules'}
          </h3>
          <p>Saved as version {notice.versionNo}. Nothing was lost, but fix these before you apply.</p>
          <ul className="check-list">
            {notice.hard.map((c, i) => (
              <li key={i}>
                <strong>{checkLabel(c.code)}</strong> ({c.doc === 'cv' ? 'CV' : 'Cover letter'}) {c.detail}
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-small" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </section>
      )}
      {notice?.kind === 'saved' && notice.hard.length === 0 && (
        <p className="muted" role="status" aria-label="Edit saved">
          <span aria-hidden="true">✓ </span>Saved as version {notice.versionNo}. No rules broken.
        </p>
      )}
      {notice?.kind === 'restored' && (
        <p className="muted" role="status">
          <span aria-hidden="true">✓ </span>Restored version {notice.from} as version {notice.to}.
        </p>
      )}

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

      {version && !version.isCurrent && (
        <div className="panel version-banner" role="status" aria-label="Viewing an older version">
          <p>You're viewing version {version.versionNo} (not the current one)</p>
          <div className="banner-actions">
            <button type="button" className="btn btn-primary" disabled={restoring} onClick={() => setConfirmRestore(true)}>
              Restore this version
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                viewIdRef.current = null;
                setViewId(null);
                void load();
              }}
            >
              Back to the current version
            </button>
          </div>
          {restoreError && (
            <p className="attention-text" role="alert">
              <span aria-hidden="true">⚠ </span>Couldn't restore that version. Try again.
            </p>
          )}
        </div>
      )}

      {version && (
        <p className="muted basis">
          <span>Based on: {version.baseCvSourceRef ?? 'your base CV'}</span>
          <br />
          <span>
            Template: {TEMPLATE_NAMES[version.templateId] ?? version.templateId} — {version.reasons.templateReason}
          </span>
          {reviewedNo !== undefined && (
            <>
              <br />
              <span>Reviewer verdict is from version {reviewedNo}, before your edits.</span>
            </>
          )}
        </p>
      )}

      <div className="split">
        <section className="panel" aria-label="Job ad">
          <h2>Job ad</h2>
          <JobAd text={job.rawText} keywords={version?.keywordCoverage.covered ?? []} />
        </section>

        {version ? (
          <section className="panel" aria-label="Generated documents">
            {editing ? (
              <DocumentEditor
                key={version.id}
                cv={version.cv}
                letter={version.coverLetter}
                saving={saving}
                error={editError}
                onSave={(cv, letter) => void onSaveEdit(cv, letter)}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <>
            <div className="doc-head">
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
            {version.isCurrent && (
              <button type="button" className="btn btn-small" aria-keyshortcuts="E" onClick={startEdit}>
                Edit
              </button>
            )}
            </div>
            <div role="tabpanel" id="panel-doc" aria-labelledby={tab === 'cv' ? 'tab-cv' : 'tab-letter'}>
              {tab === 'cv' ? <CvPreview cv={version.cv} /> : <LetterPreview cv={version.cv} letter={version.coverLetter} />}
            </div>
              </>
            )}
          </section>
        ) : (
          <section className="panel" aria-label="Generated documents">
            <p className="muted">No CV or cover letter yet. Choose Generate to write them for this job.</p>
          </section>
        )}
      </div>

      {(versions.length > 0 || versionsError) && (
        <section className="panel" aria-label="Version history">
          <h2>Version history</h2>
          {versionsError && (
            <p className="attention-text" role="alert">
              <span aria-hidden="true">⚠ </span>
              {versionsError}
            </p>
          )}
          <VersionHistory versions={versions} selectedId={viewId} disabled={editing} onSelect={onSelectVersion} />
        </section>
      )}

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
      {confirmRestore && version && (
        <ConfirmDialog
          message={`Restore version ${version.versionNo}? This adds a new version with the same content. Nothing is lost.`}
          confirmLabel="Restore"
          onConfirm={() => void onRestore()}
          onCancel={() => setConfirmRestore(false)}
        />
      )}
    </main>
  );
}
