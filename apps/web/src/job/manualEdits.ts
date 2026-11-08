import type { ManualEdit } from '../api/types';

// Manual edits are kept by text: an edit is where its text is, at its path or moved within the same list
// (a reordered bullet). The same rule as the workflows (generate-documents, versions-api, job-page-api).

const parts = (p: string) => p.match(/[^.[\]]+|\[\d+\]/g) ?? [];

export function valueAt(docs: unknown, path: string): { found: boolean; value?: unknown } {
  const ps = parts(path);
  if (ps.length === 0) return { found: false };
  let x: unknown = docs;
  for (const part of ps) {
    if (part.startsWith('[')) {
      const i = Number(part.slice(1, -1));
      if (!Array.isArray(x) || i >= x.length) return { found: false };
      x = x[i];
    } else {
      if (typeof x !== 'object' || x === null || Array.isArray(x) || !Object.prototype.hasOwnProperty.call(x, part)) return { found: false };
      x = (x as Record<string, unknown>)[part];
    }
  }
  return { found: true, value: x };
}

const listOf = (p: string) => (/\[\d+\]$/.test(p) ? p.replace(/\[\d+\]$/, '') : null);

/** The paths where Prayush's edits are in these documents (an edit whose text is gone is left out). */
export function editedPaths(edits: ManualEdit[], docs: { cv: unknown; coverLetter: unknown }): Set<string> {
  const here = edits.map((e) => {
    const at = valueAt(docs, e.path);
    return at.found && at.value === e.text;
  });
  const used = new Set(edits.filter((_, i) => here[i]).map((e) => e.path));
  edits.forEach((e, i) => {
    if (here[i] || typeof e.text !== 'string') return;
    const list = listOf(e.path);
    const items = list ? valueAt(docs, list) : { found: false };
    if (!items.found || !Array.isArray(items.value)) return;
    const j = (items.value as unknown[]).findIndex((v, k) => v === e.text && !used.has(`${list}[${k}]`));
    if (j >= 0) used.add(`${list}[${j}]`);
  });
  return used;
}
