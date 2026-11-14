import { readFile } from 'node:fs/promises';
import path from 'node:path';
import nspell from 'nspell';
import { parseBannedPhrases, phraseRegex } from '../documents/checks.js';
import { docxToPdf, readPdf, type FetchLike } from '../render/pdf.js';
import { renderDocx } from '../templates/index.js';
import {
  collectStrings,
  cvSegments,
  letterSegments,
  stripLinks,
  textOfSegments,
  type Segment,
} from './textOf.js';
import type { DocKind, TailoredCv, TailoredLetter, TemplateId } from './types.js';

export type CheckCode =
  | 'cv_pages'
  | 'letter_pages'
  | 'placeholder'
  | 'company_leakage'
  | 'title_leakage'
  | 'banned_phrase'
  | 'us_spelling'
  | 'tech_casing'
  | 'unknown_fact'
  | 'keyword_not_found'
  | 'link_invalid'
  | 'render_text'
  | 'unmatched_skill'
  | 'possible_misspelling'
  | 'missing_work_rights'
  | 'work_rights_dropped'
  | 'link_unreachable'
  // Not produced by runChecks: the Generate workflow records it when the worker rejects the writer's documents.
  | 'invalid_document'
  // Not produced by runChecks: the Generate workflow records it when a regenerate's writer changed or left out
  // one of Prayush's locked manual edits.
  | 'manual_edit_changed';

export interface CheckResult {
  code: CheckCode;
  severity: 'hard' | 'warning' | 'review';
  doc: DocKind;
  detail: string;
  where?: string;
}

export interface OtherJob {
  title: string | null;
  employer: string | null;
  advertiser: string | null;
}

export interface CheckInput {
  templateId: TemplateId;
  cv: TailoredCv;
  coverLetter: TailoredLetter;
  keywordsCovered: string[];
  job: { title: string | null; employer: string | null; advertiser: string | null; rawText: string };
  baseCv: { structured: object };
  baseCoverLetter: { structured: object } | null;
  otherJobs: OtherJob[];
}

export interface RunOptions {
  gotenbergUrl: string;
  // Used for Gotenberg and for link checks. Tests pass a seam.
  fetch?: FetchLike;
  // Directory with banned-phrases.txt, au-spelling.txt and tech-casing.txt. Default: CONFIG_DIR or /app/config.
  configDir?: string;
  // Test seam: replaces DOCX -> PDF -> text.
  render?: (doc: DocKind, docx: Buffer, cv: TailoredCv, letter: TailoredLetter) => Promise<{ pages: number; text: string }>;
}

// ---------- config and dictionary (read once) ----------

interface CheckConfig {
  banned: string[];
  usToAu: Map<string, string>;
  tech: string[];
}

const configCache = new Map<string, Promise<CheckConfig>>();

const listLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

const E_DROP_SUFFIXES = ['e', 'es', 'ed', 'ing', 'er', 'ers', 'ation', 'ations'];
const PLAIN_SUFFIXES = ['', 's', 'ed', 'ing', 'al', 'ally', 'er', 'ers'];

// "optimize optimise" also covers optimized, optimizing, optimization ...; an explicit line always wins.
// Derived forms are kept only when the US form is not a real word and the AU form is (fulfilled/fulfiled, literal/litreal).
export function buildUsToAu(lines: string[], accepts?: (word: string) => boolean): Map<string, string> {
  const pairs = lines.map((l) => l.split(/\s+/)).filter((p) => p.length === 2 && p[0].toLowerCase() !== p[1].toLowerCase());
  const map = new Map<string, string>();
  for (const [us, au] of pairs) {
    if (/(ize|yze)$/i.test(us) && /(ise|yse)$/i.test(au)) {
      const usRoot = us.slice(0, -1).toLowerCase();
      const auRoot = au.slice(0, -1).toLowerCase();
      for (const s of E_DROP_SUFFIXES) map.set(usRoot + s, auRoot + s);
    } else {
      for (const s of PLAIN_SUFFIXES) map.set(us.toLowerCase() + s, au.toLowerCase() + s);
    }
  }
  if (accepts) {
    for (const [us, au] of [...map]) if (accepts(us) || !accepts(au)) map.delete(us);
  }
  for (const [us, au] of pairs) map.set(us.toLowerCase(), au.toLowerCase());
  return map;
}

