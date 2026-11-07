import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPdf } from '../../services/worker/src/render/pdf';
import { CV } from '../../services/worker/test/fixtures';
import { ROOT, run } from './lib';

// The worker has no host port: call it from inside its own container, against the real Gotenberg.
const SCRIPT = `
let body = '';
process.stdin.on('data', (c) => (body += c));
process.stdin.on('end', async () => {
  const res = await fetch('http://localhost:3001/generation/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  console.log(res.status + ' ' + Buffer.from(await res.arrayBuffer()).toString('base64'));
});`;

describe('render through gotenberg', () => {
  it('gives a 1-page PDF', async () => {
    const out = await run(
      'docker',
      ['compose', '-f', join(ROOT, 'docker-compose.test.yml'), 'exec', '-T', 'worker', 'node', '-e', SCRIPT],
      { cwd: ROOT, input: JSON.stringify({ templateId: 'standard-ats', doc: 'cv', format: 'pdf', cv: CV, coverLetter: null }) },
    );
    const [status, b64] = out.trim().split(' ');
    expect(status).toBe('200');
    const pdf = Buffer.from(b64, 'base64');
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    const { pages, text } = await readPdf(pdf);
    expect(pages).toBe(1);
    expect(text).toContain('Jordan Testcase');
    expect(text).toContain('Jan 2022 - Present');
  }, 60_000);
});
