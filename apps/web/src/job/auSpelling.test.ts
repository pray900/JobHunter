// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { AU_SPELLING_PAIRS } from './auSpelling';

test('the copied spelling pairs match config/au-spelling.txt', () => {
  const file = fileURLToPath(new URL('../../../../config/au-spelling.txt', import.meta.url));
  const pairs = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/).slice(0, 2));
  expect(AU_SPELLING_PAIRS).toEqual(pairs);
});
