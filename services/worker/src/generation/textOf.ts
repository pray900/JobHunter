import type { DocKind, TailoredCv, TailoredLetter } from './types.js';

// 'contact' = name and contact block; 'meta' = letter date, addressee, salutation, sign-off; 'body' = everything a reader weighs.
export type SegmentKind = 'contact' | 'meta' | 'body';
export interface Segment {
  doc: DocKind;
  where: string;
  text: string;
  kind: SegmentKind;
  // Which tailored-CV field a segment is, for the fact checks.
  field?: 'employer' | 'title' | 'dates';
}

export function cvSegments(cv: TailoredCv): Segment[] {
  const out: Segment[] = [];
  const add = (where: string, text: string | null | undefined, kind: SegmentKind = 'body', field?: Segment['field']) => {
    if (text && text.trim() !== '') out.push({ doc: 'cv', where, text, kind, field });
  };
  add('cv.name', cv.name, 'contact');
  add('cv.headline', cv.headline);
  add('cv.contact.location', cv.contact.location, 'contact');
  add('cv.contact.email', cv.contact.email, 'contact');
  add('cv.contact.phone', cv.contact.phone, 'contact');
  cv.contact.links.forEach((l, i) => add(`cv.contact.links[${i}]`, `${l.label} ${l.url}`, 'contact'));
  add('cv.workRights', cv.workRights);
  add('cv.summary', cv.summary);
  cv.skills.forEach((g, i) => {
    add(`cv.skills[${i}].group`, g.group);
    g.items.forEach((s, j) => add(`cv.skills[${i}].items[${j}]`, s));
  });
  (cv.competencies ?? []).forEach((c, i) => add(`cv.competencies[${i}]`, c));
  cv.experience.forEach((e, i) => {
    const p = `cv.experience[${i}]`;
    add(`${p}.title`, e.title, 'body', 'title');
    add(`${p}.employer`, e.employer, 'body', 'employer');
    add(`${p}.location`, e.location);
    add(`${p}.dates`, e.dates, 'body', 'dates');
    e.bullets.forEach((b, j) => add(`${p}.bullets[${j}]`, b));
    (e.achievements ?? []).forEach((a, j) => add(`${p}.achievements[${j}]`, a));
  });
  cv.education.forEach((e, i) => {
    const p = `cv.education[${i}]`;
    add(`${p}.qualification`, e.qualification);
    add(`${p}.institution`, e.institution);
    add(`${p}.dates`, e.dates, 'body', 'dates');
    add(`${p}.statusText`, e.statusText);
  });
  cv.projects.forEach((pr, i) => {
    add(`cv.projects[${i}].name`, pr.name);
    pr.bullets.forEach((b, j) => add(`cv.projects[${i}].bullets[${j}]`, b));
  });
  return out;
}

export function letterSegments(letter: TailoredLetter): Segment[] {
  const out: Segment[] = [];
  const add = (where: string, text: string, kind: SegmentKind) => {
    if (text.trim() !== '') out.push({ doc: 'cover_letter', where, text, kind });
  };
  add('coverLetter.date', letter.date, 'meta');
  add('coverLetter.addressee', letter.addressee, 'meta');
  add('coverLetter.salutation', letter.salutation, 'meta');
  letter.paragraphs.forEach((p, i) => add(`coverLetter.paragraphs[${i}]`, p, 'body'));
  add('coverLetter.signOff', letter.signOff, 'meta');
  add('coverLetter.name', letter.name, 'contact');
  return out;
}

// URLs and e-mail addresses are not prose: numbers, spelling and casing inside them are ignored.
export function stripLinks(text: string): string {
  return text
    .replace(/\b(?:https?:\/\/|mailto:|www\.)\S+/gi, ' ')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ' ')
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|au|co|app)(?:\/\S*)?/gi, ' ');
}

export const textOfSegments = (segments: Segment[]): string => segments.map((s) => s.text).join('\n');

// Every string and number anywhere in a structured value, so new fields are covered without changes here.
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (typeof value === 'number') out.push(String(value));
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}
