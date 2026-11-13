import type { BaseCvFacts } from '../api/types';
import { RowTools, StringList, TextField, applyTool, replaceAt } from './FormParts';

type Education = BaseCvFacts['education'][number];
type Role = BaseCvFacts['roles'][number];
type Project = BaseCvFacts['projects'][number];

// Every fact of a base CV, editable. Blank list entries and blank optional fields are cleaned by the worker on save.
export function BaseCvForm(props: { facts: BaseCvFacts; onChange: (facts: BaseCvFacts) => void }) {
  const { facts: f, onChange } = props;
  const patch = (p: Partial<BaseCvFacts>) => onChange({ ...f, ...p });
  const patchContact = (p: Partial<BaseCvFacts['contact']>) => patch({ contact: { ...f.contact, ...p } });

  return (
    <div className="facts-form">
      <section aria-label="Details">
        <h3>Details</h3>
        <TextField label="Name" path="name" value={f.name} onChange={(v) => patch({ name: v })} />
        <TextField label="Headline" path="headline" value={f.headline} onChange={(v) => patch({ headline: v })} />
        <TextField label="Summary" path="summary" value={f.summary} area rows={5} onChange={(v) => patch({ summary: v })} />
        <TextField label="Work rights" path="workRights" value={f.workRights} onChange={(v) => patch({ workRights: v })} />
      </section>

      <section aria-label="Contact">
        <h3>Contact</h3>
        <div className="edit-grid">
          <TextField label="Location" path="contact.location" value={f.contact.location} onChange={(v) => patchContact({ location: v })} />
          <TextField label="Email" path="contact.email" value={f.contact.email} onChange={(v) => patchContact({ email: v })} />
          <TextField label="Phone" path="contact.phone" value={f.contact.phone} onChange={(v) => patchContact({ phone: v })} />
        </div>
        <h4>Links</h4>
        <StringList noun="Link" path="contact.links" items={f.contact.links} onChange={(links) => patchContact({ links })} />
      </section>

      <section aria-label="Education">
        <h3>Education</h3>
        {f.education.map((e, i) => {
          const set = (p: Partial<Education>) => patch({ education: replaceAt(f.education, i, { ...e, ...p }) });
          return (
            <div className="edit-card" key={i}>
              <div className="edit-grid">
                <TextField label={`Qualification ${i + 1}`} path={`education[${i}].qualification`} value={e.qualification} onChange={(v) => set({ qualification: v })} />
                <TextField label={`Institution ${i + 1}`} path={`education[${i}].institution`} value={e.institution} onChange={(v) => set({ institution: v })} />
                <TextField label={`Education dates ${i + 1}`} path={`education[${i}].dates`} value={e.dates} onChange={(v) => set({ dates: v })} />
                <TextField label={`Education status ${i + 1}`} path={`education[${i}].statusText`} value={e.statusText} onChange={(v) => set({ statusText: v })} />
              </div>
              <RowTools noun="qualification" i={i} count={f.education.length} onChange={(w) => patch({ education: applyTool(f.education, i, w) })} />
            </div>
          );
        })}
        <button type="button" className="btn btn-small" onClick={() => patch({ education: [...f.education, { qualification: '', institution: '', dates: '', statusText: '' }] })}>
          Add qualification
        </button>
      </section>

      <section aria-label="Roles">
        <h3>Roles</h3>
        {f.roles.map((r, i) => {
          const set = (p: Partial<Role>) => patch({ roles: replaceAt(f.roles, i, { ...r, ...p }) });
          return (
            <div className="edit-card" key={i}>
              <div className="edit-grid">
                <TextField label={`Role title ${i + 1}`} path={`roles[${i}].title`} value={r.title} onChange={(v) => set({ title: v })} />
                <TextField label={`Employer ${i + 1}`} path={`roles[${i}].employer`} value={r.employer} onChange={(v) => set({ employer: v })} />
                <TextField label={`Role dates ${i + 1}`} path={`roles[${i}].dates`} value={r.dates} onChange={(v) => set({ dates: v })} />
              </div>
              <StringList noun={`${r.title.trim() || `Role ${i + 1}`} bullet`} path={`roles[${i}].bullets`} items={r.bullets} onChange={(bullets) => set({ bullets })} />
              <RowTools noun="role" i={i} count={f.roles.length} onChange={(w) => patch({ roles: applyTool(f.roles, i, w) })} />
            </div>
          );
        })}
        <button type="button" className="btn btn-small" onClick={() => patch({ roles: [...f.roles, { title: '', employer: '', dates: '', bullets: [] }] })}>
          Add role
        </button>
      </section>

      <section aria-label="Projects">
        <h3>Projects</h3>
        {f.projects.map((p, i) => {
          const set = (q: Partial<Project>) => patch({ projects: replaceAt(f.projects, i, { ...p, ...q }) });
          return (
            <div className="edit-card" key={i}>
              <TextField label={`Project name ${i + 1}`} path={`projects[${i}].name`} value={p.name} onChange={(v) => set({ name: v })} />
              <StringList noun={`${p.name.trim() || `Project ${i + 1}`} bullet`} path={`projects[${i}].bullets`} items={p.bullets} onChange={(bullets) => set({ bullets })} />
              <RowTools noun="project" i={i} count={f.projects.length} onChange={(w) => patch({ projects: applyTool(f.projects, i, w) })} />
            </div>
          );
        })}
        <button type="button" className="btn btn-small" onClick={() => patch({ projects: [...f.projects, { name: '', bullets: [] }] })}>
          Add project
        </button>
      </section>

      <section aria-label="Skills">
        <h3>Skills</h3>
        <StringList noun="Skill" path="skills" items={f.skills} onChange={(skills) => patch({ skills })} />
      </section>

      <section aria-label="Metrics">
        <h3>Metrics</h3>
        <StringList noun="Metric" path="metrics" items={f.metrics} onChange={(metrics) => patch({ metrics })} />
      </section>
    </div>
  );
}
