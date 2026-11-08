import { useMemo } from 'react';
import type { TailoredCv, VersionBaseCv, VersionReasons } from '../api/types';
import { diffAgainstBase, normaliseText, wordDiff, type BaseCvStructured } from './diffAgainstBase';

function Changed({ title, change }: { title: string; change: { before: string | null; after: string } }) {
  const same = change.before !== null && normaliseText(change.before) === normaliseText(change.after);
  return (
    <div className="diff-block">
      <h4>
        {title} {same ? <span className="diff-tag">Kept</span> : <span className="diff-tag">{change.before === null ? 'Added' : 'Reworded'}</span>}
      </h4>
      {!same && change.before !== null && <del>{change.before}</del>}
      <p>{!same && change.before !== null ? <Highlighted before={change.before} after={change.after} /> : change.after}</p>
    </div>
  );
}

function Highlighted({ before, after }: { before: string; after: string }) {
  return (
    <>
      {wordDiff(before, after).map((w, i) => (
        <span key={i}>
          {w.changed ? <mark>{w.text}</mark> : w.text}
          {' '}
        </span>
      ))}
    </>
  );
}

export function BaseDiff({ baseCv, cv, reasons }: { baseCv: VersionBaseCv | null; cv: TailoredCv; reasons: VersionReasons }) {
  const diff = useMemo(() => (baseCv ? diffAgainstBase(baseCv.structured as BaseCvStructured, cv) : null), [baseCv, cv]);
  const stretchTexts = useMemo(() => new Set(reasons.stretches.map((s) => normaliseText(s.text))), [reasons]);

  if (!baseCv || !diff) {
    return (
      <div className="diff-view">
        <p className="muted">
          <strong>Base CV no longer available.</strong> This version was made from an earlier base CV that's no longer stored, so there is nothing to compare it with.
        </p>
      </div>
    );
  }

  return (
    <div className="diff-view">
      {!baseCv.isCurrentBase && (
        <p className="panel attention" role="status">
          <span className="icon-warn" aria-hidden="true">
            ⚠
          </span>
          Your base CV has changed since this version. This compares it with the base CV it was made from.
        </p>
      )}
      <p className="muted">Compared with {baseCv.sourceRef ?? 'your base CV'}.</p>
      <Changed title="Headline" change={diff.headline} />
      <Changed title="Summary" change={diff.summary} />

      {diff.roles.map((r, i) => (
        <section key={i} className="diff-role" aria-label={`${r.title} at ${r.employer}`}>
          <h3>
            {r.title} · {r.employer}
          </h3>
          <ul className="diff-bullets">
            {r.bullets.map((b, j) => {
              const stretch = b.kind === 'added' && stretchTexts.has(normaliseText(b.text));
              return (
                <li key={j} className={`diff-${b.kind}${stretch ? ' diff-stretch' : ''}`}>
                  <span className="diff-tag">{b.kind === 'kept' ? 'Kept' : b.kind === 'reworded' ? 'Reworded' : 'Added'}</span>
                  {stretch && <span className="badge-stretch">Stretch</span>}{' '}
                  {b.kind === 'reworded' && b.baseText !== undefined ? (
                    <>
                      <del>{b.baseText}</del>
                      <span className="diff-new">
                        <Highlighted before={b.baseText} after={b.text} />
                      </span>
                    </>
                  ) : (
                    <span className="diff-new">{b.text}</span>
                  )}
                </li>
              );
            })}
          </ul>
          {r.dropped.length > 0 && (
            <section className="diff-left-out" aria-label="Left out">
              <h4>Left out</h4>
              <ul>
                {r.dropped.map((t, j) => (
                  <li key={j}>{t}</li>
                ))}
              </ul>
            </section>
          )}
        </section>
      ))}

      {(diff.rolesDropped.length > 0 || diff.projects.dropped.length > 0 || diff.skills.dropped.length > 0) && (
        <section className="diff-left-out" aria-label="Left out of the whole CV">
          <h3>Left out</h3>
          <ul>
            {diff.rolesDropped.map((e) => (
              <li key={`r-${e}`}>Role at {e || 'an unnamed employer'}</li>
            ))}
            {diff.projects.dropped.map((p) => (
              <li key={`p-${p}`}>Project: {p}</li>
            ))}
            {diff.skills.dropped.map((s) => (
              <li key={`s-${s}`}>Skill: {s}</li>
            ))}
          </ul>
        </section>
      )}

      {diff.skills.added.length > 0 && (
        <section aria-label="Skills added">
          <h3>Skills added</h3>
          <ul className="tags">
            {diff.skills.added.map((s) => (
              <li key={s}>
                <span className="diff-tag">Added</span> {s}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
