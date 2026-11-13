import { describe, expect, test } from 'vitest';
import type { BaseCoverLetterFacts, BaseCvFacts } from '../src/documents/types.js';
import { normaliseBaseFacts, sameAsBase, validateFacts } from '../src/documents/validateFacts.js';

// Invented person.
const cv = (): BaseCvFacts => ({
  name: 'Jordan Testcase',
  headline: 'Backend Engineer',
  summary: 'Ships reliable services.',
  workRights: 'Australian citizen',
  education: [{ qualification: 'BSc', institution: 'Example University', dates: '2018 - 2021', statusText: 'Completed' }],
  roles: [
    { title: 'Engineer', employer: 'Acme', dates: '2022 - 2025', bullets: ['Built an invoicing service.'] },
    { title: 'Intern', employer: 'Beta', dates: '2021', bullets: ['Wrote tests.'] },
    { title: 'Dev', employer: 'Gamma', dates: '2020', bullets: ['Fixed bugs.'] },
  ],
  projects: [{ name: 'Side Project', bullets: ['Small CLI tool.'] }],
  skills: ['TypeScript', 'SQL'],
  metrics: ['Cut report time by half'],
  contact: { location: 'Sydney', email: 'jordan@example.com', phone: null, links: ['https://example.com/jordan'] },
});
const letter = (): BaseCoverLetterFacts => ({
  previousTarget: { company: 'Acme', addressee: null, role: 'Engineer' },
  reusableParagraphs: ['I enjoy teamwork.'],
  toneNotes: 'Direct.',
});
const bad = (kind: 'cv' | 'cover_letter', input: unknown) => {
  const r = validateFacts(kind, input);
  return r.ok ? null : r.path;
};

describe('validateFacts', () => {
  test('accepts analysed CV facts unchanged', () => {
    expect(validateFacts('cv', cv())).toEqual({ ok: true, facts: cv() });
  });
  test('accepts letter facts', () => {
    expect(validateFacts('cover_letter', letter())).toEqual({ ok: true, facts: letter() });
  });
  test('trims, nulls blank nullable fields, drops blank list entries', () => {
    const input = cv();
    input.name = '  Jordan  ';
    input.headline = '   ';
    input.contact.email = '';
    input.skills = [' TypeScript ', '', '  '];
    input.roles[0].bullets = ['  ', ' Kept '];
    input.roles[0].title = '  Engineer ';
    const r = validateFacts('cv', input);
    expect(r.ok && r.facts).toMatchObject({
      name: 'Jordan',
      headline: null,
      contact: { email: null },
      skills: ['TypeScript'],
      roles: [{ title: 'Engineer', bullets: ['Kept'] }, {}, {}],
    });
  });
  test('rejects extra keys', () => {
    expect(bad('cv', { ...cv(), extra: 1 })).toBe('facts.extra');
    const input = cv();
    (input.roles[2] as unknown as Record<string, unknown>).salary = '1';
    expect(bad('cv', input)).toBe('facts.roles[2].salary');
  });
  test('rejects extra keys named like inherited Object.prototype members', () => {
    expect(bad('cv', { ...cv(), constructor: 1 })).toBe('facts.constructor');
    expect(bad('cv', { ...cv(), toString: 1 })).toBe('facts.toString');
    const parsed = JSON.parse(JSON.stringify(cv()).replace(/^\{/, '{"__proto__":1,'));
    expect(bad('cv', parsed)).toBe('facts.__proto__');
  });
  test('rejects a list over 100 items', () => {
    const input = cv();
    input.skills = Array.from({ length: 101 }, (_, i) => `s${i}`);
    expect(bad('cv', input)).toBe('facts.skills');
  });
  test('rejects a string over 4000 characters', () => {
    const input = cv();
    input.roles[2].bullets[0] = 'x'.repeat(4001);
    expect(bad('cv', input)).toBe('facts.roles[2].bullets[0]');
    expect(validateFacts('cv', { ...cv(), summary: 'x'.repeat(4000) }).ok).toBe(true);
  });
  test('rejects NUL', () => {
    const input = letter();
    input.reusableParagraphs = ['fine', 'bad\0here'];
    expect(bad('cover_letter', input)).toBe('facts.reusableParagraphs[1]');
  });
  test('rejects a number where text belongs', () => {
    const input = cv() as unknown as Record<string, unknown>;
    input.headline = 5;
    expect(bad('cv', input)).toBe('facts.headline');
    expect(bad('cover_letter', { ...letter(), toneNotes: 7 })).toBe('facts.toneNotes');
  });
  test('rejects a missing field', () => {
    const { summary: _s, ...rest } = cv();
    expect(bad('cv', rest)).toBe('facts.summary');
    expect(bad('cover_letter', { ...letter(), previousTarget: { company: null, addressee: null } })).toBe(
      'facts.previousTarget.role',
    );
  });
  test('rejects a body that is not an object', () => {
    expect(bad('cv', null)).toBe('facts');
    expect(bad('cv', [])).toBe('facts');
    expect(bad('cv', 'x')).toBe('facts');
  });
});

describe('sameAsBase (lenient normaliser for the file facts)', () => {
  const edited = (kind: 'cv' | 'cover_letter', input: unknown) => {
    const r = validateFacts(kind, input);
    if (!r.ok) throw new Error(r.path);
    return r.facts;
  };
  test('raw base with blank phone, padded strings and a blank bullet equals its cleaned form', () => {
    const raw: any = cv();
    raw.contact.phone = '';
    raw.headline = '  Backend Engineer \n';
    raw.roles[0].bullets = ['Built an invoicing service.  ', '   '];
    raw.skills = [' TypeScript', 'SQL', ''];
    expect(sameAsBase('cv', edited('cv', cv()), raw)).toBe(true);
    // The form sends the cleaned facts back unchanged: still the same.
    expect(sameAsBase('cv', edited('cv', normaliseBaseFacts('cv', raw)), raw)).toBe(true);
  });
  test('one changed field is not the same', () => {
    expect(sameAsBase('cv', edited('cv', { ...cv(), headline: 'Platform Engineer' }), cv())).toBe(false);
    const l = letter();
    expect(sameAsBase('cover_letter', edited('cover_letter', { ...l, toneNotes: 'Warm.' }), l)).toBe(false);
    expect(sameAsBase('cover_letter', edited('cover_letter', l), { ...l, toneNotes: ' Direct. ' })).toBe(true);
  });
  test('a base over the limits or oddly shaped never throws', () => {
    const huge: any = cv();
    huge.skills = Array.from({ length: 10_000 }, (_, i) => `skill ${i}`);
    huge.summary = 'x'.repeat(50_000);
    expect(() => normaliseBaseFacts('cv', huge)).not.toThrow();
    expect(sameAsBase('cv', edited('cv', cv()), huge)).toBe(false);
    for (const odd of [null, 'text', 42, [], { ...cv(), roles: 'none', contact: null, extra: 1 }]) {
      expect(() => normaliseBaseFacts('cv', odd)).not.toThrow();
      expect(sameAsBase('cv', edited('cv', cv()), odd)).toBe(false);
    }
    // Keys outside the schema are left out of the comparison.
    expect(sameAsBase('cv', edited('cv', cv()), { ...cv(), confidence: 0.9 })).toBe(true);
  });
});