export function loadConfig(dir: string): Promise<CheckConfig> {
  let cached = configCache.get(dir);
  if (!cached) {
    cached = (async () => {
      const read = (f: string) => readFile(path.join(dir, f), 'utf8');
      const [banned, au, tech] = await Promise.all([read('banned-phrases.txt'), read('au-spelling.txt'), read('tech-casing.txt')]);
      const spell = await getSpell();
      return { banned: parseBannedPhrases(banned), usToAu: buildUsToAu(listLines(au), (w) => spell.correct(w)), tech: listLines(tech) };
    })();
    configCache.set(dir, cached);
    cached.catch(() => configCache.delete(dir));
  }
  return cached;
}

type Spell = ReturnType<typeof nspell>;
let spellPromise: Promise<Spell> | undefined;
function getSpell(): Promise<Spell> {
  spellPromise ??= import('dictionary-en-au').then((m) => nspell(m.default as unknown as Parameters<typeof nspell>[0]));
  return spellPromise;
}

// ---------- text helpers ----------

const DASHES = /[‐-―−]/g;
const norm = (s: string): string =>
  s.normalize('NFKC').replace(DASHES, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();

const WORD = /[\p{L}][\p{L}']*/gu;

function toAu(text: string, usToAu: Map<string, string>): string {
  return text.replace(WORD, (w) => usToAu.get(w.toLowerCase()) ?? w);
}

const has = (text: string, phrase: string): boolean => phraseRegex(norm(phrase)).test(text);

const MONTHS = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTH_YEAR = new RegExp(`(?<![\\p{L}])(${MONTHS})\\.?,?\\s+(\\d{4})(?!\\d)`, 'giu');
const NUMBER = /(?<![\p{L}\d.,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%|[kKmM](?![\p{L}\d]))?(?![\p{L}\d])/gu;

function monthYears(text: string): { key: string; shown: string }[] {
  return [...text.matchAll(MONTH_YEAR)].map((m) => ({ key: `${m[1].slice(0, 3).toLowerCase()} ${m[2]}`, shown: m[0] }));
}
// A year ("in 2019") or a years-of-experience term ("5 years", "8+ yrs") is a date-like fact, not a result or scale figure.
const YEARS_AFTER = /^\s*\+?\s*(?:years?|yrs?)(?![\p{L}\d])/iu;
function numbers(text: string): { key: string; shown: string; dateLike: boolean }[] {
  return [...text.matchAll(NUMBER)].map((m) => {
    const key = `${m[1].replace(/,/g, '')}${m[2] ?? ''}${(m[3] ?? '').replace('%', 'pct').toLowerCase()}`;
    return { key, shown: m[0], dateLike: /^(?:19|20)\d{2}$/.test(key) || YEARS_AFTER.test(text.slice((m.index ?? 0) + m[0].length)) };
  });
}

// Month-years, bare years and "present", in order: two date strings that say the same thing give the same tokens.
const DATE_TOKEN = new RegExp(`(?<![\\p{L}])(${MONTHS})\\.?,?\\s+(\\d{4})(?!\\d)|(?<!\\d)(\\d{4})(?!\\d)|\\b(present|current|ongoing|now)\\b`, 'giu');
function dateTokens(text: string): string {
  return [...text.matchAll(DATE_TOKEN)]
    .map((m) => (m[1] ? `${m[1].slice(0, 3).toLowerCase()} ${m[2]}` : (m[3] ?? 'present')))
    .join('|');
}
const punctFree = (s: string): string => norm(s).replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

// Links are compared without scheme, "www.", case, trailing slash or fragment: "linkedin.com/in/x" = "https://www.LinkedIn.com/in/x/".
const linkKey = (u: string): string =>
  norm(u).replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '').replace(/#.*$/, '').replace(/\/+$/, '');
const LINK_IN_TEXT = /(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s)>\]"',;]*)?/gi;
const linkKeysIn = (text: string): string[] => (text.match(LINK_IN_TEXT) ?? []).map(linkKey);
// Australian numbers: +61 4xx and 04xx are the same number.
const phoneKey = (p: string): string => {
  const d = p.replace(/\D/g, '').replace(/^0061/, '61');
  return d.startsWith('61') ? `0${d.slice(2).replace(/^0/, '')}` : d;
};

const LEGAL_SUFFIX = /\b(pty|ltd|limited|inc|llc|plc)\b\.?/g;
// Employers only: brackets and legal suffixes are not part of the name. Job titles use norm() so "(Intern)" counts.
const orgKey = (s: string): string =>
  norm(s).replace(/\([^)]*\)/g, ' ').replace(LEGAL_SUFFIX, ' ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- structured base facts ----------

interface BaseFacts {
  corpus: string;
  corpusAu: string;
  numberKeys: Set<string>;
  monthYearKeys: Set<string>;
  titles: Set<string>;
  // employer: orgKey (no brackets or legal suffix), for matching; employerText: norm() of the base text as written.
  roles: { employer: string; employerText: string; title: string; dates: string }[];
  education: { institution: string; qualification: string; statusText: string; statusTextExact: string; dates: string }[];
  words: Set<string>;
  workRights: string | null;
  name: string | null;
  contact: { email: string; phone: string; links: Set<string> };
}

function asRecord(x: unknown): Record<string, unknown> {
  return x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

function wordSet(text: string, into: Set<string>): void {
  for (const m of text.matchAll(WORD)) into.add(m[0].toLowerCase().replace(/'s$/, '').replace(/^'+|'+$/g, ''));
}

function baseFacts(structured: object, usToAu: Map<string, string>): BaseFacts {
  const s = asRecord(structured);
  const raw = collectStrings(structured).join('\n');
  // Contact digits (phone, postcode) are not achievements: numbers and dates come from everything else.
  const { contact: contactRaw, ...rest } = s;
  const factsRaw = collectStrings(rest).join('\n');
  const roles = (Array.isArray(s.roles) ? s.roles : []).map(asRecord);
  const education = (Array.isArray(s.education) ? s.education : []).map(asRecord);
  const contact = asRecord(contactRaw);
  const words = new Set<string>();
  wordSet(raw, words);
  const corpus = norm(raw);
  return {
    corpus,
    corpusAu: toAu(corpus, usToAu),
    numberKeys: new Set(numbers(stripLinks(factsRaw)).map((n) => n.key)),
    monthYearKeys: new Set(monthYears(factsRaw).map((m) => m.key)),
    titles: new Set(roles.map((r) => norm(String(r.title ?? ''))).filter(Boolean)),
    roles: roles.map((r) => ({ employer: orgKey(String(r.employer ?? '')), employerText: norm(String(r.employer ?? '')), title: norm(String(r.title ?? '')), dates: dateTokens(String(r.dates ?? '')) })),
    education: education.map((e) => ({
      institution: norm(String(e.institution ?? '')),
      qualification: norm(String(e.qualification ?? '')),
      statusText: punctFree(String(e.statusText ?? '')),
      statusTextExact: norm(String(e.statusText ?? '')),
      dates: dateTokens(String(e.dates ?? '')),
    })),
    words,
    workRights: typeof s.workRights === 'string' && s.workRights.trim() !== '' ? s.workRights : null,
    name: typeof s.name === 'string' && s.name.trim() !== '' ? s.name : null,
    contact: {
      email: norm(String(contact.email ?? '')),
      phone: phoneKey(String(contact.phone ?? '')),
      links: new Set([...collectStrings(contact.links).map(linkKey), ...linkKeysIn(raw)]),
    },
  };
}

// ---------- the checks ----------

const PLACEHOLDERS: RegExp[] = [/\[[^\]\n]*\]/, /\{\{[\s\S]*?\}\}/, /\bX{2,}\s?%/, /\bX{3,}\b/, /\blorem\b/i, /\bTBD\b/, /<[^<>\n]{1,80}>/];

function placeholderChecks(segments: Segment[]): CheckResult[] {
  const out: CheckResult[] = [];
  for (const seg of segments) {
    for (const re of PLACEHOLDERS) {
      const m = re.exec(seg.text);
      if (m) out.push({ code: 'placeholder', severity: 'hard', doc: seg.doc, where: seg.where, detail: `Leftover placeholder "${m[0]}".` });
    }
  }
  return out;
}

// Only text equal to the base value (after norm(): case, spaces, dashes and quotes; brackets and other
// punctuation count) is exempt.
// A field the writer must copy exactly from the base CV (role title, employer, institution, qualification,
// statusText, the work-rights line) and did: its own words are his, so US spelling and banned words in it
// ("Data Visualization Analyst", "Dynamic Solutions Pty Ltd") are not the writer's to fix.
const COPIED_FIELD = /^(?:cv\.experience\[\d+\]\.(title|employer)|cv\.education\[\d+\]\.(institution|qualification|statusText)|cv\.(workRights))$/;

function isCopiedFromBase(seg: Segment, base: BaseFacts): boolean {
  const m = COPIED_FIELD.exec(seg.where);
  if (!m) return false;
  const field = m[1] ?? m[2] ?? m[3];
  switch (field) {
    case 'title':
      return base.titles.has(norm(seg.text));
    case 'employer':
      // Exactly as the base CV writes it, brackets included: text added in brackets is the writer's.
      return base.roles.some((r) => r.employerText === norm(seg.text));
    case 'institution':
      return base.education.some((e) => e.institution === norm(seg.text));
    case 'qualification':
      return base.education.some((e) => e.qualification === norm(seg.text));
    case 'statusText':
      return base.education.some((e) => e.statusTextExact === norm(seg.text));
    case 'workRights':
      return base.workRights !== null && norm(base.workRights) === norm(seg.text);
    default:
      return false;
  }
}

function bannedChecks(segments: Segment[], banned: string[]): CheckResult[] {
  const out: CheckResult[] = [];
  for (const seg of segments) {
    const seen = new Set<string>();
    for (const phrase of banned) {
      const key = phrase.toLowerCase();
      if (seen.has(key) || !phraseRegex(phrase).test(seg.text)) continue;
      seen.add(key);
      out.push({ code: 'banned_phrase', severity: 'hard', doc: seg.doc, where: seg.where, detail: phrase });
    }
  }
  return out;
}

// Names from the previous application match ignoring case and punctuation ("Ms Quill" = "Ms. Quill"). Names from other jobs match
// as stored, case-sensitively, so a common word ("insight") is not mistaken for an employer called "Insight".
const looseText = (s: string): string => norm(s).replace(/[.,;:]/g, '');

function leakageChecks(input: CheckInput, segments: Segment[], base: BaseFacts): CheckResult[] {
  const prev = asRecord(asRecord(input.baseCoverLetter?.structured).previousTarget);
  const candidates: { name: string; kind: 'company' | 'title'; source: string; loose: boolean }[] = [];
  const push = (name: unknown, kind: 'company' | 'title', source: string, loose: boolean) => {
    if (typeof name === 'string' && name.trim().length >= 3) candidates.push({ name: name.trim(), kind, source, loose });
  };
  push(prev.company, 'company', 'previousTarget.company', true);
  push(prev.addressee, 'company', 'previousTarget.addressee', true);
  push(prev.role, 'title', 'previousTarget.role', true);
  for (const j of input.otherJobs) {
    push(j.employer, 'company', 'another job employer', false);
    push(j.advertiser, 'company', 'another job advertiser', false);
    push(j.title, 'title', 'another job title', false);
  }
  const target = [input.job.title, input.job.employer, input.job.advertiser].filter((t): t is string => !!t).map(norm);
  const out: CheckResult[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const n = norm(c.name);
    if (target.some((t) => t === n || phraseRegex(t).test(n) || phraseRegex(n).test(t))) continue;
    if (phraseRegex(n).test(base.corpus)) continue;
    const re = c.loose ? phraseRegex(looseText(c.name)) : new RegExp(phraseRegex(c.name).source, 'u');
    for (const seg of segments) {
      if (!re.test(c.loose ? looseText(seg.text) : seg.text)) continue;
      const key = `${c.kind}|${n}|${seg.where}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        code: c.kind === 'company' ? 'company_leakage' : 'title_leakage',
        severity: 'hard',
        doc: seg.doc,
        where: seg.where,
        detail: `"${c.name}" (${c.source}) is not this job.`,
      });
    }
  }
  return out;
}

function usSpellingChecks(segments: Segment[], usToAu: Map<string, string>, exempt: Set<string>): CheckResult[] {
  const out: CheckResult[] = [];
  for (const seg of segments) {
    const seen = new Set<string>();
    for (const m of stripLinks(seg.text).matchAll(WORD)) {
      const w = m[0].toLowerCase();
      const au = usToAu.get(w);
      if (!au || seen.has(w) || exempt.has(w)) continue;
      seen.add(w);
      out.push({ code: 'us_spelling', severity: 'hard', doc: seg.doc, where: seg.where, detail: `"${m[0]}" should be "${au}".` });
    }
  }
  return out;
}

function techCasingChecks(segments: Segment[], tech: string[], spell: Spell): CheckResult[] {
  const out: CheckResult[] = [];
  const rules = tech.map((canonical) => ({
    canonical,
    // An ordinary English word (rest, react) in lower case is just English.
    plainWord: spell.correct(canonical.toLowerCase()),
    re: new RegExp(phraseRegex(canonical).source, 'giu'),
  }));
  for (const seg of segments) {
    const text = stripLinks(seg.text);
    const seen = new Set<string>();
    for (const rule of rules) {
      for (const m of text.matchAll(rule.re)) {
        const found = m[0].replace(/\s+/g, ' ');
        if (found === rule.canonical || seen.has(found)) continue;
        if (rule.plainWord && found === found.toLowerCase()) continue;
        seen.add(found);
        out.push({ code: 'tech_casing', severity: 'hard', doc: seg.doc, where: seg.where, detail: `"${found}" should be "${rule.canonical}".` });
      }
    }
  }
  return out;
}

const unknown = (doc: DocKind, where: string, detail: string): CheckResult => ({ code: 'unknown_fact', severity: 'hard', doc, where, detail });
const PROSE_URL = /https?:\/\/[^\s)>\]"']+/gi;

// Numbers and dates a text may use: the base CV's; the letter may also use the job ad's own.
// Experience and project bullets may carry new result or scale figures (the writer lists them as stretches); their years, years-of-experience terms and month-year dates are still checked.
const BULLET_WHERE = /^cv\.(?:experience|projects)\[\d+\]\.bullets\[\d+\]$/;
const isBullet = (seg: Segment): boolean => seg.doc === 'cv' && BULLET_WHERE.test(seg.where);

function numberAndDateFacts(seg: Segment, text: string, base: BaseFacts, extra?: { numbers: Set<string>; dates: Set<string> }): CheckResult[] {
  const out: CheckResult[] = [];
  const seenNum = new Set<string>();
  for (const n of numbers(text)) {
    if (isBullet(seg) && !n.dateLike) continue;
    if (base.numberKeys.has(n.key) || extra?.numbers.has(n.key) || seenNum.has(n.key)) continue;
    seenNum.add(n.key);
    out.push(unknown(seg.doc, seg.where, `The number "${n.shown}" is not in the base CV.`));
  }
  for (const d of monthYears(text)) {
    if (base.monthYearKeys.has(d.key) || extra?.dates.has(d.key)) continue;
    out.push(unknown(seg.doc, seg.where, `The date "${d.shown}" is not in the base CV.`));
  }
  return out;
}

function roleFacts(cv: TailoredCv, base: BaseFacts): CheckResult[] {
  const out: CheckResult[] = [];
  cv.experience.forEach((e, i) => {
    const p = `cv.experience[${i}]`;
    const candidates = base.roles.filter((r) => r.employer === orgKey(e.employer));
    const datesSeg: Segment = { doc: 'cv', where: `${p}.dates`, text: e.dates, kind: 'body' };
    if (candidates.length === 0) {
      out.push(unknown('cv', `${p}.employer`, `The employer "${e.employer}" is not in the base CV.`));
      if (!base.titles.has(norm(e.title))) out.push(unknown('cv', `${p}.title`, `The job title "${e.title}" is not in the base CV.`));
      out.push(...numberAndDateFacts(datesSeg, e.dates, base));
      return;
    }
    // Brackets are ignored when matching an employer, so bracketed text the base employer does not have is new.
    for (const m of e.employer.matchAll(/\(([^)]*)\)/g)) {
      const inner = norm(m[1]);
      if (inner !== '' && !candidates.some((r) => r.employerText.includes(`(${inner})`))) {
        out.push(unknown('cv', `${p}.employer`, `"(${m[1]})" is not part of the employer "${e.employer}" in the base CV.`));
      }
    }
    const exact = candidates.find((r) => r.title === norm(e.title));
    if (!exact) out.push(unknown('cv', `${p}.title`, `The job title "${e.title}" is not the title the base CV gives for "${e.employer}".`));
    const dk = dateTokens(e.dates);
    if (!(exact ? [exact] : candidates).some((r) => r.dates === dk)) {
      out.push(unknown('cv', `${p}.dates`, `The dates "${e.dates}" differ from the base CV's dates for "${e.employer}".`));
    }
  });
  cv.education.forEach((e, i) => {
    const p = `cv.education[${i}]`;
    const candidates = base.education.filter((b) => b.institution === norm(e.institution));
    if (candidates.length === 0) {
      out.push(unknown('cv', `${p}.institution`, `The institution "${e.institution}" is not in the base CV.`));
      return;
    }
    const exact = candidates.find((b) => b.qualification === norm(e.qualification));
    if (!exact) out.push(unknown('cv', `${p}.qualification`, `The qualification "${e.qualification}" is not the one the base CV gives for "${e.institution}".`));
    const pool = exact ? [exact] : candidates;
    if (!pool.some((b) => b.dates === dateTokens(e.dates))) out.push(unknown('cv', `${p}.dates`, `The dates "${e.dates}" differ from the base CV.`));
    if (!pool.some((b) => b.statusText === punctFree(e.statusText))) out.push(unknown('cv', `${p}.statusText`, 'The completion wording differs from the base CV.'));
  });
  return out;
}

function contactAndRightsFacts(cv: TailoredCv, base: BaseFacts): CheckResult[] {
  const out: CheckResult[] = [];
  if (base.workRights !== null && !(cv.workRights && cv.workRights.trim() !== '')) {
    out.push({ code: 'work_rights_dropped', severity: 'hard', doc: 'cv', where: 'cv.workRights', detail: 'Your base CV has a work-rights line; keep it.' });
  }
  if (cv.workRights && cv.workRights.trim() !== '') {
    if (base.workRights === null) {
      out.push(unknown('cv', 'cv.workRights', 'The base CV has no work-rights line, so one cannot be added.'));
    } else if (punctFree(cv.workRights) !== punctFree(base.workRights)) {
      out.push(unknown('cv', 'cv.workRights', 'The work-rights wording differs from the base CV.'));
    }
  }
  if (base.name !== null) {
    if (punctFree(cv.name) !== punctFree(base.name)) out.push(unknown('cv', 'cv.name', 'The name differs from the base CV.'));
  }
  if (cv.contact.email && norm(cv.contact.email) !== base.contact.email) out.push(unknown('cv', 'cv.contact.email', 'The e-mail address differs from the base CV.'));
  if (cv.contact.phone && phoneKey(cv.contact.phone) !== base.contact.phone) out.push(unknown('cv', 'cv.contact.phone', 'The phone number differs from the base CV.'));
  return out;
}

function factChecks(input: CheckInput, cvSegs: Segment[], letterSegs: Segment[], base: BaseFacts): CheckResult[] {
  const out: CheckResult[] = [...roleFacts(input.cv, base), ...contactAndRightsFacts(input.cv, base)];
  if (base.name !== null && punctFree(input.coverLetter.name) !== punctFree(base.name)) {
    out.push(unknown('cover_letter', 'coverLetter.name', 'The name differs from the base CV.'));
  }
  const jobText = [input.job.title, input.job.employer, input.job.advertiser, input.job.rawText].filter((t): t is string => !!t).join('\n');
  const jobAllowed = { numbers: new Set(numbers(stripLinks(jobText)).map((n) => n.key)), dates: new Set(monthYears(jobText).map((m) => m.key)) };
  // The letter may also repeat a number from the tailored CV's bullets.
  const letterAllowed = {
    numbers: new Set([...jobAllowed.numbers, ...cvSegs.filter(isBullet).flatMap((b) => numbers(stripLinks(b.text)).filter((n) => !n.dateLike).map((n) => n.key))]),
    dates: jobAllowed.dates,
  };
  const jobLinkKeys = new Set(linkKeysIn(jobText));
  for (const seg of [...cvSegs, ...letterSegs]) {
    if (seg.kind !== 'body') continue;
    // Role and education dates are compared with their own base entry in roleFacts.
    const text = stripLinks(seg.text);
    if (!seg.field) out.push(...numberAndDateFacts(seg, text, base, seg.doc === 'cover_letter' ? letterAllowed : undefined));
    for (const url of seg.text.match(PROSE_URL) ?? []) {
      const clean = url.replace(/[.,;:]+$/, '');
      const key = linkKey(clean);
      if (!base.contact.links.has(key) && !jobLinkKeys.has(key)) {
        out.push(unknown(seg.doc, seg.where, `The link "${clean}" is not in the base CV or the job ad.`));
      }
    }
  }
  return out;
}

// A technology named in the CV prose that the base CV never mentions: the reviewer decides whether it is real.
function techNotInBaseChecks(cvSegs: Segment[], tech: string[], spell: Spell, base: BaseFacts, usToAu: Map<string, string>): CheckResult[] {
  const out: CheckResult[] = [];
  for (const canonical of tech) {
    if (has(base.corpusAu, toAu(norm(canonical), usToAu))) continue;
    const plainWord = spell.correct(canonical.toLowerCase());
    const re = new RegExp(phraseRegex(canonical).source, 'giu');
    for (const seg of cvSegs) {
      if (seg.kind !== 'body' || seg.where.startsWith('cv.skills')) continue;
      const hit = [...stripLinks(seg.text).matchAll(re)].some((m) => !(plainWord && m[0] === m[0].toLowerCase()));
      if (!hit) continue;
      out.push({ code: 'unmatched_skill', severity: 'review', doc: 'cv', where: seg.where, detail: `The technology "${canonical}" is not in the base CV.` });
      break;
    }
  }
  return out;
}

function keywordChecks(input: CheckInput, usToAu: Map<string, string>): CheckResult[] {
  const cvText = toAu(norm(textOfSegments(cvSegments(input.cv))), usToAu);
  return input.keywordsCovered
    .filter((k) => k.trim() !== '' && !has(cvText, toAu(norm(k), usToAu)))
    .map((k) => ({ code: 'keyword_not_found' as const, severity: 'hard' as const, doc: 'cv' as const, detail: `The keyword "${k}" is listed as covered but is not in the CV.` }));
}

function skillChecks(cv: TailoredCv, base: BaseFacts, usToAu: Map<string, string>): CheckResult[] {
  const out: CheckResult[] = [];
  cv.skills.forEach((g, i) =>
    g.items.forEach((item, j) => {
      if (!has(base.corpusAu, toAu(norm(item), usToAu))) {
        out.push({
          code: 'unmatched_skill',
          severity: 'review',
          doc: 'cv',
          where: `cv.skills[${i}].items[${j}]`,
          detail: `The skill "${item}" is not in the base CV (it may be an honest rephrase).`,
        });
      }
    }),
  );
  return out;
}

function misspellingChecks(segments: Segment[], spell: Spell, allowed: Set<string>): CheckResult[] {
  const out: CheckResult[] = [];
  const seen = new Set<string>();
  for (const seg of segments) {
    if (seg.kind !== 'body') continue;
    for (const m of stripLinks(seg.text).matchAll(WORD)) {
      const w = m[0].replace(/'s$/, '').replace(/^'+|'+$/g, '');
      const lower = w.toLowerCase();
      if (w.length < 3 || /\p{Lu}/u.test(w.slice(1)) || seen.has(lower) || allowed.has(lower)) continue;
      if (spell.correct(w) || spell.correct(lower)) continue;
      seen.add(lower);
      out.push({ code: 'possible_misspelling', severity: 'review', doc: seg.doc, where: seg.where, detail: w });
    }
  }
  return out;
}

// ---------- links ----------

const REACHABLE = new Set([401, 403, 429, 999]);

// The worker must not be pointed at its own network by text a model wrote: only public, dotted host names.
function isPublicHost(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  if (host.startsWith('[') || !host.includes('.') || /\.(local|internal|localdomain|lan|home|corp)$/.test(host)) return false;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) return false;
  return true;
}

async function isReachable(url: string, f: FetchLike): Promise<boolean> {
  let status = 0;
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await f(url, { method, redirect: 'manual', signal: AbortSignal.timeout(5000) });
      void res.body?.cancel().catch(() => undefined);
      status = res.status;
    } catch {
      status = 0;
      continue;
    }
    // Only a definite "gone" is a failure; other statuses (including 5xx) are not evidence the link is dead.
    if (status !== 404 && status !== 410 && status !== 0) return true;
    if (REACHABLE.has(status)) return true;
  }
  return false;
}

async function linkChecks(cv: TailoredCv, base: BaseFacts, f: FetchLike): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const toProbe: { url: string; where: string }[] = [];
  cv.contact.links.forEach((l, i) => {
    const where = `cv.contact.links[${i}]`;
    let protocol = '';
    try {
      protocol = new URL(l.url).protocol;
    } catch {
      /* invalid */
    }
    if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'mailto:') {
      out.push({ code: 'link_invalid', severity: 'hard', doc: 'cv', where, detail: `"${l.url}" is not an http(s) or mailto link.` });
    } else if (protocol === 'mailto:') {
      return;
    } else if (!isPublicHost(l.url)) {
      out.push({ code: 'link_invalid', severity: 'hard', doc: 'cv', where, detail: `"${l.url}" is not a public web address.` });
    } else if (!base.contact.links.has(linkKey(l.url))) {
      out.push(unknown('cv', where, `The link "${l.url}" is not in the base CV.`));
    } else {
      toProbe.push({ url: l.url, where });
    }
  });
  const probed = await Promise.all(toProbe.map(async (p) => ({ ...p, ok: await isReachable(p.url, f) })));
  for (const p of probed) {
    if (!p.ok) out.push({ code: 'link_unreachable', severity: 'warning', doc: 'cv', where: p.where, detail: `${p.url} did not answer or returned 404/410.` });
  }
  return out;
}

