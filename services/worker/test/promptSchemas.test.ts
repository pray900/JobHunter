import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runChecks } from '../src/generation/checks.js';
import { validateTailoredCv, validateTailoredLetter } from '../src/generation/validate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const schema = (name: string) => JSON.parse(readFileSync(path.join(root, 'n8n/prompts', name), 'utf8'));
const PORT = 58099;

let stub: ChildProcess;
const ask = async (purpose: string): Promise<any> => {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'k', 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
    body: JSON.stringify({ system: `purpose: ${purpose}\nx`, messages: [{ role: 'user', content: 'hi' }] }),
  });
  return JSON.parse(((await res.json()) as any).content[0].text);
};

beforeAll(async () => {
  stub = spawn(process.execPath, [path.join(root, 'tests/stubs/anthropic-stub/server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('stub did not start');
});
afterAll(() => void stub?.kill());

describe('writer prompt schema and the stub answer', () => {
  test('the stub writer answer passes the document validators', async () => {
    const a = await ask('write_documents');
    expect(() => validateTailoredCv(a.cv)).not.toThrow();
    expect(() => validateTailoredLetter(a.coverLetter)).not.toThrow();
  });

  test('the stub writer answer passes the strict code checks against the stub CV facts', async () => {
    const a = await ask('write_documents');
    const base = await ask('analyse_cv');
    const { checks } = await runChecks(
      {
        templateId: 'standard-ats',
        cv: validateTailoredCv(a.cv),
        coverLetter: validateTailoredLetter(a.coverLetter),
        keywordsCovered: a.keywordCoverage.covered,
        job: { title: 'Stub Title', employer: 'Stub Employer', advertiser: null, rawText: 'We need a TypeScript engineer.' },
        baseCv: { structured: base },
        baseCoverLetter: null,
        otherJobs: [],
      },
      { gotenbergUrl: 'http://unused', configDir: path.join(root, 'config'), render: async () => ({ pages: 1, text: 'Stub Person SUMMARY SKILLS EXPERIENCE PROJECTS EDUCATION' }) },
    );
    expect(checks.filter((c) => c.severity === 'hard')).toEqual([]);
  });

  test('schema cv and coverLetter properties are exactly the TailoredCv and TailoredLetter fields', () => {
    const p = schema('write-documents.schema.json').properties;
    expect(Object.keys(p.cv.properties).sort()).toEqual(
      ['name', 'headline', 'contact', 'summary', 'workRights', 'skills', 'experience', 'education', 'projects'].sort(),
    );
    expect(Object.keys(p.cv.properties.contact.properties).sort()).toEqual(['email', 'links', 'location', 'phone']);
    expect(Object.keys(p.cv.properties.experience.items.properties).sort()).toEqual(['bullets', 'dates', 'employer', 'location', 'title']);
    expect(Object.keys(p.cv.properties.education.items.properties).sort()).toEqual(['dates', 'institution', 'qualification', 'statusText']);
    expect(Object.keys(p.cv.properties.projects.items.properties).sort()).toEqual(['bullets', 'name']);
    expect(Object.keys(p.coverLetter.properties).sort()).toEqual(['addressee', 'date', 'name', 'paragraphs', 'salutation', 'signOff']);
  });

  test('every schema object is closed and requires all its properties', () => {
    const walk = (n: any, where: string) => {
      if (n && typeof n === 'object') {
        if (n.type === 'object') {
          expect(n.additionalProperties, where).toBe(false);
          expect([...n.required].sort(), where).toEqual(Object.keys(n.properties).sort());
        }
        for (const [k, v] of Object.entries(n)) walk(v, `${where}.${k}`);
      }
    };
    walk(schema('write-documents.schema.json'), 'writer');
    walk(schema('review-documents.schema.json'), 'reviewer');
  });

  test('the canned reviewer answer has the reviewer schema fields', async () => {
    const r = await ask('review_documents');
    expect(Object.keys(r).sort()).toEqual(Object.keys(schema('review-documents.schema.json').properties).sort());
  });
});
