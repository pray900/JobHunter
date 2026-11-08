import type { VersionSummary } from '../api/types';
import { ORIGIN_ICON, ORIGIN_TEXT, hardChecksText } from './labels';

const when = (iso: string) => new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
// Labels made before they were kept on one line may hold line breaks.
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function Verdict({ passed }: { passed: boolean | null }) {
  if (passed === true) {
    return (
      <span className="verdict verdict-ok">
        <span aria-hidden="true">✓ </span>Passed
      </span>
    );
  }
  if (passed === false) {
    return (
      <span className="verdict attention-text">
        <span aria-hidden="true">⚠</span> Not passed
      </span>
    );
  }
  return <span className="verdict muted">Not reviewed</span>;
}

export function VersionHistory(props: {
  versions: VersionSummary[];
  // The version on screen, or null for the current one.
  selectedId: string | null;
  onSelect: (v: VersionSummary) => void;
  disabled?: boolean;
}) {
  const { versions, selectedId, onSelect, disabled } = props;
  if (versions.length === 0) return <p className="muted">No versions yet.</p>;
  const shownId = selectedId ?? versions[0]!.id;
  return (
    <ol className="versions" aria-label="Versions">
      {versions.map((v, i) => (
        <li key={v.id}>
          <button type="button" className="version-row" disabled={disabled} aria-current={v.id === shownId ? 'true' : undefined} onClick={() => onSelect(v)}>
            <span className="version-top">
              <strong>Version {v.versionNo}</strong>
              {i === 0 && <span className="badge">Current</span>}
              <span className="muted">
                <span aria-hidden="true">{ORIGIN_ICON[v.origin]} </span>
                {ORIGIN_TEXT[v.origin]}
              </span>
              <time className="muted" dateTime={v.createdAt}>
                {when(v.createdAt)}
              </time>
            </span>
            <span className="version-bottom">
              {v.instruction ? (
                <span className="version-note" title={v.instruction}>
                  “{oneLine(v.label)}”
                </span>
              ) : v.label !== ORIGIN_TEXT[v.origin] && v.label !== 'Generated' && v.label !== 'Edited' ? (
                <span className="version-note">{v.label}</span>
              ) : null}
              <Verdict passed={v.passed} />
              {v.hardChecks > 0 && (
                <span className="attention-text">
                  <span aria-hidden="true">⚠</span> {hardChecksText(v.hardChecks)}
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
