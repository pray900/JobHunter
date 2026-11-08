import type { TailoredCv, TailoredLetter } from './types.js';

export interface DocumentPair {
  cv: TailoredCv;
  coverLetter: TailoredLetter;
}

function walk(a: unknown, b: unknown, path: string, out: string[]): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path ? `${path}.${k}` : k, out);
    return;
  }
  if (a === b) return;
  // An added or removed array item is a leaf difference at its index path; a whole added/removed
  // subtree is reported as the single path of that item.
  out.push(path);
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

// Dotted paths of every leaf that differs between two versions, sorted.
export function changedPaths(before: DocumentPair, after: DocumentPair): string[] {
  const out: string[] = [];
  walk({ cv: before.cv, coverLetter: before.coverLetter }, { cv: after.cv, coverLetter: after.coverLetter }, '', out);
  return out.sort();
}
