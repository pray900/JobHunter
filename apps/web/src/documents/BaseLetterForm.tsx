import type { BaseCoverLetterFacts } from '../api/types';
import { StringList, TextField } from '../forms/listEditing';

export function BaseLetterForm(props: { facts: BaseCoverLetterFacts; onChange: (facts: BaseCoverLetterFacts) => void }) {
  const { facts: f, onChange } = props;
  const patchTarget = (p: Partial<BaseCoverLetterFacts['previousTarget']>) => onChange({ ...f, previousTarget: { ...f.previousTarget, ...p } });

  return (
    <div className="facts-form">
      <section aria-label="Previous target">
        <h3>Who this letter was written for</h3>
        <div className="edit-grid">
          <TextField label="Company" path="previousTarget.company" value={f.previousTarget.company} onChange={(v) => patchTarget({ company: v })} />
          <TextField label="Addressee" path="previousTarget.addressee" value={f.previousTarget.addressee} onChange={(v) => patchTarget({ addressee: v })} />
          <TextField label="Role" path="previousTarget.role" value={f.previousTarget.role} onChange={(v) => patchTarget({ role: v })} />
        </div>
      </section>
      <section aria-label="Paragraphs">
        <h3>Paragraphs</h3>
        <StringList noun="Paragraph" path="reusableParagraphs" multiline items={f.reusableParagraphs} onChange={(reusableParagraphs) => onChange({ ...f, reusableParagraphs })} />
      </section>
      <section aria-label="Tone">
        <h3>Tone</h3>
        <TextField label="Tone notes" path="toneNotes" value={f.toneNotes} area rows={3} onChange={(toneNotes) => onChange({ ...f, toneNotes })} />
      </section>
    </div>
  );
}
