import { useRef, useState } from 'react';
import type { BaseDocumentSummary, DocumentKind } from '../api/types';
import { documentWarningText } from './labels';

const COPY: Record<DocumentKind, { heading: string; empty: string; upload: string; chooser: string }> = {
  cv: { heading: 'Your CV', empty: 'No CV yet', upload: 'Upload CV', chooser: 'Choose CV file' },
  cover_letter: {
    heading: 'Your cover letter',
    empty: 'No cover letter yet',
    upload: 'Upload cover letter',
    chooser: 'Choose cover letter file',
  },
};

export function ConfirmDialog(props: {
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-label={props.message}>
        <p>{props.message}</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={props.danger ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={props.onConfirm}
            autoFocus
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DocumentSlot(props: {
  kind: DocumentKind;
  doc: BaseDocumentSummary | null;
  busy: boolean;
  onFile: (file: File) => void;
}) {
  const { kind, doc, busy, onFile } = props;
  const copy = COPY[kind];
  const inputRef = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);

  const pick = () => inputRef.current?.click();
  const analysing = doc?.analysisStatus === 'pending' || doc?.analysisStatus === 'in_progress';

  return (
    <section className="card" aria-label={copy.heading}>
      <h2 className="card-title">{copy.heading}</h2>
      {doc === null ? (
        <p className="muted">{copy.empty}</p>
      ) : (
        <>
          <p className="slot-file">{doc.sourceRef}</p>
          {analysing && <p className="note">Analysing…</p>}
          {doc.analysisStatus === 'done' && <p className="note">Ready</p>}
          {doc.analysisStatus === 'failed' && (
            <p className="note note-bad">Couldn't read this document: {doc.analysisError ?? 'unknown error'}</p>
          )}
          {doc.warnings.length > 0 && (
            <ul className="warnings">
              {doc.warnings.map((w, i) => (
                <li key={`${w.code}-${i}`}>{documentWarningText(w)}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <input
        ref={inputRef}
        type="file"
        className="sr-file"
        aria-label={copy.chooser}
        accept=".pdf,.doc,.docx"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onFile(file);
        }}
      />
      <div className="slot-actions">
        {doc === null ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={pick}>
            {copy.upload}
          </button>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(true)}>
            Replace
          </button>
        )}
      </div>
      {confirming && doc !== null && (
        <ConfirmDialog
          message={`Replace ${doc.sourceRef}? The old file is removed from your folder.`}
          confirmLabel="Replace file"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            pick();
          }}
        />
      )}
    </section>
  );
}
