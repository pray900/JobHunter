import { useEffect, useState } from 'react';
import type { TailoredCv, TailoredLetter } from '../api/types';
import { RowTools, StringList, applyTool, replaceAt } from '../forms/listEditing';
import { ConfirmDialog } from './ConfirmDialog';

const COPIED_NOTE = 'Copied from your base CV — change it there';

function Text(props: { label: string; value: string | null; onChange?: (v: string) => void; area?: boolean; rows?: number }) {
  const { label, value, onChange, area, rows } = props;
  const readOnly = !onChange;
  const common = {
    readOnly,
    value: value ?? '',
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange?.(e.target.value),
  };
  return (
    <label className="edit-field">
      <span className="label">{label}</span>
      {area ? <textarea {...common} rows={rows ?? 4} /> : <input type="text" {...common} />}
    </label>
  );
}

// Drops blank list entries and turns empty contact fields into null (the API stores them as null).
function cleanCv(cv: TailoredCv): TailoredCv {
  const nul = (v: string | null) => (v === null || v.trim() === '' ? null : v);
  const keep = (list: string[]) => list.filter((s) => s.trim() !== '');
  return {
    ...cv,
    contact: {
      location: nul(cv.contact.location),
      email: nul(cv.contact.email),
      phone: nul(cv.contact.phone),
      links: cv.contact.links.filter((l) => l.label.trim() !== '' || l.url.trim() !== ''),
    },
    skills: cv.skills.map((g) => ({ ...g, items: keep(g.items) })).filter((g) => g.group.trim() !== '' || g.items.length > 0),
    experience: cv.experience.map((e) => ({ ...e, bullets: keep(e.bullets) })),
    projects: cv.projects.map((p) => ({ ...p, bullets: keep(p.bullets) })),
  };
}

const cleanLetter = (l: TailoredLetter): TailoredLetter => ({ ...l, paragraphs: l.paragraphs.filter((p) => p.trim() !== '') });

