import type { DocumentWarning } from '../api/types';

export function documentWarningText(w: DocumentWarning): string {
  switch (w.code) {
    case 'missing_work_rights':
      return 'No work-rights line (e.g. "Full working rights (485 visa)")';
    case 'degree_status_unclear':
      return 'Degree status unclear — say e.g. "(conferral Nov 2026)"';
    case 'banned_phrase':
      return `Phrase that reads as AI or cliché: ${w.detail}`;
    case 'unreadable_file':
      return "Couldn't read this file";
    default:
      // Any code added later: the API's own detail text.
      return w.detail;
  }
}

export function uploadErrorText(status: number): string {
  if (status === 400 || status === 413) return "That file can't be used. Upload a PDF or Word file under 5 MB.";
  return "Couldn't upload that file. Try again.";
}

const LIST_LIMIT = 'a list can have at most 100 items and each entry at most 4000 characters';
const LIST_NAMES: Record<string, string> = {
  'contact.links': 'Links',
  education: 'Education',
  roles: 'Roles',
  projects: 'Projects',
  skills: 'Skills',
  metrics: 'Metrics',
  reusableParagraphs: 'Paragraphs',
};
const FIELD_NAMES: Record<string, string> = {
  name: 'Name',
  headline: 'Headline',
  summary: 'Summary',
  workRights: 'Work rights',
  'contact.location': 'Location',
  'contact.email': 'Email',
  'contact.phone': 'Phone',
  'previousTarget.company': 'Company',
  'previousTarget.addressee': 'Addressee',
  'previousTarget.role': 'Role',
  toneNotes: 'Tone notes',
};
const ROW_FIELDS: Record<string, Record<string, string>> = {
  education: { qualification: 'Qualification', institution: 'Institution', dates: 'Education dates', statusText: 'Education status' },
  roles: { title: 'Role title', employer: 'Employer', dates: 'Role dates' },
  projects: { name: 'Project name' },
};
const ENTRY_NAMES: Record<string, string> = {
  'contact.links': 'Link',
  skills: 'Skill',
  metrics: 'Metric',
  reusableParagraphs: 'Paragraph',
};

// Words for a worker error path (without the leading "facts."), or null when no field matches.
export function invalidFieldText(path: string | null): string | null {
  if (!path) return null;
  const list = LIST_NAMES[path];
  if (list) return `${list} isn't valid: ${LIST_LIMIT}.`;
  const field = FIELD_NAMES[path];
  if (field) return `${field} isn't valid.`;
  let m = /^(contact\.links|skills|metrics|reusableParagraphs)\[(\d+)\]$/.exec(path);
  if (m) return `${ENTRY_NAMES[m[1]!]} ${Number(m[2]) + 1} isn't valid.`;
  m = /^(education|roles|projects)\[(\d+)\]\.(\w+)$/.exec(path);
  const label = m && ROW_FIELDS[m[1]!]?.[m[3]!];
  if (m && label) return `${label} ${Number(m[2]) + 1} isn't valid.`;
  m = /^(roles|projects)\[(\d+)\]\.bullets$/.exec(path);
  if (m) return `Bullets of ${m[1] === 'roles' ? 'role' : 'project'} ${Number(m[2]) + 1} isn't valid: ${LIST_LIMIT}.`;
  m = /^(roles|projects)\[(\d+)\]\.bullets\[(\d+)\]$/.exec(path);
  if (m) return `Bullet ${Number(m[3]) + 1} of ${m[1] === 'roles' ? 'role' : 'project'} ${Number(m[2]) + 1} isn't valid.`;
  return null;
}
