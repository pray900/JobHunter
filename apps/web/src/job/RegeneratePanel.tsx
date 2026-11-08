import { useState, type RefObject } from 'react';
import { ApiError, generate } from '../api/client';

const MAX = 1000;

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'bad_instruction' || err.code === 'bad_request') return 'The instruction must be 1 to 1000 characters.';
    if (err.code === 'generation_in_progress' || err.status === 409) return 'Already running. Progress will show here.';
    if (err.code === 'version_not_found') return 'That version no longer exists. Reload the page.';
    if (err.code === 'job_not_found') return "This job couldn't be found.";
    if (err.code === 'base_cv_not_ready') return "Your base CV isn't ready. Check My documents.";
    if (err.code === 'job_not_ready') return "This job hasn't been read yet. Try again in a moment.";
  }
  return "Couldn't start the rewrite. Try again.";
}

interface Props {
  jobId: string;
  // The version on screen; the rewrite starts from it.
  fromVersionId: string;
  // A run is pending or in progress (its progress shows above).
  running: boolean;
  onStarted: () => void;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}

export function RegeneratePanel({ jobId, fromVersionId, running, onStarted, inputRef }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = text.trim();
  // Counted as the server counts: characters (an emoji is one) of the trimmed text.
  const count = Array.from(trimmed).length;
  const tooLong = count > MAX;
  const valid = count >= 1 && !tooLong;
  const off = running || busy;

  async function submit() {
    if (!valid || off) return;
    setBusy(true);
    setError(null);
    try {
      await generate(jobId, { instruction: trimmed, fromVersionId });
      setText('');
      onStarted();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="regen" aria-label="Regenerate">
      <label htmlFor="regen-instruction" className="label">
        Regenerate with an instruction
      </label>
      <textarea
        id="regen-instruction"
        ref={inputRef}
        rows={3}
        value={text}
        disabled={off}
        aria-describedby="regen-hint regen-count"
        placeholder="For example: lead with my Apex work and keep the summary shorter"
        onChange={(e) => setText(e.target.value)}
      />
      <p id="regen-hint" className="muted regen-hint">
        Claude keeps your edits exactly as you wrote them. It will never add facts that aren't in your base CV.
      </p>
      <div className="regen-bar">
        <span id="regen-count" className={tooLong ? 'attention-text' : 'muted'}>
          {tooLong && <span aria-hidden="true">⚠ </span>}
          {count} / {MAX}
          {tooLong ? ' – too long, shorten it' : ''}
        </span>
        <button type="button" className="btn btn-primary" disabled={!valid || off} aria-keyshortcuts="G" onClick={() => void submit()}>
          Regenerate
        </button>
      </div>
      {error && (
        <p className="attention-text" role="alert">
          <span aria-hidden="true">⚠ </span>
          {error}
        </p>
      )}
    </section>
  );
}
