import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, deleteDocument, fetchDocuments, uploadDocument } from '../api/client';
import type { BaseDocumentSummary, DocumentKind, DocumentsResponse } from '../api/types';
import { ConfirmDialog, DocumentSlot } from './DocumentSlot';
import { documentWarningText, uploadErrorText } from './labels';

const MAX_BYTES = 5 * 1024 * 1024;

function isAnalysing(d: BaseDocumentSummary | null): boolean {
  return d?.analysisStatus === 'pending' || d?.analysisStatus === 'in_progress';
}

export function DocumentsPage({ pollMs = 3000 }: { pollMs?: number }) {
  const [docs, setDocs] = useState<DocumentsResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<BaseDocumentSummary | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setDocs(await fetchDocuments());
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep polling while any slot is still being analysed; stop once everything has settled.
  const polling = docs !== null && (isAnalysing(docs.cv) || isAnalysing(docs.coverLetter));
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [polling, pollMs, load]);

  async function onFile(kind: DocumentKind, file: File) {
    setMessage(null);
    if (file.size > MAX_BYTES) {
      setMessage(uploadErrorText(400));
      return;
    }
    setBusy(true);
    try {
      await uploadDocument(kind, file);
      await load();
    } catch (err) {
      setMessage(uploadErrorText(err instanceof ApiError ? err.status : 0));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(d: BaseDocumentSummary) {
    setDeleting(null);
    setMessage(null);
    setBusy(true);
    try {
      await deleteDocument(d.id);
      await load();
    } catch {
      setMessage("Couldn't delete that file. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <header className="page-header">
        <h1>My documents</h1>
      </header>

      {loadFailed && (
        <div className="error" role="alert">
          <p>Couldn't load your documents. Is the backend running?</p>
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {message && (
        <div className="error" role="alert">
          <p>{message}</p>
        </div>
      )}
      {docs === null && !loadFailed && <p className="muted">Loading documents…</p>}

      {docs !== null && (
        <>
          <div className="slots">
            <DocumentSlot kind="cv" doc={docs.cv} busy={busy} onFile={(f) => void onFile('cv', f)} />
            <DocumentSlot
              kind="cover_letter"
              doc={docs.coverLetter}
              busy={busy}
              onFile={(f) => void onFile('cover_letter', f)}
            />
          </div>

          {docs.ignored.length > 0 && (
            <section className="ignored">
              <h2>Other files in your folders (not used)</h2>
              <ul className="ignored-list">
                {docs.ignored.map((d) => (
                  <li key={d.id}>
                    <div>
                      <span className="ignored-name">{d.sourceRef}</span>
                      {d.warnings.map((w, i) => (
                        <div key={`${w.code}-${i}`} className="muted">
                          {documentWarningText(w)}
                        </div>
                      ))}
                    </div>
                    <button type="button" className="btn" disabled={busy} onClick={() => setDeleting(d)}>
                      Delete
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {deleting && (
        <ConfirmDialog
          message={`Delete ${deleting.sourceRef}? This removes the file from your folder.`}
          confirmLabel="Delete file"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => void confirmDelete(deleting)}
        />
      )}
    </main>
  );
}
