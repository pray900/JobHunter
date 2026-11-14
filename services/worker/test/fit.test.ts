import { describe, expect, test } from 'vitest';
import { fitCv, fitLayout, type Measure } from '../src/render/fit.js';
import { LAYOUT_STEPS } from '../src/templates/layout.js';
import type { TailoredCv } from '../src/generation/types.js';
import { CV } from './fixtures.js';

const cvWith = (n: number): TailoredCv => ({
  ...CV,
  projects: Array.from({ length: n }, (_, i) => ({ name: `Project ${i}`, bullets: [`Bullet a${i}`, `Bullet b${i}`] })),
});
const idx = (l: (typeof LAYOUT_STEPS)[number]) => LAYOUT_STEPS.indexOf(l);

// pages(step, projectCount); counts calls.
const fake = (rule: (step: number, projects: number) => number) => {
  const calls: { step: number; projects: number }[] = [];
  const measure: Measure = async (cv, layout) => {
    calls.push({ step: idx(layout), projects: cv.projects.length });
    return { pages: rule(idx(layout), cv.projects.length), text: 't' };
  };
  return { measure, calls };
};
const FLOOR = LAYOUT_STEPS.length - 1;

describe('fitLayout', () => {
  test('first step that fits', async () => {
    const { measure, calls } = fake((s) => (s >= 3 ? 1 : 2));
    const r = await fitLayout(CV, measure);
    expect(r.step).toBe(3);
    expect(r.layout).toBe(LAYOUT_STEPS[3]);
    expect(calls).toHaveLength(4);
  });
  test('floor result when nothing fits', async () => {
    const { measure } = fake(() => 2);
    const r = await fitLayout(CV, measure);
    expect(r.step).toBe(FLOOR);
    expect(r.pages).toBe(2);
  });
});

describe('fitCv', () => {
  test('fits at step 0', async () => {
    const { measure, calls } = fake(() => 1);
    const cv = cvWith(3);
    const r = await fitCv(cv, [], measure);
    expect(r.step).toBe(0);
    expect(calls).toHaveLength(1);
    expect(r.droppedProjects).toEqual([]);
    expect(r.cv).toEqual(cv);
  });

  test('fits at step 3 without dropping', async () => {
    const { measure } = fake((s) => (s >= 3 ? 1 : 2));
    const r = await fitCv(cvWith(3), [], measure);
    expect(r.step).toBe(3);
    expect(r.droppedProjects).toEqual([]);
    expect(r.cv.projects).toHaveLength(3);
  });

  test('drops the last two projects, then picks the best step for the trimmed CV', async () => {
    // 5 projects never fit; 3 projects fit from step 2 up.
    const { measure, calls } = fake((s, n) => (n <= 3 && s >= 2 ? 1 : 2));
    const r = await fitCv(cvWith(5), [], measure);
    expect(r.droppedProjects).toEqual(['Project 4', 'Project 3']);
    expect(r.cv.projects.map((p) => p.name)).toEqual(['Project 0', 'Project 1', 'Project 2']);
    expect(r.step).toBe(2);
    expect(calls.length).toBeLessThanOrEqual(LAYOUT_STEPS.length + 2 + LAYOUT_STEPS.length);
  });

  test('locked last project by path: nothing dropped, pages > 1', async () => {
    const { measure } = fake(() => 2);
    const r = await fitCv(cvWith(5), [{ path: 'cv.projects[4].bullets[0]', text: 'x' }], measure);
    expect(r.droppedProjects).toEqual([]);
    expect(r.pages).toBe(2);
    expect(r.cv.projects).toHaveLength(5);
  });

  test('locked last project by text equal to a bullet', async () => {
    const { measure } = fake((_s, n) => (n < 5 ? 1 : 2));
    const r = await fitCv(cvWith(5), [{ path: 'cv.summary', text: 'Bullet b4' }], measure);
    expect(r.droppedProjects).toEqual([]);
    expect(r.pages).toBe(2);
  });

  test('null edit text locks nothing by text', async () => {
    const { measure } = fake((_s, n) => (n < 5 ? 1 : 2));
    const r = await fitCv(cvWith(5), [{ path: 'cv.summary', text: null }], measure);
    expect(r.droppedProjects).toEqual(['Project 4']);
  });

  test('locked project 2 of 5: only 4 then 3 may go', async () => {
    const { measure } = fake((_s, n) => (n <= 1 ? 1 : 2));
    const r = await fitCv(cvWith(5), [{ path: 'cv.projects[2]', text: null }], measure);
    // Dropping 4 and 3 still leaves 3 projects: never fits, original returned.
    expect(r.droppedProjects).toEqual([]);
    expect(r.cv.projects).toHaveLength(5);
    expect(r.pages).toBe(2);

    const ok = fake((_s, n) => (n <= 3 ? 1 : 2));
    const r2 = await fitCv(cvWith(5), [{ path: 'cv.projects[2]', text: null }], ok.measure);
    expect(r2.droppedProjects).toEqual(['Project 4', 'Project 3']);
    expect(r2.cv.projects.map((p) => p.name)).toEqual(['Project 0', 'Project 1', 'Project 2']);
  });

  test('still 2 pages after every droppable project is dropped: original CV at the floor', async () => {
    const { measure, calls } = fake(() => 2);
    const cv = cvWith(3);
    const r = await fitCv(cv, [], measure);
    expect(r.cv).toEqual(cv);
    expect(r.droppedProjects).toEqual([]);
    expect(r.step).toBe(FLOOR);
    expect(r.pages).toBe(2);
    expect(calls.length).toBeLessThanOrEqual(LAYOUT_STEPS.length + 3 + LAYOUT_STEPS.length);
  });
});
