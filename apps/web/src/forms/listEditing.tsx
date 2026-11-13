import { createContext, useContext } from 'react';

// The path the worker called invalid (without the leading "facts."), e.g. roles[2].bullets[0].
export const InvalidPathContext = createContext<string | null>(null);
const useInvalid = (path: string) => useContext(InvalidPathContext) === path;

// Visible words beside a marked field, so the amber ring is not the only signal.
export function NotValid() {
  return (
    <span className="not-valid attention-text">
      <span aria-hidden="true">⚠ </span>Not valid
    </span>
  );
}

// Wraps an object list (education, roles, projects) so a list-level bad path can mark and focus it.
export function ListBox(props: { path: string; children: React.ReactNode }) {
  const invalid = useInvalid(props.path);
  return (
    <div className={invalid ? 'list-box invalid' : 'list-box'} data-path={props.path} tabIndex={-1} aria-invalid={invalid ? true : undefined}>
      {invalid && <NotValid />}
      {props.children}
    </div>
  );
}

export function move<T>(list: T[], i: number, by: -1 | 1): T[] {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}
export const replaceAt = <T,>(list: T[], i: number, v: T): T[] => list.map((x, k) => (k === i ? v : x));
export function applyTool<T>(list: T[], i: number, what: 'up' | 'down' | 'remove'): T[] {
  return what === 'remove' ? list.filter((_, k) => k !== i) : move(list, i, what === 'up' ? -1 : 1);
}

export function RowTools(props: { noun: string; i: number; count: number; onChange: (what: 'up' | 'down' | 'remove') => void }) {
  const { noun, i, count, onChange } = props;
  return (
    <span className="row-tools">
      <button type="button" className="btn btn-small" aria-label={`Move ${noun} ${i + 1} up`} disabled={i === 0} onClick={() => onChange('up')}>
        <span aria-hidden="true">↑</span>
      </button>
      <button type="button" className="btn btn-small" aria-label={`Move ${noun} ${i + 1} down`} disabled={i === count - 1} onClick={() => onChange('down')}>
        <span aria-hidden="true">↓</span>
      </button>
      <button type="button" className="btn btn-small" aria-label={`Remove ${noun} ${i + 1}`} onClick={() => onChange('remove')}>
        <span aria-hidden="true">✕</span>
      </button>
    </span>
  );
}

// A labelled text field. `path` ties it to a worker error path (marked and focused when it is the bad one).
export function TextField(props: { label: string; path: string; value: string | null; onChange: (v: string) => void; area?: boolean; rows?: number }) {
  const { label, path, value, onChange, area, rows } = props;
  const invalid = useInvalid(path);
  const common = {
    value: value ?? '',
    'data-path': path,
    'aria-invalid': invalid ? (true as const) : undefined,
    className: invalid ? 'invalid' : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(e.target.value),
  };
  return (
    <div className="edit-field">
      <label>
        <span className="label">{label}</span>
        {area ? <textarea {...common} rows={rows ?? 4} /> : <input type="text" {...common} />}
      </label>
      {invalid && <NotValid />}
    </div>
  );
}

// A list of text lines (path optional: only needed to mark a bad line) that can be added to, removed from and reordered.
export function StringList(props: { noun: string; path?: string; items: string[]; onChange: (items: string[]) => void; multiline?: boolean }) {
  const { noun, path, items, onChange, multiline } = props;
  const bad = useContext(InvalidPathContext);
  const listBad = path !== undefined && bad === path;
  return (
    <div
      className={listBad ? 'edit-list invalid' : 'edit-list'}
      data-path={path}
      tabIndex={path === undefined ? undefined : -1}
      aria-invalid={listBad ? true : undefined}
    >
      {listBad && <NotValid />}
      {items.map((text, i) => {
        const p = path === undefined ? null : `${path}[${i}]`;
        const common = {
          'aria-label': `${noun} ${i + 1}`,
          'data-path': p ?? undefined,
          'aria-invalid': p !== null && bad === p ? (true as const) : undefined,
          className: p !== null && bad === p ? 'invalid' : undefined,
          value: text,
        };
        return (
          <div className="edit-row" key={i}>
            {multiline ? (
              <textarea {...common} rows={4} onChange={(e) => onChange(replaceAt(items, i, e.target.value))} />
            ) : (
              <input type="text" {...common} onChange={(e) => onChange(replaceAt(items, i, e.target.value))} />
            )}
            <RowTools noun={noun} i={i} count={items.length} onChange={(w) => onChange(applyTool(items, i, w))} />
            {p !== null && bad === p && <NotValid />}
          </div>
        );
      })}
      <button type="button" className="btn btn-small" onClick={() => onChange([...items, ''])}>
        Add {noun}
      </button>
    </div>
  );
}
