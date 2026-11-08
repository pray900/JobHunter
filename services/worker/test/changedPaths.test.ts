import { expect, test } from 'vitest';
import { changedPaths } from '../src/generation/changedPaths.js';
import { CV, LETTER } from './fixtures.js';

const doc = { cv: CV, coverLetter: LETTER };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test('changedPaths of identical documents is empty', () => {
  expect(changedPaths(doc, clone(doc))).toEqual([]);
});

test('changedPaths finds an edited bullet, a removed bullet and an edited letter paragraph', () => {
  const after = clone(doc);
  after.cv.summary = 'A new summary';
  after.cv.experience[0].bullets[0] = 'Changed bullet';
  const removed = after.cv.experience[0].bullets.length - 1;
  after.cv.experience[0].bullets.pop();
  after.coverLetter.paragraphs[0] = 'Changed paragraph';
  const before = doc.cv.experience[0].bullets.length;
  expect(before).toBeGreaterThan(1);
  expect(changedPaths(doc, after)).toEqual(
    ['coverLetter.paragraphs[0]', 'cv.experience[0].bullets[0]', `cv.experience[0].bullets[${removed}]`, 'cv.summary'].sort(),
  );
});