// ---------- rendering ----------

const HEADINGS: Record<TemplateId, (cv: TailoredCv) => string[]> = {
  'standard-ats': (cv) => [...(cv.summary.trim() !== '' ? ['SUMMARY'] : []), 'SKILLS', 'EXPERIENCE', ...(cv.projects.length > 0 ? ['PROJECTS'] : []), 'EDUCATION'],
};

function renderTextChecks(templateId: TemplateId, cv: TailoredCv, cvText: string, letterText: string): CheckResult[] {
  const out: CheckResult[] = [];
  const squash = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
  if (!squash(cvText).includes(squash(cv.name))) {
    out.push({ code: 'render_text', severity: 'hard', doc: 'cv', detail: 'The name is missing from the rendered CV text.' });
  }
  let from = 0;
  for (const h of HEADINGS[templateId](cv)) {
    const at = cvText.indexOf(h, from);
    if (at >= 0) {
      from = at + h.length;
      continue;
    }
    const anywhere = cvText.includes(h);
    out.push({
      code: 'render_text',
      severity: 'hard',
      doc: 'cv',
      detail: anywhere ? `The section "${h}" is out of order in the rendered CV.` : `The section "${h}" is missing from the rendered CV.`,
    });
  }
  if (!squash(letterText).includes(squash(cv.name))) {
    out.push({ code: 'render_text', severity: 'hard', doc: 'cover_letter', detail: 'The name is missing from the rendered cover letter text.' });
  }
  return out;
}

