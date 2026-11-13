import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, baseFileUrl, fetchBaseFacts, saveBaseFacts } from '../api/client';
import type { BaseCoverLetterFacts, BaseCvFacts, BaseDocumentFacts, DocumentKind } from '../api/types';
import { ConfirmDialog } from '../job/ConfirmDialog';
import { useShortcuts } from '../job/useShortcuts';
import { useLeaveGuard } from '../useLeaveGuard';
import { BaseCvForm } from './BaseCvForm';
import { BaseLetterForm } from './BaseLetterForm';
import { FactsView } from './FactsView';
import { InvalidPathContext } from './FormParts';
import { documentWarningText } from './labels';

const COST_PER_JOB = 0.016;
type Facts = BaseCvFacts | BaseCoverLetterFacts;

const noun = (kind: DocumentKind) => (kind === 'cv' ? 'CV' : 'cover letter');
const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });

export function BaseDocumentPage({ kind }: { kind: DocumentKind }) {
  const [doc, setDoc] = useState<BaseDocumentFacts | null>(null);
  const [loadError, setLoadError] = useState(false);
  // The draft while editing; null when just viewing.
  const [draft, setDraft] = useState<Facts | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [badPath, setBadPath] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [confirm, setConfirm] = useState<'undo' | 'discard' | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const out = await fetchBaseFacts(kind);
      if (mounted.current) setDoc(out);
    } catch {
      if (mounted.current) setLoadError(true);
    }
  }, [kind]);
  useEffect(() => {
    setDoc(null);
    setDraft(null);
    void load();
  }, [load]);

  const editing = draft !== null;
  const dirty = editing && doc !== null && JSON.stringify(draft) !== JSON.stringify(doc.facts);

  function closeEditor() {
    setDraft(null);
    setError(null);
    setBadPath(null);
    setChanged(false);
  }
  const leave = useLeaveGuard(dirty, closeEditor);

  function startEdit() {
    if (!doc) return;
    setError(null);
    setBadPath(null);
    setChanged(false);
    setDraft(structuredClone(doc.facts));
  }
  useShortcuts({ e: startEdit }, doc !== null && !editing && confirm === null && !leave.pending);

  // Move to the field the worker called invalid.
  useEffect(() => {
    if (!badPath) return;
    const el = Array.from(document.querySelectorAll<HTMLElement>('[data-path]')).find((n) => n.dataset.path === badPath);
    el?.focus();
  }, [badPath, error]);

  async function save(facts: Facts | null) {
    if (!doc || saving) return;
    setSaving(true);
    setError(null);
    setBadPath(null);
    try {
      // The hash this page loaded, never a fresher one: a replaced file is a 409, not a silent overwrite.
      const out = await saveBaseFacts(kind, doc.id, doc.contentHash, facts);
      if (!mounted.current) return;
      setDoc(out);
      closeEditor();
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.status === 409) {
        setChanged(true);
      } else if (err instanceof ApiError && err.code === 'invalid_facts') {
        setBadPath(err.path ? err.path.replace(/^facts\./, '') : null);
        setError("One field isn't valid. It is marked below. Fix it and save again.");
      } else {
        setError("Couldn't save. Try again.");
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  async function onUndo() {
    setConfirm(null);
    await save(null);
  }

  function reload() {
    closeEditor();
    setDoc(null);
    void load();
  }

  if (loadError) {
    return (
      <main className="page">
        <p className="error attention" role="alert">
          <span aria-hidden="true">⚠ </span>
          Couldn't load your {noun(kind)}. Check it finished uploading, then try again.
        </p>
        <p>
          <button type="button" className="btn" onClick={() => void load()}>
            Try again
          </button>{' '}
          <Link to="/documents">Back to your documents</Link>
        </p>
      </main>
    );
  }
  if (!doc) return <main className="page" aria-busy="true"><p className="muted">Loading…</p></main>;

  const isPdf = doc.mediaType === 'application/pdf';
  const jobs = doc.rescoreJobs;

  return (
    <main className="page">
      <p className="back">
        <Link to="/documents">Your documents</Link>
      </p>
      <header className="page-header doc-head">
        <div>
          <h1>{kind === 'cv' ? 'Your CV' : 'Your cover letter'}</h1>
          <p className="muted doc-file">
            <span>{doc.sourceRef}</span>
            {doc.edited && doc.editedAt && <span className="edited-note"> — Edited in the app · {formatDate(doc.editedAt)}</span>}
          </p>
        </div>
        {!editing && (
          <div className="doc-actions">
            <button type="button" className="btn btn-primary" onClick={startEdit}>
              Edit <kbd aria-hidden="true">E</kbd>
            </button>
            {doc.edited && (
              <button type="button" className="btn" disabled={saving} onClick={() => setConfirm('undo')}>
                Undo all edits
              </button>
            )}
          </div>
        )}
      </header>

      {changed && (
        <p className="error attention" role="alert">
          <span aria-hidden="true">⚠ </span>
          Your {noun(kind)} changed since you opened it. Reload to edit the new one.{' '}
          <button type="button" className="btn btn-small" onClick={reload}>
            Reload
          </button>
        </p>
      )}
      {error && !editing && (
        <p className="error attention" role="alert">
          <span aria-hidden="true">⚠ </span>
          {error}
        </p>
      )}

      <div className="split doc-split">
        <section className="panel doc-original" aria-label="Original file">
          <h2>Original</h2>
          {isPdf ? (
            <iframe title="Original file" src={baseFileUrl(kind)} />
          ) : (
            <>
              <p className="muted">Your browser can't show a Word file. Download it to compare.</p>
              <a className="btn" href={baseFileUrl(kind)} download>
                Download original
              </a>
            </>
          )}
        </section>

        <section className="panel doc-facts" aria-label="Facts">
          <h2>{editing ? 'Edit the facts' : 'Facts read from the file'}</h2>
          {doc.warnings.length > 0 && (
            <ul className="doc-warnings" aria-label="Needs attention">
              {doc.warnings.map((w, i) => (
                <li key={i} className="attention-text">
                  <span aria-hidden="true">⚠ </span>
                  <strong>Needs attention</strong>: {documentWarningText(w)}
                </li>
              ))}
            </ul>
          )}
          {editing ? (
            <form
              className="editor"
              aria-label={`Edit your ${noun(kind)}`}
              onSubmit={(e) => {
                e.preventDefault();
                if (dirty) void save(draft);
              }}
            >
              <InvalidPathContext.Provider value={badPath}>
                {kind === 'cv' ? (
                  <BaseCvForm facts={draft as BaseCvFacts} onChange={setDraft} />
                ) : (
                  <BaseLetterForm facts={draft as BaseCoverLetterFacts} onChange={setDraft} />
                )}
              </InvalidPathContext.Provider>
              {kind === 'cv' && jobs > 0 && (
                <p className="muted">
                  Saving re-scores your {jobs} {jobs === 1 ? 'job' : 'jobs'} (about US${(jobs * COST_PER_JOB).toFixed(2)}).
                </p>
              )}
              {error && (
                <p className="error attention" role="alert">
                  <span aria-hidden="true">⚠ </span>
                  {error}
                </p>
              )}
              <div className="editor-actions">
                <button type="submit" className="btn btn-primary" disabled={saving || !dirty}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                <button type="button" className="btn" disabled={saving} onClick={() => (dirty ? setConfirm('discard') : closeEditor())}>
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <FactsView kind={kind} facts={doc.facts} />
          )}
        </section>
      </div>

      {leave.pending && (
        <ConfirmDialog
          message="You have unsaved edits — leave anyway?"
          confirmLabel="Leave"
          cancelLabel="Keep editing"
          onConfirm={leave.confirm}
          onCancel={leave.cancel}
        />
      )}
      {confirm === 'undo' && (
        <ConfirmDialog
          message={`Undo all your edits? Your ${noun(kind)} goes back to what was read from the file.`}
          confirmLabel="Undo all edits"
          onConfirm={() => void onUndo()}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === 'discard' && (
        <ConfirmDialog
          message="Discard your changes?"
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          onConfirm={() => {
            setConfirm(null);
            closeEditor();
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </main>
  );
}
