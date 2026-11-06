import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { checkBaseCoverLetter, checkBaseCv, parseBannedPhrases } from '../src/documents/checks.js';
import type { BaseCoverLetterFacts, BaseCvFacts } from '../src/documents/types.js';
import { buildServer } from '../src/server.js';

const PHRASES = ['spearheaded', 'leveraged', 'leveraging', 'proven track record', 'fast-paced', 'express my interest'];

function cvFacts(overrides: Partial<BaseCvFacts> = {}): BaseCvFacts {
  return {
    headline: 'Software Engineer',
    summary: 'Builds reliable backend services.',
    workRights: 'Full working rights (485 visa)',
    education: [
      {
        qualification: 'BSc Computer Science',
        institution: 'UNSW',
        dates: '2019 – 2022',
        statusText: 'Completed',
      },
    ],
    roles: [{ title: 'Engineer', employer: 'Acme', dates: '2022 – 2025', bullets: ['Shipped APIs'] }],
    projects: [],
    skills: ['TypeScript'],
    metrics: [],
    contact: { location: 'Sydney', email: null, phone: null, links: [] },
    ...overrides,
  };
}

function letterFacts(overrides: Partial<BaseCoverLetterFacts> = {}): BaseCoverLetterFacts {
  return {
    previousTarget: { company: 'Example Corp', addressee: 'Ms. Example', role: 'Engineer' },
    reusableParagraphs: ['I enjoy working in a team.'],
    toneNotes: 'Direct and warm.',
    ...overrides,
  };
}

const codes = (warnings: { code: string }[]) => warnings.map((w) => w.code);

describe('checkBaseCv', () => {
  test('flags missing work rights', () => {
    const warnings = checkBaseCv(cvFacts({ workRights: null }), []);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'missing_work_rights' }));
    expect(checkBaseCv(cvFacts({ workRights: '   ' }), [])).toContainEqual(
      expect.objectContaining({ code: 'missing_work_rights' }),
    );
  });

  test('accepts "Full working rights (485 visa)"', () => {
    expect(codes(checkBaseCv(cvFacts({ workRights: 'Full working rights (485 visa)' }), []))).not.toContain(
      'missing_work_rights',
    );
  });

  test('flags "2025 – Present" degree', () => {
    const facts = cvFacts({
      education: [{ qualification: 'MSc', institution: 'UTS', dates: '2025 – Present', statusText: '' }],
    });
    expect(checkBaseCv(facts, [])).toContainEqual(expect.objectContaining({ code: 'degree_status_unclear' }));
  });

  test('flags a degree with an open end date and no conferral wording', () => {
    const facts = cvFacts({
      education: [{ qualification: 'MSc', institution: 'UTS', dates: '2025 –', statusText: 'Current' }],
    });
    expect(checkBaseCv(facts, [])).toContainEqual(expect.objectContaining({ code: 'degree_status_unclear' }));
  });

  test('accepts "(conferral Nov 2026)"', () => {
    const facts = cvFacts({
      education: [
        { qualification: 'MSc', institution: 'UTS', dates: '2025 – Present', statusText: '(conferral Nov 2026)' },
      ],
    });
    expect(codes(checkBaseCv(facts, []))).not.toContain('degree_status_unclear');
  });

  test('finds "Proven track record" case-insensitively but not "proven" alone', () => {
    const withPhrase = cvFacts({ summary: 'PROVEN TRACK RECORD of delivery.' });
    expect(checkBaseCv(withPhrase, PHRASES)).toEqual([
      { code: 'banned_phrase', detail: expect.stringContaining('proven track record') },
    ]);
    const alone = cvFacts({ summary: 'A proven engineer.' });
    expect(codes(checkBaseCv(alone, PHRASES))).not.toContain('banned_phrase');
  });

  test('matches banned phrases in role bullets and reports each phrase once', () => {
    const facts = cvFacts({
      roles: [{ title: 'Engineer', employer: 'Acme', dates: '2022 – 2025', bullets: ['Spearheaded a rewrite.', 'SPEARHEADED it again.'] }],
    });
    const warnings = checkBaseCv(facts, PHRASES);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 'banned_phrase' });
    expect(warnings[0].detail).toContain('spearheaded');
  });

  test('a multi-word phrase matches across a line break or extra spaces', () => {
    const facts = cvFacts({ skills: ['A proven\ntrack   record of delivery'] });
    expect(checkBaseCv(facts, ['proven track record']).filter((w) => w.code === 'banned_phrase')).toEqual([
      { code: 'banned_phrase', detail: 'proven track record' },
    ]);
  });

  test('does not match a banned word inside a longer word', () => {
    const facts = cvFacts({ skills: ['leveraged-ish', 'unleveraged'] });
    expect(codes(checkBaseCv(facts, ['leveraged']))).toEqual(['banned_phrase']);
    expect(checkBaseCv(cvFacts({ skills: ['unleveraged'] }), ['leveraged'])).toEqual([]);
  });
});

