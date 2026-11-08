import type { TailoredCv, TailoredLetter } from '../api/types';

// Laid out like the Standard ATS template: same section order and headings as the downloads.
// `edited`: the paths Prayush edited by hand (found by their text); each gets a small "Your edit" marker.

const NONE: ReadonlySet<string> = new Set();

function Mark({ on }: { on: boolean }) {
  if (!on) return null;
  return (
    <span className="edit-mark" title="You edited this by hand">
      <span aria-hidden="true">✎ </span>Your edit
    </span>
  );
}
const under = (edited: ReadonlySet<string>, prefix: string) => [...edited].some((p) => p === prefix || p.startsWith(prefix + '.') || p.startsWith(prefix + '['));

function contactLine(cv: TailoredCv): string {
  return [cv.contact.location, cv.contact.email, cv.contact.phone, ...cv.contact.links.map((l) => `${l.label}: ${l.url}`)]
    .filter((p): p is string => !!p)
    .join(' | ');
}

export function CvPreview({ cv, edited = NONE }: { cv: TailoredCv; edited?: ReadonlySet<string> }) {
  const contact = contactLine(cv);
  return (
    <div className="paper" data-doc="cv">
      <h2 className="paper-name">{cv.name}</h2>
      {cv.headline && (
        <p>
          {cv.headline} <Mark on={edited.has('cv.headline')} />
        </p>
      )}
      {contact && (
        <p className="paper-contact">
          {contact} <Mark on={under(edited, 'cv.contact')} />
        </p>
      )}
      {cv.workRights && <p>{cv.workRights}</p>}

      {cv.summary.trim() !== '' && (
        <>
          <h3>Summary</h3>
          <p>
            {cv.summary} <Mark on={edited.has('cv.summary')} />
          </p>
        </>
      )}

      <h3>Skills</h3>
      {cv.skills.map((g, i) => (
        <p key={i}>
          <strong>{g.group}:</strong> {g.items.join(', ')} <Mark on={under(edited, `cv.skills[${i}]`)} />
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
              <li key={j}>
                {b} <Mark on={edited.has(`cv.experience[${i}].bullets[${j}]`)} />
              </li>
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
                  <li key={j}>
                    {b} <Mark on={edited.has(`cv.projects[${i}].bullets[${j}]`)} />
                  </li>
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

export function LetterPreview({ cv, letter, edited = NONE }: { cv: TailoredCv; letter: TailoredLetter; edited?: ReadonlySet<string> }) {
  const contact = contactLine(cv);
  return (
    <div className="paper" data-doc="cover_letter">
      <h2 className="paper-name">{cv.name}</h2>
      {contact && <p className="paper-contact">{contact}</p>}
      <p>
        {letter.date} <Mark on={edited.has('coverLetter.date')} />
      </p>
      {letter.addressee && (
        <p>
          {letter.addressee} <Mark on={edited.has('coverLetter.addressee')} />
        </p>
      )}
      <p>
        {letter.salutation} <Mark on={edited.has('coverLetter.salutation')} />
      </p>
      {letter.paragraphs.map((p, i) => (
        <p key={i}>
          {p} <Mark on={edited.has(`coverLetter.paragraphs[${i}]`)} />
        </p>
      ))}
      <p>
        {letter.signOff} <Mark on={edited.has('coverLetter.signOff')} />
      </p>
      <p>{letter.name}</p>
    </div>
  );
}
