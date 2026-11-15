import { valueAt } from '../job/manualEdits';
import type { JobDetail, ManualEdit, VersionSummary } from './types';

// Runtime shape checks for GET /api/jobs/detail. The page reads every field it renders without
// guarding, so anything that does not match is refused here (the client turns null into a 502).

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strOrNull = (v: unknown) => v === null || isStr(v);
const strOrNullOrMissing = (v: unknown) => v === undefined || v === null || isStr(v);
const arrOf = <T>(v: unknown, f: (x: unknown) => x is T): v is T[] => Array.isArray(v) && v.every(f);
const isStrArr = (v: unknown): v is string[] => arrOf(v, isStr);
const oneOf = (list: readonly string[]) => (v: unknown): v is string => isStr(v) && list.includes(v);

const JOB_STATUSES = ['new', 'cv_ready', 'applied', 'interviewing', 'closed'];
const RUN_STATUSES = ['pending', 'in_progress', 'done', 'failed'];
const RUN_STAGES = ['queued', 'writing', 'checking', 'reviewing', 'saving'];
const CHECK_CODES = [
  'cv_pages', 'letter_pages', 'placeholder', 'company_leakage', 'title_leakage', 'banned_phrase', 'us_spelling',
  'tech_casing', 'unknown_fact', 'keyword_not_found', 'link_invalid', 'render_text', 'unmatched_skill',
  'possible_misspelling', 'missing_work_rights', 'work_rights_dropped', 'link_unreachable', 'long_paragraph', 'invalid_document',
  'manual_edit_changed', 'criteria_coverage',
];
const ORIGINS = ['generated', 'regenerated', 'edited', 'restored'];
const isOrigin = oneOf(ORIGINS);
const REVIEW_IDS = [
  'relevance', 'over_tailoring', 'strongest_match_top_third', 'inflated_scope', 'ai_sounding', 'paraphrased_job_ad',
  'keyword_stuffing', 'bullet_rhythm', 'star_form', 'tidiness', 'keyword_coverage_honest', 'reasons_hold_up',
  'cover_letter_sources', 'addressee', 'selection_criteria',
];

function isJob(j: unknown): boolean {
  return (
    isObj(j) &&
    isStr(j.id) &&
    strOrNull(j.title) &&
    strOrNull(j.employer) &&
    strOrNull(j.advertiser) &&
    strOrNull(j.url) &&
    oneOf(JOB_STATUSES)(j.status) &&
    strOrNull(j.rawText) &&
    (j.matchScore === null || isNum(j.matchScore)) &&
    strOrNull(j.matchExplanation) &&
    (j.matchBreakdown === null ||
      (isObj(j.matchBreakdown) && isStrArr(j.matchBreakdown.matched) && isStrArr(j.matchBreakdown.missing) && isStrArr(j.matchBreakdown.notes))) &&
    isStrArr(j.warnings) &&
    strOrNull(j.companyNotes) &&
    strOrNullOrMissing(j.suggestedTemplate) &&
    strOrNullOrMissing(j.templateReason) &&
    strOrNullOrMissing(j.templateChoice)
  );
}

function isGeneration(g: unknown): boolean {
  return (
    g === null ||
    (isObj(g) &&
      oneOf(RUN_STATUSES)(g.status) &&
      oneOf(RUN_STAGES)(g.stage) &&
      isNum(g.round) &&
      isNum(g.attempts) &&
      strOrNull(g.error) &&
      (g.instruction === undefined || strOrNull(g.instruction)) &&
      (g.fromVersionId === undefined || strOrNull(g.fromVersionId)))
  );
}

export const isCheck = (c: unknown): boolean =>
  isObj(c) &&
  oneOf(CHECK_CODES)(c.code) &&
  oneOf(['hard', 'warning', 'review'])(c.severity) &&
  oneOf(['cv', 'cover_letter'])(c.doc) &&
  isStr(c.detail) &&
  (c.where === undefined || isStr(c.where)) &&
  (c.locked === undefined || typeof c.locked === 'boolean');

function isUnresolved(u: unknown): boolean {
  if (!isObj(u)) return false;
  switch (u.source) {
    case 'check':
      return isCheck(u) && (u.note === undefined || isStr(u.note));
    case 'review':
      return oneOf(REVIEW_IDS)(u.id) && isStr(u.note);
    case 'fact':
      return isStr(u.text) && isStr(u.why);
    case 'spelling':
      return isStr(u.word) && strOrNull(u.fix);
    default:
      return false;
  }
}

const isLinks = (v: unknown) => arrOf(v, (l): l is Obj => isObj(l) && isStr(l.label) && isStr(l.url));

function isCv(cv: unknown): boolean {
  if (!isObj(cv) || !isStr(cv.name) || !isStr(cv.headline) || !isStr(cv.summary) || !strOrNull(cv.workRights)) return false;
  const c = cv.contact;
  if (!isObj(c) || !strOrNull(c.location) || !strOrNull(c.email) || !strOrNull(c.phone) || !isLinks(c.links)) return false;
  return (
    (cv.competencies === undefined || isStrArr(cv.competencies)) &&
    arrOf(cv.skills, (s): s is Obj => isObj(s) && isStr(s.group) && isStrArr(s.items)) &&
    arrOf(
      cv.experience,
      (e): e is Obj => isObj(e) && isStr(e.title) && isStr(e.employer) && strOrNull(e.location) && isStr(e.dates) && isStrArr(e.bullets) && (e.achievements === undefined || isStrArr(e.achievements)),
    ) &&
    arrOf(
      cv.education,
      (e): e is Obj => isObj(e) && isStr(e.qualification) && isStr(e.institution) && isStr(e.dates) && isStr(e.statusText),
    ) &&
    arrOf(cv.projects, (p): p is Obj => isObj(p) && isStr(p.name) && isStrArr(p.bullets))
  );
}

