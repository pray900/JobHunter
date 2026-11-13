import type { BaseCoverLetterFacts, BaseCvFacts } from '../api/types';

function Value({ v }: { v: string | null }) {
  return v && v.trim() ? <>{v}</> : <span className="muted">Not found in the file</span>;
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="facts-row">
      <dt>{label}</dt>
      <dd>
        <Value v={value} />
      </dd>
    </div>
  );
}

function Bullets({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul>
      {items.map((b, i) => (
        <li key={i}>{b}</li>
      ))}
    </ul>
  );
}

function CvFactsView({ f }: { f: BaseCvFacts }) {
  return (
    <>
      <section aria-label="Details">
        <dl className="facts-dl">
          <Row label="Name" value={f.name} />
          <Row label="Headline" value={f.headline} />
          <Row label="Summary" value={f.summary} />
          <Row label="Work rights" value={f.workRights} />
        </dl>
      </section>
      <section aria-label="Contact">
        <h3>Contact</h3>
        <dl className="facts-dl">
          <Row label="Location" value={f.contact.location} />
          <Row label="Email" value={f.contact.email} />
          <Row label="Phone" value={f.contact.phone} />
        </dl>
        <Bullets items={f.contact.links} />
      </section>
      <section aria-label="Education">
        <h3>Education</h3>
        {f.education.length === 0 && <p className="muted">None found</p>}
        {f.education.map((e, i) => (
          <p key={i} className="facts-item">
            <strong>{e.qualification}</strong>
            <br />
            <span className="muted">{[e.institution, e.dates, e.statusText].filter(Boolean).join(', ')}</span>
          </p>
        ))}
      </section>
      <section aria-label="Roles">
        <h3>Roles</h3>
        {f.roles.length === 0 && <p className="muted">None found</p>}
        {f.roles.map((r, i) => (
          <div key={i} className="facts-item">
            <strong>{r.title}</strong>
            <br />
            <span className="muted">{[r.employer, r.dates].filter(Boolean).join(', ')}</span>
            <Bullets items={r.bullets} />
          </div>
        ))}
      </section>
      <section aria-label="Projects">
        <h3>Projects</h3>
        {f.projects.length === 0 && <p className="muted">None found</p>}
        {f.projects.map((p, i) => (
          <div key={i} className="facts-item">
            <strong>{p.name}</strong>
            <Bullets items={p.bullets} />
          </div>
        ))}
      </section>
      <section aria-label="Skills">
        <h3>Skills</h3>
        {f.skills.length === 0 ? <p className="muted">None found</p> : <p>{f.skills.join(', ')}</p>}
      </section>
      <section aria-label="Metrics">
        <h3>Metrics</h3>
        {f.metrics.length === 0 ? <p className="muted">None found</p> : <Bullets items={f.metrics} />}
      </section>
    </>
  );
}

function LetterFactsView({ f }: { f: BaseCoverLetterFacts }) {
  return (
    <>
      <section aria-label="Previous target">
        <h3>Who this letter was written for</h3>
        <dl className="facts-dl">
          <Row label="Company" value={f.previousTarget.company} />
          <Row label="Addressee" value={f.previousTarget.addressee} />
          <Row label="Role" value={f.previousTarget.role} />
        </dl>
      </section>
      <section aria-label="Paragraphs">
        <h3>Paragraphs</h3>
        {f.reusableParagraphs.length === 0 && <p className="muted">None found</p>}
        {f.reusableParagraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </section>
      <section aria-label="Tone">
        <h3>Tone</h3>
        <p>{f.toneNotes.trim() ? f.toneNotes : <span className="muted">None found</span>}</p>
      </section>
    </>
  );
}

export function FactsView({ kind, facts }: { kind: 'cv' | 'cover_letter'; facts: BaseCvFacts | BaseCoverLetterFacts }) {
  return (
    <div className="facts-view">
      {kind === 'cv' ? <CvFactsView f={facts as BaseCvFacts} /> : <LetterFactsView f={facts as BaseCoverLetterFacts} />}
    </div>
  );
}
