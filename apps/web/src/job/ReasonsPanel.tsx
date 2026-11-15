import type { CheckResult, DocumentVersion, JobDetailJob, UnresolvedItem } from '../api/types';
import { LOCKED_NOTE, checkLabel, reviewItemLabel } from './labels';

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

// Where a selection criterion is answered, in the words of the document's headings; null for a path it does not know.
function describeAnswer(path: string): string | null {
  if (path === 'coverLetter') return 'Cover letter';
  if (path === 'cv.summary') return 'Professional summary';
  let m = /^cv\.competencies\[(\d+)\]$/.exec(path);
  if (m) return `Key Skills & Competencies — competency ${Number(m[1]) + 1}`;
  m = /^cv\.experience\[(\d+)\]\.bullets\[\d+\]$/.exec(path);
  if (m) return `Responsibilities — role ${Number(m[1]) + 1}`;
  m = /^cv\.experience\[(\d+)\]\.achievements\[\d+\]$/.exec(path);
  if (m) return `Key Achievements — role ${Number(m[1]) + 1}`;
  return null;
}

// True when the text at the path is gone or blank in this version (an edit of his removed it).
function answerGone(path: string, v: DocumentVersion): boolean {
  const { cv, coverLetter } = v;
  let text: string | undefined;
  let m: RegExpExecArray | null;
  if (path === 'coverLetter') text = coverLetter.paragraphs.join(' ');
  else if (path === 'cv.summary') text = cv.summary;
  else if ((m = /^cv\.competencies\[(\d+)\]$/.exec(path))) text = cv.competencies?.[Number(m[1])];
  else if ((m = /^cv\.experience\[(\d+)\]\.(bullets|achievements)\[(\d+)\]$/.exec(path)))
    text = cv.experience[Number(m[1])]?.[m[2] as 'bullets' | 'achievements']?.[Number(m[3])];
  else return false;
  return text === undefined || text.trim() === '';
}

function SelectionCriteria({ version }: { version: DocumentVersion }) {
  const list = version.reasons.criteriaCoverage;
  if (!list || list.length === 0) return null;
  return (
    <section className="panel" aria-label="Selection criteria">
      <h3>Selection criteria</h3>
      <ul className="plain">
        {list.map((c, i) => {
          const unanswered = c.answeredIn === '';
          const gone = !unanswered && answerGone(c.answeredIn, version);
          return (
            <li key={i} className={unanswered || gone ? 'attention-text' : undefined}>
              <strong>{c.criterion}</strong>
              <br />
              {unanswered ? (
                <Warn>
                  Not answered — {c.why}
                </Warn>
              ) : gone ? (
                <Warn>
                  Not answered (removed by your edit)
                </Warn>
              ) : (
                <span className="muted">
                  <span aria-hidden="true">✓ </span>
                  {describeAnswer(c.answeredIn) ?? c.answeredIn}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function unresolvedLine(u: UnresolvedItem): { label: string; detail: string } {
  switch (u.source) {
    case 'check':
      if (u.locked || u.note === LOCKED_NOTE) return { label: `${LOCKED_NOTE}:`, detail: `${checkLabel(u.code)}. ${u.detail}` };
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
            {c.locked && <span className="muted"> {LOCKED_NOTE}</span>}
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
  // An edited version (or a restored copy of one) carries the review of an earlier version, which did not see
  // the edits: its verdict and its list are shown as that version's, and review checks are his to look at.
  const reviewedNo = review.reviewedVersionNo;
  const edited = reviewedNo !== undefined;
  const toLook = edited ? checks.filter((c) => c.severity === 'review') : [];
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

      <SelectionCriteria version={version} />

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

      {reasons.fit && reasons.fit.droppedProjects.length > 0 && (
        <section className="panel" aria-label="Fit to one page">
          <h3>Fit to one page</h3>
          <ul className="plain">
            {reasons.fit.droppedProjects.map((p) => (
              <li key={p} className="muted">
                <span aria-hidden="true">ⓘ</span> Left out to fit one page: {p}
              </li>
            ))}
          </ul>
        </section>
      )}

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
        {edited ? (
          <p className="muted">
            Not reviewed: your edits came after the review (version {reviewedNo} was: {review.passed ? 'passed' : 'not satisfied'})
          </p>
        ) : review.passed ? (
          <p>
            <span aria-hidden="true">✓ </span>Reviewer: passed
          </p>
        ) : (
          <p className="attention-text">
            <Warn>Reviewer: not satisfied</Warn>
          </p>
        )}
        <p className="muted">{review.rounds === 1 ? 'Took 1 round' : `Took ${review.rounds} rounds`}</p>
      </section>

      {reasons.factRulings.length > 0 && (
        <section className="panel" aria-label="Reworded skills the reviewer accepted">
          <h3>Reworded skills the reviewer accepted</h3>
          <p className="muted">Skills written differently from your base CV, and the reviewer's ruling on each. Check you could defend them in an interview.</p>
          <ul className="plain">
            {reasons.factRulings.map((f, i) =>
              f.ruling === 'invented' ? (
                <li key={i} className="attention-text">
                  <Warn>
                    <strong>{f.text}</strong> <span className="badge-stretch">Invented</span>
                    <br />
                    {f.why}
                  </Warn>
                </li>
              ) : (
                <li key={i}>
                  <strong>{f.text}</strong> <span className="badge">Honest rephrase</span>
                  <br />
                  <span className="muted">{f.why}</span>
                </li>
              ),
            )}
          </ul>
        </section>
      )}

      {toLook.length > 0 && (
        <section className="panel attention" aria-label="Needs a look">
          <h3>
            <Warn>Needs a look</Warn>
          </h3>
          <p>The reviewer did not see your edit. Check these yourself.</p>
          <CheckList checks={toLook} />
        </section>
      )}

      {edited && review.unresolved.length > 0 && (
        <section className="panel" aria-label={`From the review of version ${reviewedNo}`}>
          <h3>From the review of version {reviewedNo}</h3>
          <p className="muted">Written before your edits; some may no longer apply.</p>
          <ul className="plain">
            {review.unresolved.map((u, i) => {
              const line = unresolvedLine(u);
              return (
                <li key={i}>
                  <strong>{line.label}</strong> {line.detail}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {!edited && review.unresolved.length > 0 && (
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

      <p className="muted">
        {version.origin === 'edited'
          ? 'No cost (your edit)'
          : version.origin === 'restored'
            ? 'Restored copy (no new cost)'
            : `This generation cost US$${version.costUsd.toFixed(2)}`}
      </p>
    </div>
  );
}
