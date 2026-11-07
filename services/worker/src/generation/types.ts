export interface TailoredCv {
  name: string;
  headline: string;
  contact: {
    location: string | null;
    email: string | null;
    phone: string | null;
    links: { label: string; url: string }[];
  };
  summary: string;
  workRights: string | null;
  skills: { group: string; items: string[] }[];
  experience: { title: string; employer: string; location: string | null; dates: string; bullets: string[] }[];
  education: { qualification: string; institution: string; dates: string; statusText: string }[];
  projects: { name: string; bullets: string[] }[];
}

// The contact block comes from the CV's `contact`, so both documents match.
export interface TailoredLetter {
  date: string;
  addressee: string;
  salutation: string;
  paragraphs: string[];
  signOff: string;
  name: string;
}

export type TemplateId = 'standard-ats';
export type DocKind = 'cv' | 'cover_letter';
export type RenderFormat = 'docx' | 'pdf';

export const TEMPLATE_IDS: readonly TemplateId[] = ['standard-ats'];
export const DOC_KINDS: readonly DocKind[] = ['cv', 'cover_letter'];
export const RENDER_FORMATS: readonly RenderFormat[] = ['docx', 'pdf'];