export function DocumentEditor(props: {
  cv: TailoredCv;
  letter: TailoredLetter;
  saving: boolean;
  error: string | null;
  onSave: (cv: TailoredCv, letter: TailoredLetter) => void;
  onCancel: () => void;
  // Told whenever the editor starts or stops holding unsaved changes (the page guards leaving).
  onDirtyChange?: (dirty: boolean) => void;
  // A status line shown at the top of the editor (a run finished while editing).
  notice?: string | null;
}) {
  const { saving, error, onSave, onCancel, onDirtyChange, notice } = props;
  const [cv, setCv] = useState(props.cv);
  const [letter, setLetter] = useState(props.letter);
  const [confirming, setConfirming] = useState(false);
  const dirty = JSON.stringify(cv) !== JSON.stringify(props.cv) || JSON.stringify(letter) !== JSON.stringify(props.letter);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const patchCv = (p: Partial<TailoredCv>) => setCv((c) => ({ ...c, ...p }));
  const patchContact = (p: Partial<TailoredCv['contact']>) => setCv((c) => ({ ...c, contact: { ...c.contact, ...p } }));
  const patchLetter = (p: Partial<TailoredLetter>) => setLetter((l) => ({ ...l, ...p }));

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Nothing changed: nothing to save (a save would only add a copy that is no longer "reviewed").
    if (!dirty || saving) return;
    onSave(cleanCv(cv), cleanLetter(letter));
  }

  return (
    <form className="editor" onSubmit={onSubmit} aria-label="Edit documents">
      {notice && (
        <p className="editor-notice" role="status" aria-label="A new version finished">
          <span aria-hidden="true">ℹ </span>
          {notice}
        </p>
      )}
      <section aria-label="CV details">
        <h3>CV</h3>
        <Text label="Name" value={cv.name} />
        <Text label="Work rights" value={cv.workRights} />
        <p className="muted copied-note">{COPIED_NOTE}</p>
        <Text label="Headline" value={cv.headline} onChange={(v) => patchCv({ headline: v })} />
        <Text label="Summary" value={cv.summary} area rows={5} onChange={(v) => patchCv({ summary: v })} />
        <Text label="Location" value={cv.contact.location} onChange={(v) => patchContact({ location: v })} />
        <Text label="Email" value={cv.contact.email} onChange={(v) => patchContact({ email: v })} />
        <Text label="Phone" value={cv.contact.phone} onChange={(v) => patchContact({ phone: v })} />

        <h4>Links</h4>
        <div className="edit-list">
          {cv.contact.links.map((l, i) => (
            <div className="edit-row" key={i}>
              <input
                type="text"
                aria-label={`Link label ${i + 1}`}
                value={l.label}
                onChange={(e) => patchContact({ links: replaceAt(cv.contact.links, i, { ...l, label: e.target.value }) })}
              />
              <input
                type="text"
                aria-label={`Link URL ${i + 1}`}
                value={l.url}
                onChange={(e) => patchContact({ links: replaceAt(cv.contact.links, i, { ...l, url: e.target.value }) })}
              />
              <RowTools noun="link" i={i} count={cv.contact.links.length} onChange={(w) => patchContact({ links: applyTool(cv.contact.links, i, w) })} />
            </div>
          ))}
          <button type="button" className="btn btn-small" onClick={() => patchContact({ links: [...cv.contact.links, { label: '', url: '' }] })}>
            Add link
          </button>
        </div>

        <h4>Skills</h4>
        {cv.skills.map((g, i) => {
          const name = g.group.trim() || `Skill group ${i + 1}`;
          return (
            <div className="edit-card" key={i}>
              <div className="edit-row">
                <input
                  type="text"
                  aria-label={`Skill group name ${i + 1}`}
                  value={g.group}
                  onChange={(e) => patchCv({ skills: replaceAt(cv.skills, i, { ...g, group: e.target.value }) })}
                />
                <RowTools noun="skill group" i={i} count={cv.skills.length} onChange={(w) => patchCv({ skills: applyTool(cv.skills, i, w) })} />
              </div>
              <StringList noun={`${name} item`} items={g.items} onChange={(items) => patchCv({ skills: replaceAt(cv.skills, i, { ...g, items }) })} />
            </div>
          );
        })}
        <button type="button" className="btn btn-small" onClick={() => patchCv({ skills: [...cv.skills, { group: '', items: [] }] })}>
          Add skill group
        </button>

        <h4>Experience</h4>
        <p className="muted copied-note">{COPIED_NOTE}</p>
        {cv.experience.map((job, i) => (
          <div className="edit-card" key={i}>
            <div className="edit-grid">
              <Text label={`Role title ${i + 1}`} value={job.title} />
              <Text label={`Employer ${i + 1}`} value={job.employer} />
              <Text label={`Role location ${i + 1}`} value={job.location} />
              <Text label={`Role dates ${i + 1}`} value={job.dates} />
            </div>
            <StringList
              noun={`${job.title} bullet`}
              items={job.bullets}
              onChange={(bullets) => patchCv({ experience: replaceAt(cv.experience, i, { ...job, bullets }) })}
            />
          </div>
        ))}

        {cv.projects.length > 0 && (
          <>
            <h4>Projects</h4>
            {cv.projects.map((p, i) => (
              <div className="edit-card" key={i}>
                <Text label={`Project name ${i + 1}`} value={p.name} />
                <StringList noun={`${p.name} bullet`} items={p.bullets} onChange={(bullets) => patchCv({ projects: replaceAt(cv.projects, i, { ...p, bullets }) })} />
              </div>
            ))}
          </>
        )}

        <h4>Education</h4>
        <p className="muted copied-note">{COPIED_NOTE}</p>
        {cv.education.map((e, i) => (
          <div className="edit-card edit-grid" key={i}>
            <Text label={`Qualification ${i + 1}`} value={e.qualification} />
            <Text label={`Institution ${i + 1}`} value={e.institution} />
            <Text label={`Education dates ${i + 1}`} value={e.dates} />
            <Text label={`Education status ${i + 1}`} value={e.statusText} />
          </div>
        ))}
      </section>

      <section aria-label="Cover letter details">
        <h3>Cover letter</h3>
        <Text label="Signature name" value={letter.name} />
        <p className="muted copied-note">{COPIED_NOTE}</p>
        <Text label="Date" value={letter.date} onChange={(v) => patchLetter({ date: v })} />
        <Text label="Addressee" value={letter.addressee} onChange={(v) => patchLetter({ addressee: v })} />
        <Text label="Salutation" value={letter.salutation} onChange={(v) => patchLetter({ salutation: v })} />
        <StringList noun="Paragraph" multiline items={letter.paragraphs} onChange={(paragraphs) => patchLetter({ paragraphs })} />
        <Text label="Sign-off" value={letter.signOff} onChange={(v) => patchLetter({ signOff: v })} />
      </section>

      {error && (
        <p className="error attention" role="alert">
          <span aria-hidden="true">⚠ </span>
          {error}
        </p>
      )}
      <div className="editor-actions">
        <button type="submit" className="btn btn-primary" disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" disabled={saving} onClick={() => (dirty ? setConfirming(true) : onCancel())}>
          Cancel
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          message="Discard your changes?"
          confirmLabel="Discard changes"
          cancelLabel="Keep editing"
          onConfirm={() => {
            setConfirming(false);
            onCancel();
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </form>
  );
}
