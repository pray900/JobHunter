import type { TailoredCv, TailoredLetter } from './types.js';

// Names the bad path only, never the value: document contents are not logged or echoed.
export class InvalidDocumentError extends Error {
  constructor(readonly path: string) {
    super(`invalid document at ${path}`);
    this.name = 'InvalidDocumentError';
  }
}

type Obj = Record<string, unknown>;

function obj(x: unknown, path: string): Obj {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new InvalidDocumentError(path);
  return x as Obj;
}
function str(x: unknown, path: string, opts: { allowEmpty?: boolean } = {}): string {
  if (typeof x !== 'string' || (!opts.allowEmpty && x.trim() === '')) throw new InvalidDocumentError(path);
  return x;
}
function strOrNull(x: unknown, path: string): string | null {
  if (x === null) return null;
  return str(x, path);
}
function arr(x: unknown, path: string): unknown[] {
  if (!Array.isArray(x)) throw new InvalidDocumentError(path);
  return x;
}
function strings(x: unknown, path: string): string[] {
  return arr(x, path).map((v, i) => str(v, `${path}[${i}]`));
}

export function validateTailoredCv(x: unknown): TailoredCv {
  const o = obj(x, 'cv');
  const contact = obj(o.contact, 'cv.contact');
  return {
    name: str(o.name, 'cv.name'),
    headline: str(o.headline, 'cv.headline', { allowEmpty: true }),
    contact: {
      location: strOrNull(contact.location, 'cv.contact.location'),
      email: strOrNull(contact.email, 'cv.contact.email'),
      phone: strOrNull(contact.phone, 'cv.contact.phone'),
      links: arr(contact.links, 'cv.contact.links').map((l, i) => {
        const link = obj(l, `cv.contact.links[${i}]`);
        return { label: str(link.label, `cv.contact.links[${i}].label`), url: str(link.url, `cv.contact.links[${i}].url`) };
      }),
    },
    summary: str(o.summary, 'cv.summary', { allowEmpty: true }),
    workRights: strOrNull(o.workRights, 'cv.workRights'),
    skills: arr(o.skills, 'cv.skills').map((g, i) => {
      const group = obj(g, `cv.skills[${i}]`);
      return { group: str(group.group, `cv.skills[${i}].group`), items: strings(group.items, `cv.skills[${i}].items`) };
    }),
    experience: arr(o.experience, 'cv.experience').map((e, i) => {
      const p = `cv.experience[${i}]`;
      const job = obj(e, p);
      return {
        title: str(job.title, `${p}.title`),
        employer: str(job.employer, `${p}.employer`),
        location: strOrNull(job.location, `${p}.location`),
        dates: str(job.dates, `${p}.dates`, { allowEmpty: true }),
        bullets: strings(job.bullets, `${p}.bullets`),
      };
    }),
    education: arr(o.education, 'cv.education').map((e, i) => {
      const p = `cv.education[${i}]`;
      const ed = obj(e, p);
      return {
        qualification: str(ed.qualification, `${p}.qualification`),
        institution: str(ed.institution, `${p}.institution`),
        dates: str(ed.dates, `${p}.dates`, { allowEmpty: true }),
        statusText: str(ed.statusText, `${p}.statusText`, { allowEmpty: true }),
      };
    }),
    projects: arr(o.projects, 'cv.projects').map((e, i) => {
      const p = `cv.projects[${i}]`;
      const pr = obj(e, p);
      return { name: str(pr.name, `${p}.name`), bullets: strings(pr.bullets, `${p}.bullets`) };
    }),
  };
}

export function validateTailoredLetter(x: unknown): TailoredLetter {
  const o = obj(x, 'coverLetter');
  return {
    date: str(o.date, 'coverLetter.date'),
    addressee: str(o.addressee, 'coverLetter.addressee', { allowEmpty: true }),
    salutation: str(o.salutation, 'coverLetter.salutation'),
    paragraphs: strings(o.paragraphs, 'coverLetter.paragraphs'),
    signOff: str(o.signOff, 'coverLetter.signOff'),
    name: str(o.name, 'coverLetter.name'),
  };
}
