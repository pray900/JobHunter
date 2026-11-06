export type DocumentKind = 'cv' | 'cover_letter';

export const DOCUMENT_KINDS: readonly DocumentKind[] = ['cv', 'cover_letter'];

export const PDF_MEDIA_TYPE = 'application/pdf';
export const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface ScannedDocument {
  kind: DocumentKind;
  sourceRef: string;
  contentHash: string;
  // ISO time the file was last modified. Per kind, the newest readable file is the one used.
  modifiedAt: string;
  mediaType: typeof PDF_MEDIA_TYPE | typeof DOCX_MEDIA_TYPE;
  pdfBase64: string | null;
  text: string | null;
  warnings: 'unreadable_file'[];
}

// Analysis output for a base CV. Task 4's JSON schema mirrors this shape.
export interface BaseCvFacts {
  headline: string | null;
  summary: string | null;
  workRights: string | null;
  education: { qualification: string; institution: string; dates: string; statusText: string }[];
  roles: { title: string; employer: string; dates: string; bullets: string[] }[];
  projects: { name: string; bullets: string[] }[];
  skills: string[];
  metrics: string[];
  contact: { location: string | null; email: string | null; phone: string | null; links: string[] };
}

// Analysis output for a base cover letter.
export interface BaseCoverLetterFacts {
  previousTarget: { company: string | null; addressee: string | null; role: string | null };
  reusableParagraphs: string[];
  toneNotes: string;
}

export type DocWarningCode = 'missing_work_rights' | 'degree_status_unclear' | 'banned_phrase';

export interface DocWarning {
  code: DocWarningCode;
  detail: string;
}