describe('checkBaseCoverLetter', () => {
  test('finds "leveraging" and "fast-paced"', () => {
    const facts = letterFacts({
      reusableParagraphs: ['I am leveraging my skills in a fast-paced team.'],
    });
    const warnings = checkBaseCoverLetter(facts, PHRASES);
    expect(warnings.map((w) => w.detail).join(' ')).toMatch(/leveraging/);
    expect(warnings.map((w) => w.detail).join(' ')).toMatch(/fast-paced/);
    expect(codes(warnings)).toEqual(['banned_phrase', 'banned_phrase']);
  });

  test('does not run work-rights or degree checks', () => {
    expect(codes(checkBaseCoverLetter(letterFacts(), PHRASES))).toEqual([]);
  });
});

describe('parseBannedPhrases', () => {
  test('ignores blank lines and # comments, trims, and keeps spacing in phrases', () => {
    expect(parseBannedPhrases('# header\n\n  spearheaded  \nproven track record\r\n# note\n')).toEqual([
      'spearheaded',
      'proven track record',
    ]);
  });
});

describe('POST /documents/checks', () => {
  let root: string;
  let phrasesFile: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'docchecks-'));
    phrasesFile = path.join(root, 'banned-phrases.txt');
    await fs.writeFile(phrasesFile, '# test list\nspearheaded\nproven track record\n');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const app = () =>
    buildServer({ jobFolderDir: root, documentsDir: root, bannedPhrasesFile: phrasesFile });

  test('returns the warnings for a CV', async () => {
    const a = app();
    const res = await a.inject({
      method: 'POST',
      url: '/documents/checks',
      payload: { kind: 'cv', facts: cvFacts({ workRights: null, summary: 'Proven track record.' }) },
    });
    await a.close();
    expect(res.statusCode).toBe(200);
    expect(res.json().warnings.map((w: { code: string }) => w.code)).toEqual([
      'missing_work_rights',
      'banned_phrase',
    ]);
  });

  test('returns the warnings for a cover letter', async () => {
    const a = app();
    const res = await a.inject({
      method: 'POST',
      url: '/documents/checks',
      payload: { kind: 'cover_letter', facts: letterFacts({ toneNotes: 'Spearheaded tone.' }) },
    });
    await a.close();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      warnings: [expect.objectContaining({ code: 'banned_phrase' })],
    });
  });

  test('unknown kind -> 400 bad_request', async () => {
    const a = app();
    const res = await a.inject({ method: 'POST', url: '/documents/checks', payload: { kind: 'resume', facts: {} } });
    await a.close();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'bad_request' });
  });

  test('missing banned-phrases file -> 500 without a stack trace in the body', async () => {
    const a = buildServer({
      jobFolderDir: root,
      documentsDir: root,
      bannedPhrasesFile: path.join(root, 'nope.txt'),
    });
    const res = await a.inject({
      method: 'POST',
      url: '/documents/checks',
      payload: { kind: 'cv', facts: cvFacts() },
    });
    await a.close();
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'document_checks_failed' });
  });
});
