import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parseJobDocx } from '../src/jobs/parseJobDocx.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.JOBLISTING_DIR ?? path.resolve(here, '../../../Joblisting');
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.docx') && !f.startsWith('~$')) : [];

describe.skipIf(files.length === 0)('real job files', () => {
  test.each(files.map((f, i) => [i + 1, f] as const))('file #%i parses to an http(s) URL and a non-empty body', async (_n, file) => {
    const r = await parseJobDocx(readFileSync(path.join(dir, file)));
    expect(/^https?:\/\/\S+$/.test(r.url ?? '')).toBe(true);
    expect(r.body.length > 0).toBe(true);
    expect(r.warnings).toEqual([]);
  });
});