const isLetter = (l: unknown): boolean =>
  isObj(l) &&
  isStr(l.date) &&
  isStr(l.addressee) &&
  isStr(l.salutation) &&
  isStrArr(l.paragraphs) &&
  isStr(l.signOff) &&
  isStr(l.name);

function isReasons(r: unknown): boolean {
  return (
    isObj(r) &&
    isStr(r.templateReason) &&
    arrOf(r.changes, (c): c is Obj => isObj(c) && isStr(c.target) && isStr(c.what) && isStr(c.why)) &&
    arrOf(r.stretches, (c): c is Obj => isObj(c) && isStr(c.target) && isStr(c.text) && isStr(c.why)) &&
    arrOf(
      r.factRulings,
      (f): f is Obj => isObj(f) && isStr(f.text) && oneOf(['honest_rephrase', 'invented'])(f.ruling) && isStr(f.why),
    ) &&
    (r.fit === undefined || (isObj(r.fit) && isStrArr(r.fit.droppedProjects))) &&
    (r.criteriaCoverage === undefined ||
      arrOf(r.criteriaCoverage, (c): c is Obj => isObj(c) && isStr(c.criterion) && isStr(c.answeredIn) && isStr(c.why)))
  );
}

function isVersion(v: unknown): boolean {
  if (v === null) return true;
  if (!isObj(v)) return false;
  const k = v.keywordCoverage;
  const r = v.review;
  return (
    isStr(v.id) &&
    isNum(v.versionNo) &&
    isStr(v.label) &&
    isOrigin(v.origin) &&
    strOrNull(v.parentVersionId) &&
    arrOf(v.manualEdits, (e): e is unknown => isStr(e) || (isObj(e) && isStr(e.path) && strOrNull(e.text))) &&
    typeof v.isCurrent === 'boolean' &&
    isStr(v.createdAt) &&
    isStr(v.templateId) &&
    isCv(v.cv) &&
    isLetter(v.coverLetter) &&
    isReasons(v.reasons) &&
    isObj(k) &&
    isStrArr(k.covered) &&
    arrOf(k.missing, (m): m is Obj => isObj(m) && isStr(m.keyword) && isStr(m.why)) &&
    isObj(r) &&
    typeof r.passed === 'boolean' &&
    (r.reviewedVersionNo === undefined || isNum(r.reviewedVersionNo)) &&
    isNum(r.rounds) &&
    arrOf(r.verdicts, oneOf(['pass', 'fail']) as (x: unknown) => x is string) &&
    arrOf(r.unresolved, (u): u is Obj => isUnresolved(u)) &&
    arrOf(v.checks, (c): c is Obj => isCheck(c)) &&
    strOrNull(v.baseCvSourceRef) &&
    isNum(v.costUsd)
  );
}

const isBaseCv = (b: unknown): boolean =>
  b === null || (isObj(b) && isObj(b.structured) && strOrNull(b.sourceRef) && typeof b.isCurrentBase === 'boolean');

export function parseVersionList(body: unknown): VersionSummary[] | null {
  if (!isObj(body) || !Array.isArray(body.versions)) return null;
  const ok = body.versions.every(
    (v) =>
      isObj(v) &&
      isStr(v.id) &&
      isNum(v.versionNo) &&
      isStr(v.label) &&
      isOrigin(v.origin) &&
      isStr(v.createdAt) &&
      strOrNull(v.instruction) &&
      (v.passed === null || typeof v.passed === 'boolean') &&
      isNum(v.hardChecks) &&
      typeof v.manualEdit === 'boolean',
  );
  return ok ? (body.versions as VersionSummary[]) : null;
}

export function parseJobDetail(body: unknown): JobDetail | null {
  if (
    !isObj(body) ||
    !isJob(body.job) ||
    !isGeneration(body.generation) ||
    !('version' in body) ||
    !isVersion(body.version) ||
    !isNum(body.versions) ||
    !isBaseCv(body.baseCv)
  ) {
    return null;
  }
  const detail = body as unknown as JobDetail;
  for (const k of ['suggestedTemplate', 'templateReason', 'templateChoice'] as const) detail.job[k] = detail.job[k] ?? null;
  if (detail.version) detail.version.manualEdits = readManualEdits(detail.version.manualEdits as unknown[], detail.version);
  return detail;
}

// An old version's manual edits were paths only: read as the text at that path now (a path that is gone is dropped).
function readManualEdits(raw: unknown[], v: { cv: unknown; coverLetter: unknown }): ManualEdit[] {
  const docs = { cv: v.cv, coverLetter: v.coverLetter };
  const out: ManualEdit[] = [];
  for (const e of raw) {
    if (isStr(e)) {
      const at = valueAt(docs, e);
      if (at.found && (isStr(at.value) || at.value === null)) out.push({ path: e, text: at.value });
    } else if (isObj(e)) {
      out.push({ path: e.path as string, text: e.text as string | null });
    }
  }
  return out;
}
