import type { TailoredCv } from '../api/types';
import { AU_SPELLING_PAIRS } from './auSpelling';

// The base CV as the analyser stored it (n8n/prompts/analyse-cv.md). Every field may be missing.
export interface BaseCvStructured {
  headline?: string | null;
  summary?: string | null;
  roles?: { title?: string; employer?: string; dates?: string; bullets?: string[] }[];
  skills?: unknown[];
  projects?: { name?: string; bullets?: string[] }[];
}

export interface Change {
  before: string | null;
  after: string;
}

export type BulletKind = 'kept' | 'reworded' | 'added';

export interface BaseDiff {
  headline: Change;
  summary: Change;
  roles: {
    employer: string;
    title: string;
    bullets: { kind: BulletKind; text: string; baseText?: string }[];
    dropped: string[];
  }[];
  rolesDropped: string[];
  skills: { added: string[]; dropped: string[] };
  projects: { kept: string[]; dropped: string[] };
}

const US_TO_AU = new Map<string, string>(AU_SPELLING_PAIRS.map(([us, au]) => [us, au]));

/** One word, compared loosely: lower case, edge punctuation off, US spelling folded to Australian. */
function normWord(w: string): string {
  const x = w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return US_TO_AU.get(x) ?? x;
}

function words(s: string): string[] {
  return s.split(/\s+/).map(normWord).filter(Boolean);
}

const norm = (s: string): string => words(s).join(' ');
const key = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

function overlap(a: string, b: string): number {
  const wa = words(a);
  if (wa.length === 0) return 0;
  const pool = words(b);
  let hit = 0;
  for (const w of wa) {
    const at = pool.indexOf(w);
    if (at >= 0) {
      hit += 1;
      pool.splice(at, 1);
    }
  }
  return hit / wa.length;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function skillName(x: unknown): string | null {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string') return (x as { name: string }).name;
  return null;
}

export function diffAgainstBase(base: BaseCvStructured, cv: TailoredCv): BaseDiff {
  const baseRoles = (Array.isArray(base.roles) ? base.roles : []).map((r) => ({
    employer: r.employer ?? '',
    bullets: strings(r.bullets),
  }));
  const usedRoles = new Set<number>();

  const roles = cv.experience.map((role) => {
    const at = baseRoles.findIndex((r, i) => !usedRoles.has(i) && key(r.employer) === key(role.employer));
    const match = at >= 0 ? baseRoles[at]! : null;
    if (at >= 0) usedRoles.add(at);
    const pool = match ? match.bullets.map((text) => ({ text, used: false })) : [];
    const bullets: BaseDiff['roles'][number]['bullets'] = new Array(role.bullets.length);
    const rest: number[] = [];
    // Exact matches first, so a reworded bullet can't steal a bullet that another one keeps.
    role.bullets.forEach((text, i) => {
      const hit = pool.find((p) => !p.used && norm(p.text) === norm(text));
      if (hit) {
        hit.used = true;
        bullets[i] = { kind: 'kept', text };
      } else rest.push(i);
    });
    for (const i of rest) {
      const text = role.bullets[i]!;
      let best: (typeof pool)[number] | null = null;
      let bestScore = 0;
      for (const p of pool) {
        if (p.used) continue;
        const score = overlap(text, p.text);
        if (score > bestScore) {
          best = p;
          bestScore = score;
        }
      }
      if (best && bestScore >= 0.5) {
        best.used = true;
        bullets[i] = { kind: 'reworded', text, baseText: best.text };
      } else bullets[i] = { kind: 'added', text };
    }
    return { employer: role.employer, title: role.title, bullets, dropped: pool.filter((p) => !p.used).map((p) => p.text) };
  });

  const rolesDropped = baseRoles.filter((_, i) => !usedRoles.has(i)).map((r) => r.employer);

  const baseSkills = (Array.isArray(base.skills) ? base.skills : []).map(skillName).filter((s): s is string => !!s);
  const cvSkills = cv.skills.flatMap((g) => g.items);
  const baseSkillKeys = new Set(baseSkills.map(norm));
  const cvSkillKeys = new Set(cvSkills.map(norm));

  const baseProjects = (Array.isArray(base.projects) ? base.projects : []).map((p) => p.name ?? '').filter(Boolean);
  const cvProjectKeys = new Set(cv.projects.map((p) => key(p.name)));
  const baseProjectKeys = new Set(baseProjects.map(key));

  return {
    headline: { before: base.headline ?? null, after: cv.headline },
    summary: { before: base.summary ?? null, after: cv.summary },
    roles,
    rolesDropped,
    skills: {
      added: cvSkills.filter((s) => !baseSkillKeys.has(norm(s))),
      dropped: baseSkills.filter((s) => !cvSkillKeys.has(norm(s))),
    },
    projects: {
      kept: cv.projects.map((p) => p.name).filter((n) => baseProjectKeys.has(key(n))),
      dropped: baseProjects.filter((n) => !cvProjectKeys.has(key(n))),
    },
  };
}

/** Word-level diff: the words of `after`, each marked when it is not part of the longest common run with `before`. */
export function wordDiff(before: string, after: string): { text: string; changed: boolean }[] {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  const na = a.map(normWord);
  const nb = b.map(normWord);
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = na[i] === nb[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const common = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (na[i] === nb[j]) {
      common.add(j);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
    else j++;
  }
  return b.map((text, k) => ({ text, changed: !common.has(k) }));
}

export { norm as normaliseText };
