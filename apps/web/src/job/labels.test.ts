// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { TEMPLATE_NAMES, CHECK_CODES, REVIEW_ITEM_IDS, checkLabel, reviewItemLabel } from './labels';

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

test('every CheckCode in checks.ts has a label', () => {
  const src = read('../../../../services/worker/src/generation/checks.ts');
  const block = /export type CheckCode =([^;]+);/.exec(src)![1]!;
  const codes = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  expect(codes.length).toBeGreaterThan(10);
  for (const c of codes) {
    expect(CHECK_CODES, c).toContain(c);
    expect(checkLabel(c as never).length, c).toBeGreaterThan(3);
  }
  expect(CHECK_CODES.length).toBe(codes.length);
});

test('every reviewer item id in the schema has a label', () => {
  const schema = JSON.parse(read('../../../../n8n/prompts/review-documents.schema.json')) as {
    properties: { items: { items: { properties: { id: { enum: string[] } } } } };
  };
  const ids = schema.properties.items.items.properties.id.enum;
  for (const id of ids) {
    expect(REVIEW_ITEM_IDS, id).toContain(id);
    expect(reviewItemLabel(id as never).length, id).toBeGreaterThan(3);
  }
  expect(REVIEW_ITEM_IDS.length).toBe(ids.length);
});

test('labels the spec calls out', () => {
  expect(checkLabel('cv_pages')).toBe('CV is longer than 1 page');
  expect(checkLabel('unknown_fact')).toBe('Not in your base CV');
  expect(checkLabel('work_rights_dropped')).toBe('Work-rights line left out');
  expect(checkLabel('missing_work_rights')).toBe('Your base CV has no work-rights line');
  expect(checkLabel('manual_edit_changed')).toBe('Your edit was changed');
});

test('cv_pages names the template page limit', () => {
  expect(checkLabel('cv_pages', 'standard-ats')).toBe('CV is longer than 1 page');
  expect(checkLabel('cv_pages', 'au-government')).toBe('CV is longer than 2 pages');
  expect(checkLabel('letter_pages', 'au-government')).toBe('Cover letter is longer than 2 pages');
});

test('long_paragraph has a label', () => {
  expect(checkLabel('long_paragraph')).toBe('Paragraph over 40 words');
});

test('government labels', () => {
  expect(checkLabel('criteria_coverage')).toBe('Selection criteria answer not found');
  expect(reviewItemLabel('selection_criteria')).toBe('Selection criteria');
  expect(TEMPLATE_NAMES['au-government']).toBe('Australian Government');
});
