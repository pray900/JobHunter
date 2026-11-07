import type { CheckResult, DocumentVersion, JobDetailJob, UnresolvedItem } from '../api/types';
import { checkLabel, reviewItemLabel } from './labels';

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span className="icon-warn" aria-hidden="true">
        ⚠
      </span>
      <span>{children}</span>
    </>
  );
}

function unresolvedLine(u: UnresolvedItem): { label: string; detail: string } {
  switch (u.source) {
    case 'check':
      return { label: checkLabel(u.code), detail: u.note ? `${u.detail} ${u.note}` : u.detail };
    case 'review':
      return { label: reviewItemLabel(u.id), detail: u.note };
    case 'fact':
      return { label: 'Claim the reviewer judged invented', detail: `${u.text} — ${u.why}` };
    case 'spelling':
      return { label: 'Misspelt word', detail: u.fix ? `${u.word} should be ${u.fix}` : u.word };
  }
}

function CheckList({ checks }: { checks: CheckResult[] }) {
  return (
    <ul className="check-list">
      {checks.map((c, i) => (
        <li key={i}>
          <Warn>
            <strong>{checkLabel(c.code)}</strong> ({c.doc === 'cv' ? 'CV' : 'Cover letter'}) {c.detail}
          </Warn>
        </li>
      ))}
    </ul>
  );
}

export function ReasonsPanel({ job, version }: { job: JobDetailJob; version: DocumentVersion }) {
  const { reasons, keywordCoverage, review, checks } = version;
  const hard = checks.filter((c) => c.severity === 'hard');
  const warnings = checks.filter((c) => c.severity === 'warning');
  return (
    <div className="reasons">
      {job.matchScore !== null && (
        <section className="panel" aria-label="Match">
          <h3>{job.matchScore}% match</h3>
          {job.matchExplanation && <p>{job.matchExplanation}</p>}
        </section>
      )}

      <section className="panel" aria-label="Keyword coverage">
        <h3>Keyword coverage</h3>
        <p className="label">Covered</p>
        {keywordCoverage.covered.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="tags">
            {keywordCoverage.covered.map((k) => (
              <li key={k}>
                <span aria-hidden="true">✓ </span>
                {k}
              </li>
            ))}
          </ul>
        )}
        <p className="label">Missing</p>
        {keywordCoverage.missing.length === 0 ? (
          <p className="muted">Nothing missing.</p>
        ) : (
          <ul className="plain">
            {keywordCoverage.missing.map((m) => (
              <li key={m.keyword}>
                <strong>{m.keyword}</strong>
                <br />
                <span className="muted">{m.why}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-label="Changes">
        <h3>What changed and why</h3>
        {reasons.changes.length === 0 ? (
          <p className="muted">No changes recorded.</p>
        ) : (
          <ul className="plain">
            {reasons.changes.map((c, i) => (
              <li key={i}>
                <span className="muted">{c.target}</span>
                <br />
                {c.what}
                <br />
                <span className="muted">{c.why}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {reasons.stretches.length > 0 && (
        <section className="panel" aria-label="Stretches">
          <h3>Stretches</h3>
          <ul className="plain">
            {reasons.stretches.map((s, i) => (
              <li key={i}>
                <span className="badge-stretch">Stretch — you decide</span>
                <br />
                {s.text}
                <br />
                <span className="muted">
                  {s.target}: {s.why}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel" aria-label="Reviewer">
        <h3>Reviewer</h3>
        <p>{review.passed ? 'Reviewer: passed' : 'Reviewer: not satisfied'}</p>
        <p className="muted">{review.rounds === 1 ? 'Took 1 round' : `Took ${review.rounds} rounds`}</p>
      </section>

      {review.unresolved.length > 0 && (
        <section className="panel attention" aria-label="Needs your attention">
          <h3>
            <Warn>Needs your attention</Warn>
          </h3>
          <ul className="check-list">
            {review.unresolved.map((u, i) => {
              const line = unresolvedLine(u);
              return (
                <li key={i}>
                  <Warn>
                    <strong>{line.label}</strong> {line.detail}
                  </Warn>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {hard.length > 0 && (
        <section className="panel attention" aria-label="Failed checks">
          <h3>Hard checks that failed</h3>
          <CheckList checks={hard} />
        </section>
      )}
      {warnings.length > 0 && (
        <section className="panel" aria-label="Check warnings">
          <h3>Warnings</h3>
          <CheckList checks={warnings} />
        </section>
      )}
      {hard.length === 0 && (
        <p className="muted">
          <span aria-hidden="true">✓ </span>All hard checks passed.
        </p>
      )}

      <p className="muted">This generation cost ${version.costUsd.toFixed(2)}</p>
    </div>
  );
}
