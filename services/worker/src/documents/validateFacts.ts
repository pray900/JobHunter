import type { BaseCoverLetterFacts, BaseCvFacts, DocumentKind } from './types.js';

export const MAX_FACTS_BYTES = 200 * 1024;
const MAX_STRING = 4000;
const MAX_LIST = 100;

// The shape of the analysis schemas (n8n base-documents-sync "Analysis prompts and schemas").
type Spec =
  | { t: 'string'; nullable?: boolean }
  | { t: 'strings' }
  | { t: 'list'; item: Spec }
  | { t: 'object'; fields: Record<string, Spec> };

const text: Spec = { t: 'string' };
const nullableText: Spec = { t: 'string', nullable: true };

const CV_SPEC: Spec = {
  t: 'object',
  fields: {
    name: nullableText,
    headline: nullableText,
    summary: nullableText,
    workRights: nullableText,
    education: {
      t: 'list',
      item: { t: 'object', fields: { qualification: text, institution: text, dates: text, statusText: text } },
    },
    roles: {
      t: 'list',
      item: { t: 'object', fields: { title: text, employer: text, dates: text, bullets: { t: 'strings' } } },
    },
    projects: { t: 'list', item: { t: 'object', fields: { name: text, bullets: { t: 'strings' } } } },
    skills: { t: 'strings' },
    metrics: { t: 'strings' },
    contact: {
      t: 'object',
      fields: { location: nullableText, email: nullableText, phone: nullableText, links: { t: 'strings' } },
    },
  },
};

const LETTER_SPEC: Spec = {
  t: 'object',
  fields: {
    previousTarget: { t: 'object', fields: { company: nullableText, addressee: nullableText, role: nullableText } },
    reusableParagraphs: { t: 'strings' },
    toneNotes: text,
  },
};

class Invalid extends Error {
  constructor(readonly path: string) {
    super(path);
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function cleanString(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.includes('\0') || v.length > MAX_STRING) throw new Invalid(path);
  return v.trim();
}

function walk(spec: Spec, v: unknown, path: string): unknown {
  switch (spec.t) {
    case 'string': {
      if (v === null && spec.nullable) return null;
      const s = cleanString(v, path);
      return spec.nullable && s === '' ? null : s;
    }
    case 'strings':
    case 'list': {
      if (!Array.isArray(v) || v.length > MAX_LIST) throw new Invalid(path);
      if (spec.t === 'strings') {
        return v.map((x, i) => cleanString(x, `${path}[${i}]`)).filter((s) => s !== '');
      }
      return v.map((x, i) => walk(spec.item, x, `${path}[${i}]`));
    }
    case 'object': {
      if (!isPlainObject(v)) throw new Invalid(path);
      for (const key of Object.keys(v)) if (!(key in spec.fields)) throw new Invalid(`${path}.${key}`);
      const out: Record<string, unknown> = {};
      for (const [key, sub] of Object.entries(spec.fields)) {
        if (!Object.hasOwn(v, key)) throw new Invalid(`${path}.${key}`);
        out[key] = walk(sub, v[key], `${path}.${key}`);
      }
      return out;
    }
  }
}

// Checks facts against the analysis shape and returns them normalised (trimmed, blank nullable
// fields null, blank list entries dropped). `path` names the first bad value, e.g. facts.roles[2].bullets[0].
export function validateFacts(
  kind: DocumentKind,
  input: unknown,
): { ok: true; facts: BaseCvFacts | BaseCoverLetterFacts } | { ok: false; path: string } {
  try {
    const facts = walk(kind === 'cv' ? CV_SPEC : LETTER_SPEC, input, 'facts');
    return { ok: true, facts: facts as BaseCvFacts | BaseCoverLetterFacts };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, path: err.path };
    throw err;
  }
}
