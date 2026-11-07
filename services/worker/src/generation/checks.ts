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
  | 'link_unreachable';

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
export function buildUsToAu(lines: string[]): Map<string, string> {
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
  for (const [us, au] of pairs) map.set(us.toLowerCase(), au.toLowerCase());
  return map;
}

export function loadConfig(dir: string): Promise<CheckConfig> {
  let cached = configCache.get(dir);
  if (!cached) {
    cached = (async () => {
      const read = (f: string) => readFile(path.join(dir, f), 'utf8');
      const [banned, au, tech] = await Promise.all([read('banned-phrases.txt'), read('au-spelling.txt'), read('tech-casing.txt')]);
      return { banned: parseBannedPhrases(banned), usToAu: buildUsToAu(listLines(au)), tech: listLines(tech) };
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
function numbers(text: string): { key: string; shown: string }[] {
  return [...text.matchAll(NUMBER)].map((m) => ({
    key: `${m[1].replace(/,/g, '')}${m[2] ?? ''}${(m[3] ?? '').replace('%', '').toLowerCase()}`,
    shown: m[0],
  }));
}

const LEGAL_SUFFIX = /\b(pty|ltd|limited|inc|llc|plc)\b\.?/g;
const orgKey = (s: string): string =>
  norm(s).replace(/\([^)]*\)/g, ' ').replace(LEGAL_SUFFIX, ' ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- structured base facts ----------

interface BaseFacts {
  corpus: string;
  corpusAu: string;
  numberKeys: Set<string>;
  monthYearKeys: Set<string>;
  employers: Set<string>;
  titles: Set<string>;
  words: Set<string>;
  workRights: boolean;
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
  const corpus = norm(raw);
  const roles = Array.isArray(s.roles) ? s.roles.map(asRecord) : [];
  const words = new Set<string>();
  wordSet(raw, words);
  return {
    corpus,
    corpusAu: toAu(corpus, usToAu),
    numberKeys: new Set(numbers(stripLinks(raw)).map((n) => n.key)),
    monthYearKeys: new Set(monthYears(raw).map((m) => m.key)),
    employers: new Set(roles.map((r) => orgKey(String(r.employer ?? ''))).filter(Boolean)),
    titles: new Set(roles.map((r) => orgKey(String(r.title ?? ''))).filter(Boolean)),
    words,
    workRights: typeof s.workRights === 'string' && s.workRights.trim() !== '',
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

function leakageChecks(input: CheckInput, segments: Segment[], base: BaseFacts): CheckResult[] {
  const prev = asRecord(asRecord(input.baseCoverLetter?.structured).previousTarget);
  const candidates: { name: string; kind: 'company' | 'title'; source: string }[] = [];
  const push = (name: unknown, kind: 'company' | 'title', source: string) => {
    if (typeof name === 'string' && name.trim().length >= 3) candidates.push({ name: name.trim(), kind, source });
  };
  push(prev.company, 'company', 'previousTarget.company');
  push(prev.addressee, 'company', 'previousTarget.addressee');
  push(prev.role, 'title', 'previousTarget.role');
  for (const j of input.otherJobs) {
    push(j.employer, 'company', 'another job employer');
    push(j.advertiser, 'company', 'another job advertiser');
    push(j.title, 'title', 'another job title');
  }
  const target = [input.job.title, input.job.employer, input.job.advertiser].filter((t): t is string => !!t).map(norm);
  const out: CheckResult[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const n = norm(c.name);
    if (target.some((t) => t === n || phraseRegex(t).test(n) || phraseRegex(n).test(t))) continue;
    if (phraseRegex(n).test(base.corpus)) continue;
    const re = phraseRegex(c.name);
    for (const seg of segments) {
      if (!re.test(seg.text)) continue;
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

function factChecks(cvSegs: Segment[], letterSegs: Segment[], base: BaseFacts): CheckResult[] {
  const out: CheckResult[] = [];
  for (const seg of [...cvSegs, ...letterSegs]) {
    if (seg.kind !== 'body') continue;
    const text = stripLinks(seg.text);
    const seenNum = new Set<string>();
    for (const n of numbers(text)) {
      if (base.numberKeys.has(n.key) || seenNum.has(n.key)) continue;
      seenNum.add(n.key);
      out.push({ code: 'unknown_fact', severity: 'hard', doc: seg.doc, where: seg.where, detail: `The number "${n.shown}" is not in the base CV.` });
    }
    for (const d of monthYears(text)) {
      if (base.monthYearKeys.has(d.key)) continue;
      out.push({ code: 'unknown_fact', severity: 'hard', doc: seg.doc, where: seg.where, detail: `The date "${d.shown}" is not in the base CV.` });
    }
    if (seg.field === 'employer' && !base.employers.has(orgKey(seg.text))) {
      out.push({ code: 'unknown_fact', severity: 'hard', doc: seg.doc, where: seg.where, detail: `The employer "${seg.text}" is not in the base CV.` });
    }
    if (seg.field === 'title' && !base.titles.has(orgKey(seg.text))) {
      out.push({ code: 'unknown_fact', severity: 'hard', doc: seg.doc, where: seg.where, detail: `The job title "${seg.text}" is not in the base CV.` });
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

async function isReachable(url: string, f: FetchLike): Promise<boolean> {
  let status = 0;
  for (const method of ['HEAD', 'GET']) {
    try {
      const res = await f(url, { method, redirect: 'follow', signal: AbortSignal.timeout(5000) });
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

async function linkChecks(cv: TailoredCv, f: FetchLike): Promise<CheckResult[]> {
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
    } else if (protocol !== 'mailto:') {
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
  'standard-ats': (cv) => ['SUMMARY', 'SKILLS', 'EXPERIENCE', ...(cv.projects.length > 0 ? ['PROJECTS'] : []), 'EDUCATION'],
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
  const base = baseFacts(input.baseCv.structured, config.usToAu);

  const checks: CheckResult[] = [];
  if (cvRender.pages > 1) checks.push({ code: 'cv_pages', severity: 'hard', doc: 'cv', detail: `The CV is ${cvRender.pages} pages; the limit is 1.` });
  if (letterRender.pages > 2) {
    checks.push({ code: 'letter_pages', severity: 'hard', doc: 'cover_letter', detail: `The cover letter is ${letterRender.pages} pages; the limit is 2.` });
  }
  checks.push(...renderTextChecks(input.templateId, input.cv, cvRender.text, letterRender.text));
  checks.push(...placeholderChecks(all));
  checks.push(...bannedChecks(all, config.banned));
  checks.push(...leakageChecks(input, all, base));

  const exempt = new Set<string>();
  for (const s of [input.job.title, input.job.employer, input.job.advertiser]) if (s) wordSet(s, exempt);
  const baseRecord = asRecord(input.baseCv.structured);
  for (const e of Array.isArray(baseRecord.education) ? baseRecord.education : []) wordSet(String(asRecord(e).institution ?? ''), exempt);
  for (const r of Array.isArray(baseRecord.roles) ? baseRecord.roles : []) wordSet(String(asRecord(r).employer ?? ''), exempt);
  checks.push(...usSpellingChecks(all, config.usToAu, exempt));
  checks.push(...techCasingChecks(all, config.tech, spell));
  checks.push(...factChecks(cvSegs, letterSegs, base));
  checks.push(...keywordChecks(input, config.usToAu));
  checks.push(...skillChecks(input.cv, base, config.usToAu));

  const allowed = new Set<string>(base.words);
  wordSet(input.job.rawText, allowed);
  for (const s of [input.job.title, input.job.employer, input.job.advertiser, ...config.tech, ...input.keywordsCovered]) if (s) wordSet(s, allowed);
  checks.push(...misspellingChecks(all, spell, allowed));

  if (!base.workRights) {
    checks.push({ code: 'missing_work_rights', severity: 'warning', doc: 'cv', detail: 'The base CV has no work-rights line.' });
  }
  checks.push(...(await linkChecks(input.cv, f)));

  return { checks, cvPages: cvRender.pages, letterPages: letterRender.pages };
}