async function defaultRender(
  templateId: TemplateId,
  doc: DocKind,
  cv: TailoredCv,
  letter: TailoredLetter,
  opts: RunOptions,
): Promise<{ pages: number; text: string }> {
  const docx = await renderDocx(templateId, doc, cv, doc === 'cover_letter' ? letter : undefined);
  const pdf = await docxToPdf(docx, opts.gotenbergUrl, opts.fetch);
  return readPdf(pdf);
}

// ---------- entry point ----------

export async function runChecks(
  input: CheckInput,
  opts: RunOptions,
): Promise<{ checks: CheckResult[]; cvPages: number; letterPages: number }> {
  const config = await loadConfig(opts.configDir ?? process.env.CONFIG_DIR ?? '/app/config');
  const spell = await getSpell();
  const f = opts.fetch ?? fetch;
  const renderDoc = async (doc: DocKind) => {
    if (opts.render) {
      const docx = await renderDocx(input.templateId, doc, input.cv, doc === 'cover_letter' ? input.coverLetter : undefined).catch(() => Buffer.alloc(0));
      return opts.render(doc, docx, input.cv, input.coverLetter);
    }
    return defaultRender(input.templateId, doc, input.cv, input.coverLetter, opts);
  };
  const cvRender = await renderDoc('cv');
  const letterRender = await renderDoc('cover_letter');

  const cvSegs = cvSegments(input.cv);
  const letterSegs = letterSegments(input.coverLetter);
  const all = [...cvSegs, ...letterSegs];

  const checks: CheckResult[] = [];
  if (cvRender.pages > 1) checks.push({ code: 'cv_pages', severity: 'hard', doc: 'cv', detail: `The CV is ${cvRender.pages} pages; the limit is 1.` });
  if (letterRender.pages > 2) {
    checks.push({ code: 'letter_pages', severity: 'hard', doc: 'cover_letter', detail: `The cover letter is ${letterRender.pages} pages; the limit is 2.` });
  }
  checks.push(...renderTextChecks(input.templateId, input.cv, cvRender.text, letterRender.text));
  checks.push(...placeholderChecks(all));
  const base = baseFacts(input.baseCv.structured, config.usToAu);
  // Copied own names are exempt from the spelling and banned-phrase checks; everything else is checked.
  const ownWords = all.filter((seg) => !isCopiedFromBase(seg, base));
  checks.push(...bannedChecks(ownWords, config.banned));
  checks.push(...leakageChecks(input, all, base));

  const exempt = new Set<string>();
  for (const s of [input.job.title, input.job.employer, input.job.advertiser]) if (s) wordSet(s, exempt);
  const baseRecord = asRecord(input.baseCv.structured);
  for (const e of Array.isArray(baseRecord.education) ? baseRecord.education : []) wordSet(String(asRecord(e).institution ?? ''), exempt);
  for (const e of Array.isArray(baseRecord.education) ? baseRecord.education : []) wordSet(String(asRecord(e).qualification ?? ''), exempt);
  for (const r of Array.isArray(baseRecord.roles) ? baseRecord.roles : []) wordSet(String(asRecord(r).employer ?? ''), exempt);
  checks.push(...usSpellingChecks(ownWords, config.usToAu, exempt));
  checks.push(...techCasingChecks(all, config.tech, spell));
  checks.push(...factChecks(input, cvSegs, letterSegs, base));
  checks.push(...techNotInBaseChecks(cvSegs, config.tech, spell, base, config.usToAu));
  checks.push(...keywordChecks(input, config.usToAu));
  checks.push(...skillChecks(input.cv, base, config.usToAu));

  const allowed = new Set<string>(base.words);
  wordSet(input.job.rawText, allowed);
  for (const s of [input.job.title, input.job.employer, input.job.advertiser, ...config.tech, ...input.keywordsCovered]) if (s) wordSet(s, allowed);
  checks.push(...misspellingChecks(all, spell, allowed));

  if (base.workRights === null) {
    checks.push({ code: 'missing_work_rights', severity: 'warning', doc: 'cv', detail: 'The base CV has no work-rights line.' });
  }
  checks.push(...(await linkChecks(input.cv, base, f)));

  return { checks, cvPages: cvRender.pages, letterPages: letterRender.pages };
}
