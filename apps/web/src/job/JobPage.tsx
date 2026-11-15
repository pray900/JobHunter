import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, downloadUrl, fetchJobDetail, fetchVersions, generate, restoreVersion, saveCompanyNotes, saveEdit, setStatus, setTemplate } from '../api/client';
import type { CheckResult, JobDetail, JobStatus, TailoredCv, TailoredLetter, VersionSummary } from '../api/types';
import { STATUSES, statusLabel } from '../jobs/labels';
import { safeHref } from '../jobs/safeHref';
import { useLeaveGuard } from '../useLeaveGuard';
import { ConfirmDialog } from './ConfirmDialog';
import { DocumentEditor } from './DocumentEditor';
import { CvPreview, LetterPreview } from './DocumentPreview';
import { BaseDiff } from './BaseDiff';
import { highlightKeywords } from './highlightKeywords';
import { TEMPLATE_NAMES, checkLabel, progressText } from './labels';
import { editedPaths } from './manualEdits';
import { ReasonsPanel } from './ReasonsPanel';
import { RegeneratePanel } from './RegeneratePanel';
import { SHORTCUTS, useShortcuts } from './useShortcuts';
import { VersionHistory } from './VersionHistory';

const POLL_MS = 5000;

const TEMPLATE_NOTE = "Applies to the next Generate. Regenerate keeps the current version's template.";

function generateErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'generation_in_progress') return 'Already running. Progress will show here.';
    if (err.code === 'job_not_ready') return "This job hasn't been read yet. Try again in a moment.";
    if (err.code === 'base_cv_not_ready') return "Your base CV isn't ready. Check My documents.";
    if (err.code === 'version_not_found') return 'The version to regenerate from no longer exists. Choose Generate again.';
    if (err.code === 'bad_instruction' || err.code === 'bad_request') return 'The instruction must be 1 to 1000 characters.';
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

type Notice = { kind: 'saved'; versionNo: number; hard: CheckResult[]; review: CheckResult[] } | { kind: 'restored'; from: number; to: number };

// The version the editor was opened on. The editor and Save stay on it even when a run finishes meanwhile.
type EditBase = { id: string; versionNo: number; cv: TailoredCv; coverLetter: TailoredLetter };

const NEWER_WHILE_EDITING =
  'A new version finished while you were editing. Saving adds your edit as the newest version; the other one stays in the history.';
