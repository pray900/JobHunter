import type { BaseCoverLetterFacts, BaseCvFacts } from '../api/types';

// Once edited the facts are the user's own, so an empty value is "None", not "Not found in the file".
function Value({ v, edited }: { v: string | null; edited: boolean }) {
  return v && v.trim() ? <>{v}</> : <span className="muted">{edited ? 'None' : 'Not found in the file'}</span>;
}

function Row({ label, value, edited }: { label: string; value: string | null; edited: boolean }) {
  return (
    <div className="facts-row">
      <dt>{label}</dt>
      <dd>
        <Value v={value} edited={edited} />
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

function CvFactsView({ f, edited }: { f: BaseCvFacts; edited: boolean }) {
  return (
    <>
      <section aria-label="Details">
        <dl className="facts-dl">
          <Row label="Name" value={f.name} edited={edited} />
          <Row label="Headline" value={f.headline} edited={edited} />
          <Row label="Summary" value={f.summary} edited={edited} />
          <Row label="Work rights" value={f.workRights} edited={edited} />
        </dl>
      </section>
      <section aria-label="Contact">
        <h3>Contact</h3>
        <dl className="facts-dl">
          <Row label="Location" value={f.contact.location} edited={edited} />
          <Row label="Email" value={f.contact.email} edited={edited} />
          <Row label="Phone" value={f.contact.phone} edited={edited} />
        </dl>
        <Bullets items={f.contact.links} />
      </section>
      <section aria-label="Education">
        <h3>Education</h3>
        {f.education.length === 0 && <p className="muted">{edited ? 'None' : 'None found'}</p>}
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
        {f.roles.length === 0 && <p className="muted">{edited ? 'None' : 'None found'}</p>}
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
        {f.projects.length === 0 && <p className="muted">{edited ? 'None' : 'None found'}</p>}
        {f.projects.map((p, i) => (
          <div key={i} className="facts-item">
            <strong>{p.name}</strong>
            <Bullets items={p.bullets} />
          </div>
        ))}
      </section>
      <section aria-label="Skills">
        <h3>Skills</h3>
        {f.skills.length === 0 ? <p className="muted">{edited ? 'None' : 'None found'}</p> : <p>{f.skills.join(', ')}</p>}
      </section>
      <section aria-label="Metrics">
        <h3>Metrics</h3>
        {f.metrics.length === 0 ? <p className="muted">{edited ? 'None' : 'None found'}</p> : <Bullets items={f.metrics} />}
      </section>
    </>
  );
}

function LetterFactsView({ f, edited }: { f: BaseCoverLetterFacts; edited: boolean }) {
  return (
    <>
      <section aria-label="Previous target">
        <h3>Who this letter was written for</h3>
        <dl className="facts-dl">
          <Row label="Company" value={f.previousTarget.company} edited={edited} />
          <Row label="Addressee" value={f.previousTarget.addressee} edited={edited} />
          <Row label="Role" value={f.previousTarget.role} edited={edited} />
        </dl>
      </section>
      <section aria-label="Paragraphs">
        <h3>Paragraphs</h3>
        {f.reusableParagraphs.length === 0 && <p className="muted">{edited ? 'None' : 'None found'}</p>}
        {f.reusableParagraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </section>
      <section aria-label="Tone">
        <h3>Tone</h3>
        <p>{f.toneNotes.trim() ? f.toneNotes : <span className="muted">{edited ? 'None' : 'None found'}</span>}</p>
      </section>
    </>
  );
}

export function FactsView({ kind, facts, edited = false }: { kind: 'cv' | 'cover_letter'; facts: BaseCvFacts | BaseCoverLetterFacts; edited?: boolean }) {
  return (
    <div className="facts-view">
      {kind === 'cv' ? <CvFactsView f={facts as BaseCvFacts} edited={edited} /> : <LetterFactsView f={facts as BaseCoverLetterFacts} edited={edited} />}
    </div>
  );
}
