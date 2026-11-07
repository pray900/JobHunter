import type { TailoredCv, TailoredLetter } from '../api/types';

// Laid out like the Standard ATS template: same section order and headings as the downloads.

function contactLine(cv: TailoredCv): string {
  return [cv.contact.location, cv.contact.email, cv.contact.phone, ...cv.contact.links.map((l) => `${l.label}: ${l.url}`)]
    .filter((p): p is string => !!p)
    .join(' | ');
}

export function CvPreview({ cv }: { cv: TailoredCv }) {
  const contact = contactLine(cv);
  return (
    <div className="paper" data-doc="cv">
      <h2 className="paper-name">{cv.name}</h2>
      {cv.headline && <p>{cv.headline}</p>}
      {contact && <p className="paper-contact">{contact}</p>}
      {cv.workRights && <p>{cv.workRights}</p>}

      {cv.summary.trim() !== '' && (
        <>
          <h3>Summary</h3>
          <p>{cv.summary}</p>
        </>
      )}

      <h3>Skills</h3>
      {cv.skills.map((g, i) => (
        <p key={i}>
          <strong>{g.group}:</strong> {g.items.join(', ')}
        </p>
      ))}

      <h3>Experience</h3>
      {cv.experience.map((job, i) => (
        <div key={i} className="paper-entry">
          <p className="paper-line">
            <strong>{[job.title, job.employer, job.location].filter(Boolean).join(', ')}</strong>
            <span>{job.dates}</span>
          </p>
          <ul>
            {job.bullets.map((b, j) => (
              <li key={j}>{b}</li>
            ))}
          </ul>
        </div>
      ))}

      {cv.projects.length > 0 && (
        <>
          <h3>Projects</h3>
          {cv.projects.map((p, i) => (
            <div key={i} className="paper-entry">
              <p>
                <strong>{p.name}</strong>
              </p>
              <ul>
                {p.bullets.map((b, j) => (
                  <li key={j}>{b}</li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}

      <h3>Education</h3>
      {cv.education.map((e, i) => (
        <div key={i} className="paper-entry">
          <p className="paper-line">
            <strong>{[e.qualification, e.institution].filter((p) => p.trim() !== '').join(', ')}</strong>
            <span>{e.dates}</span>
          </p>
          {e.statusText && <p>{e.statusText}</p>}
        </div>
      ))}
    </div>
  );
}

export function LetterPreview({ cv, letter }: { cv: TailoredCv; letter: TailoredLetter }) {
  const contact = contactLine(cv);
  return (
    <div className="paper" data-doc="cover_letter">
      <h2 className="paper-name">{cv.name}</h2>
      {contact && <p className="paper-contact">{contact}</p>}
      <p>{letter.date}</p>
      {letter.addressee && <p>{letter.addressee}</p>}
      <p>{letter.salutation}</p>
      {letter.paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      <p>{letter.signOff}</p>
      <p>{letter.name}</p>
    </div>
  );
}
