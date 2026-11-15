import type { TailoredCv } from '../generation/types.js';
import { LAYOUT_STEPS, type CvLayout } from '../templates/layout.js';

export type Measure = (cv: TailoredCv, layout: CvLayout) => Promise<{ pages: number; text: string }>;
export type ManualEdit = { path: string; text: string | null };

const FLOOR = LAYOUT_STEPS.length - 1;

// The first (largest) layout step that puts the CV on the page limit; if none does, the floor's result.
export async function fitLayout(
  cv: TailoredCv,
  measure: Measure,
  maxPages = 1,
): Promise<{ layout: CvLayout; step: number; pages: number; text: string }> {
  let last = { pages: 0, text: '' };
  for (let step = 0; step < LAYOUT_STEPS.length; step++) {
    last = await measure(cv, LAYOUT_STEPS[step]);
    if (last.pages <= maxPages) return { layout: LAYOUT_STEPS[step], step, ...last };
  }
  return { layout: LAYOUT_STEPS[FLOOR], step: FLOOR, ...last };
}

// Highest project index that holds one of Prayush's manual edits (by path, or by text equal to its name or a bullet); -1 if none.
function highestLocked(cv: TailoredCv, edits: ManualEdit[]): number {
  let highest = -1;
  cv.projects.forEach((p, i) => {
    const prefix = `cv.projects[${i}]`;
    const owned = new Set([p.name, ...p.bullets].filter((t) => t.trim() !== ''));
    const locked = edits.some(
      (e) =>
        e.path === prefix ||
        e.path.startsWith(`${prefix}.`) ||
        e.path.startsWith(`${prefix}[`) ||
        (typeof e.text === 'string' && e.text.trim() !== '' && owned.has(e.text)),
    );
    if (locked) highest = i;
  });
  return highest;
}

// Fits the CV to its page limit: the layout ladder first, then dropping the last (least relevant) projects that carry no manual edit.
export async function fitCv(
  cv: TailoredCv,
  manualEdits: ManualEdit[],
  measure: Measure,
  maxPages = 1,
): Promise<{ cv: TailoredCv; layout: CvLayout; step: number; pages: number; text: string; droppedProjects: string[] }> {
  const first = await fitLayout(cv, measure, maxPages);
  if (first.pages <= maxPages) return { cv, ...first, droppedProjects: [] };

  const lockedUpTo = highestLocked(cv, manualEdits);
  const dropped: string[] = [];
  let projects = cv.projects;
  while (projects.length - 1 > lockedUpTo) {
    dropped.push(projects[projects.length - 1].name);
    projects = projects.slice(0, -1);
    const trimmed = { ...cv, projects };
    const atFloor = await measure(trimmed, LAYOUT_STEPS[FLOOR]);
    if (atFloor.pages <= maxPages) {
      const fitted = await fitLayout(trimmed, measure, maxPages);
      return { cv: trimmed, ...fitted, droppedProjects: dropped };
    }
  }
  return { cv, ...first, droppedProjects: [] };
}