const GENERATE_AGAIN_HINT = 'Writes new documents from your base CV. Your edits are not carried over (they stay in the history).';
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function CheckLines({ checks, templateId }: { checks: CheckResult[]; templateId?: string }) {
  return (
    <ul className="check-list">
      {checks.map((c, i) => (
        <li key={i}>
          <strong>{checkLabel(c.code, templateId)}</strong> ({c.doc === 'cv' ? 'CV' : 'Cover letter'}) {c.detail}
        </li>
      ))}
    </ul>
  );
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
  const [tab, setTab] = useState<'cv' | 'letter' | 'diff'>('cv');
  const [genError, setGenError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [status, setStatusValue] = useState<JobStatus>('new');
  const [statusError, setStatusError] = useState(false);
  const [notes, setNotes] = useState('');
  const [savedNotes, setSavedNotes] = useState('');
  const [templateError, setTemplateError] = useState(false);
  const [templateSaving, setTemplateSaving] = useState(false);
  const [notesState, setNotesState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [editBase, setEditBase] = useState<EditBase | null>(null);
  const editing = editBase !== null;
  const [dirty, setDirty] = useState(false);
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
  const regenRef = useRef<HTMLTextAreaElement | null>(null);
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
    setEditBase(null);
    setNotice(null);
    setDetail(null);
    void load();
  }, [load]);

  // Unsaved edits: reload, closing the tab and in-app links ask first.
  const leave = useLeaveGuard(editing && dirty, closeEditor);

  function closeEditor() {
    setEditBase(null);
    setDirty(false);
  }

  const shown = detail?.version ?? null;
  const editedSet = useMemo(
    () => (shown ? editedPaths(shown.manualEdits, { cv: shown.cv, coverLetter: shown.coverLetter }) : new Set<string>()),
    [shown],
  );

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
    const order = ['cv', 'letter', 'diff'] as const;
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
    document.getElementById(`tab-${next}`)?.focus();
  }

  function startEdit() {
    const v = detail?.version;
    if (!v) return;
    setNotice(null);
    setEditError(null);
    setDirty(false);
    setEditBase({ id: v.id, versionNo: v.versionNo, cv: v.cv, coverLetter: v.coverLetter });
  }

  async function onSaveEdit(cv: TailoredCv, letter: TailoredLetter) {
    if (!editBase) return;
    setSaving(true);
    setEditError(null);
    try {
      // Always the version the editor was opened on, even if a newer one finished meanwhile.
      const out = await saveEdit(id, editBase.id, cv, letter);
      if (!mounted.current) return;
      viewIdRef.current = null;
      setViewId(null);
      closeEditor();
      setNotice({
        kind: 'saved',
        versionNo: out.versionNo,
        hard: out.checks.filter((c) => c.severity === 'hard'),
        review: out.checks.filter((c) => c.severity === 'review'),
      });
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

  function focusRegenerate() {
    const box = regenRef.current;
    if (box && !box.disabled) box.focus();
  }

  useShortcuts(
    {
      e: detail?.version?.isCurrent ? startEdit : undefined,
      a: detail ? () => void onStatus('applied') : undefined,
      s: detail ? () => void onStatus('closed') : undefined,
      g: focusRegenerate,
    },
    !!detail && !editing && !confirmRestore,
  );

  async function onGenerate(again?: { instruction: string; fromVersionId: string }) {
    setGenError(null);
    setStarting(true);
    try {
      if (again) await generate(id, again);
      else await generate(id);
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

  async function onTemplate(next: 'standard-ats' | 'au-government' | null) {
    setTemplateError(false);
    setTemplateSaving(true);
    try {
      const out = await setTemplate(id, next);
      if (mounted.current) setDetail((d) => (d ? { ...d, job: { ...d.job, templateChoice: out.templateChoice } } : d));
    } catch {
      if (mounted.current) setTemplateError(true);
    }
    if (mounted.current) setTemplateSaving(false);
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
  const { templateChoice, suggestedTemplate } = job;
  const shownTemplate = templateChoice ?? suggestedTemplate ?? 'standard-ats';
  const href = safeHref(job.url);
  const company = job.employer && job.advertiser ? `${job.employer} via ${job.advertiser}` : (job.employer ?? job.advertiser);
  const failed = generation?.status === 'failed' && !running;
  const dlVersion = version && !version.isCurrent ? version.id : undefined;
  const reviewedNo = version?.review.reviewedVersionNo;
  // A failed regenerate is tried again as the same regenerate (same instruction, same starting version).
  const retryRegen =
    generation?.instruction && generation.fromVersionId ? { instruction: generation.instruction, fromVersionId: generation.fromVersionId } : undefined;
  const newerWhileEditing = editBase && version && version.isCurrent && version.id !== editBase.id ? NEWER_WHILE_EDITING : null;

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
          <>
            <button
              type="button"
              className="btn btn-primary"
              disabled={starting}
              title={version ? GENERATE_AGAIN_HINT : undefined}
              aria-describedby={version ? 'generate-again-hint' : undefined}
              onClick={() => void onGenerate()}
            >
              {version ? 'Generate again' : 'Generate'}
            </button>
            <div className="template-pick">
              <label className="template-select">
                <span className="label">Template</span>
                <select
                  value={shownTemplate}
                  disabled={templateSaving}
                  onChange={(e) => void onTemplate(e.target.value as 'standard-ats' | 'au-government')}
                >
                  {Object.entries(TEMPLATE_NAMES).map(([tid, name]) => (
                    <option key={tid} value={tid}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              {templateChoice !== null && suggestedTemplate !== null && templateChoice !== suggestedTemplate && (
                <button type="button" className="btn btn-small" disabled={templateSaving} onClick={() => void onTemplate(null)}>
                  Use suggestion
                </button>
              )}
            </div>
            {templateChoice === null && suggestedTemplate !== null && (
              <p className="muted gen-hint">
                Suggested: {TEMPLATE_NAMES[suggestedTemplate] ?? suggestedTemplate}
                {job.templateReason ? ` — ${job.templateReason}` : ''}
              </p>
            )}
            <p className="muted gen-hint">{TEMPLATE_NOTE}</p>
            {templateError && (
              <p className="attention-text" role="alert">
                <span aria-hidden="true">⚠ </span>Couldn't save the template. Try again.
              </p>
            )}
            {version && (
              <p id="generate-again-hint" className="muted gen-hint">
                {GENERATE_AGAIN_HINT}
              </p>
            )}
          </>
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

      {notice?.kind === 'saved' && (notice.hard.length > 0 || notice.review.length > 0) && (
        <section className="panel attention" role="alert" aria-label="Edit saved">
          <h3>
            <span className="icon-warn" aria-hidden="true">
              ⚠
            </span>
            {notice.hard.length > 0 ? `Your edit broke ${notice.hard.length} ${notice.hard.length === 1 ? 'rule' : 'rules'}` : 'Needs a look'}
          </h3>
          <p>
            Saved as version {notice.versionNo}. Nothing was lost, but {notice.hard.length > 0 ? 'fix these' : 'check these'} before you apply.
          </p>
          {notice.hard.length > 0 && <CheckLines checks={notice.hard} templateId={version?.templateId} />}
          {notice.review.length > 0 && (
            <>
              {notice.hard.length > 0 && <h4>Needs a look</h4>}
              <p>The reviewer did not see your edit. Check these yourself.</p>
              <CheckLines checks={notice.review} templateId={version?.templateId} />
            </>
          )}
          <button type="button" className="btn btn-small" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </section>
      )}
      {notice?.kind === 'saved' && notice.hard.length === 0 && notice.review.length === 0 && (
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
          {retryRegen && <p className="muted">Try again repeats your regenerate: “{oneLine(retryRegen.instruction)}”</p>}
          <button type="button" className="btn" disabled={starting} onClick={() => void onGenerate(retryRegen)}>
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
              editBase && (
                <DocumentEditor
                  key={editBase.id}
                  cv={editBase.cv}
                  letter={editBase.coverLetter}
                  saving={saving}
                  error={editError}
                  notice={newerWhileEditing}
                  onDirtyChange={setDirty}
                  onSave={(cv, letter) => void onSaveEdit(cv, letter)}
                  onCancel={closeEditor}
                />
              )
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
              <button
                type="button"
                role="tab"
                id="tab-diff"
                aria-selected={tab === 'diff'}
                aria-controls="panel-doc"
                tabIndex={tab === 'diff' ? 0 : -1}
                onClick={() => setTab('diff')}
              >
                Diff vs base CV
              </button>
            </div>
            {version.isCurrent && (
              <button type="button" className="btn btn-small" aria-keyshortcuts="E" onClick={startEdit}>
                Edit
              </button>
            )}
            </div>
            <div role="tabpanel" id="panel-doc" aria-labelledby={`tab-${tab}`}>
              {tab === 'cv' ? (
                <CvPreview cv={version.cv} edited={editedSet} templateId={version.templateId} />
              ) : tab === 'letter' ? (
                <LetterPreview cv={version.cv} letter={version.coverLetter} edited={editedSet} />
              ) : (
                <BaseDiff baseCv={detail.baseCv} cv={version.cv} reasons={version.reasons} />
              )}
            </div>
            <RegeneratePanel
              key={version.id}
              jobId={id}
              fromVersionId={version.id}
              running={!!running}
              inputRef={regenRef}
              onStarted={() => {
                // The new version will be the current one: show it when it is saved.
                viewIdRef.current = null;
                setViewId(null);
                void load();
              }}
            />
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
      {leave.pending && (
        <ConfirmDialog
          message="You have unsaved edits — leave anyway?"
          confirmLabel="Leave"
          cancelLabel="Keep editing"
          onConfirm={leave.confirm}
          onCancel={leave.cancel}
        />
      )}
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
