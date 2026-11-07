import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { runChecks, type CheckInput, type CheckResult, type RunOptions } from '../src/generation/checks.js';
import type { TailoredCv, TailoredLetter } from '../src/generation/types.js';
import { CV, LETTER } from './fixtures.js';

const configDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../config');

// Invented base CV; the tailored CV below only says things this one says.
const baseStructured = {
  name: 'Jordan Testcase',
  headline: 'Backend Engineer',
  summary: 'Engineer with 3+ years building services.',
  workRights: 'Australian citizen',
  education: [{ qualification: 'BSc Computer Science', institution: 'Example University', dates: '2018 - 2021', statusText: 'Completed' }],
  roles: [
    {
      title: 'Software Engineer',
      employer: 'Acme Pty Ltd',
      dates: 'Mar 2022 - Dec 2024',
      bullets: ['Built an invoicing service.', 'Cut report time by 40%.'],
    },
  ],
  projects: [{ name: 'Side Project', bullets: ['Small CLI tool.'] }],
  skills: ['TypeScript', 'SQL', 'Salesforce', 'Reporting'],
  metrics: ['3+ years building services', 'Cut report time by 40%'],
  contact: { location: 'Sydney NSW', email: 'jordan@example.com', phone: '0400 000 000', links: [] },
};

const goodCv: TailoredCv = {
  ...CV,
  summary: 'Engineer with 3+ years building services.',
  experience: [
    {
      title: 'Software Engineer',
      employer: 'Acme Pty Ltd',
      location: 'Sydney',
      dates: 'Mar 2022 – Dec 2024',
      bullets: ['Built an invoicing service.', 'Cut report time by 40%.'],
    },
  ],
  skills: [{ group: 'Languages', items: ['TypeScript', 'SQL'] }],
};

// A render stub whose text has the heading order and name, like the real PDF.
const okRender: NonNullable<RunOptions['render']> = async (doc, _docx, cv) => ({
  pages: 1,
  text:
    doc === 'cv'
      ? `${cv.name}\nSUMMARY\nx\nSKILLS\nx\nEXPERIENCE\nx\nPROJECTS\nx\nEDUCATION\nx`
      : `${cv.name}\nDear Hiring Manager`,
});

const okFetch = (async () => new Response('', { status: 200 })) as typeof fetch;
const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  gotenbergUrl: 'http://gotenberg.test',
  configDir,
  render: okRender,
  fetch: okFetch,
  ...over,
});

const input = (over: Partial<CheckInput> = {}): CheckInput => ({
  templateId: 'standard-ats',
  cv: goodCv,
  coverLetter: LETTER,
  keywordsCovered: [],
  job: { title: 'Platform Engineer', employer: 'Newco', advertiser: null, rawText: 'We need a platform engineer at Newco.' },
  baseCv: { structured: baseStructured },
  baseCoverLetter: null,
  otherJobs: [],
  ...over,
});

const letter = (paragraphs: string[]): TailoredLetter => ({ ...LETTER, paragraphs });
const codes = (r: { checks: CheckResult[] }) => r.checks.map((c) => c.code);
const find = (r: { checks: CheckResult[] }, code: string) => r.checks.filter((c) => c.code === code);

describe('runChecks', () => {
  test('an honest CV and letter pass with no hard checks', async () => {
    const r = await runChecks(input(), opts());
    expect(r.checks.filter((c) => c.severity === 'hard')).toEqual([]);
    expect(r.cvPages).toBe(1);
    expect(r.letterPages).toBe(1);
  });

  test('page limits are hard fails', async () => {
    const render: NonNullable<RunOptions['render']> = async (doc, d, cv, l) =>
      doc === 'cv' ? { pages: 2, text: (await okRender(doc, d, cv, l)).text } : { pages: 3, text: `${cv.name}` };
    const r = await runChecks(input(), opts({ render }));
    expect(find(r, 'cv_pages')[0]).toMatchObject({ severity: 'hard', doc: 'cv' });
    expect(find(r, 'letter_pages')[0]).toMatchObject({ severity: 'hard', doc: 'cover_letter' });
  });

  test.each([['[Company name]'], ['{{company}}'], ['Improved speed by XX%'], ['Lorem ipsum dolor'], ['Salary TBD'], ['Hello <hiring manager>']])(
    'placeholder variants are hard fails: %s',
    async (text) => {
      const r = await runChecks(input({ coverLetter: letter([text]) }), opts());
      expect(find(r, 'placeholder')[0]).toMatchObject({ severity: 'hard', doc: 'cover_letter' });
    },
  );

  test('previous target is leakage', async () => {
    const base = { structured: { previousTarget: { company: 'Oldco Pty', addressee: 'Ms. Quill', role: 'Data Lead' }, reusableParagraphs: [], toneNotes: '' } };
    const r = await runChecks(
      input({
        baseCoverLetter: base,
        coverLetter: { ...LETTER, addressee: 'Ms. Quill', paragraphs: ['I would love to join Oldco Pty.'] },
      }),
      opts(),
    );
    const leaks = find(r, 'company_leakage');
    expect(leaks.every((l) => l.severity === 'hard')).toBe(true);
    expect(leaks.map((l) => l.where)).toEqual(expect.arrayContaining(['coverLetter.addressee', 'coverLetter.paragraphs[0]']));
  });

  test('previous role and other jobs titles are title_leakage; other employers are company_leakage', async () => {
    const base = { structured: { previousTarget: { company: 'Oldco Pty', addressee: null, role: 'Data Lead' } } };
    const r = await runChecks(
      input({
        baseCoverLetter: base,
        otherJobs: [{ title: 'Principal Wrangler', employer: 'Elsewhere Ltd', advertiser: null }],
        coverLetter: letter(['As a Data Lead and Principal Wrangler at Elsewhere Ltd I did things.']),
      }),
      opts(),
    );
    expect(find(r, 'title_leakage').length).toBe(2);
    expect(find(r, 'company_leakage').length).toBe(1);
  });

  test('target that is a skill is not leakage', async () => {
    const r = await runChecks(
      input({
        job: { title: 'Platform Engineer', employer: 'Salesforce', advertiser: null, rawText: 'Salesforce hiring' },
        otherJobs: [{ title: null, employer: 'Salesforce', advertiser: null }],
        coverLetter: letter(['I have used Salesforce daily.']),
      }),
      opts(),
    );
    expect(find(r, 'company_leakage')).toEqual([]);
  });

  test('a skill that is another job employer is not leakage', async () => {
    const r = await runChecks(
      input({
        otherJobs: [{ title: null, employer: 'Salesforce', advertiser: null }],
        coverLetter: letter(['I have used Salesforce daily.']),
      }),
      opts(),
    );
    expect(find(r, 'company_leakage')).toEqual([]);
  });

  test('own past employer is not leakage', async () => {
    const r = await runChecks(
      input({
        otherJobs: [{ title: null, employer: 'Acme Pty Ltd', advertiser: null }],
        coverLetter: letter(['At Acme Pty Ltd I built an invoicing service.']),
      }),
      opts(),
    );
    expect(find(r, 'company_leakage')).toEqual([]);
  });

  test('us spelling flagged, au passes, keyword match treats them equal', async () => {
    const us = await runChecks(input({ coverLetter: letter(['I optimized the color of the center.']) }), opts());
    const flagged = find(us, 'us_spelling').map((c) => c.detail).join(' ');
    expect(flagged).toMatch(/optimized/);
    expect(flagged).toMatch(/color/);
    expect(flagged).toMatch(/center/);
    const au = await runChecks(input({ coverLetter: letter(['I optimised the colour of the centre.']) }), opts());
    expect(find(au, 'us_spelling')).toEqual([]);

    const cv = { ...goodCv, summary: 'Engineer who will optimise organisation tooling. 3+ years building services.' };
    const kw = await runChecks(input({ cv, keywordsCovered: ['optimize', 'organization'] }), opts());
    expect(find(kw, 'keyword_not_found')).toEqual([]);
  });

  test('banned phrases are hard fails', async () => {
    const r = await runChecks(input({ coverLetter: letter(['I spearheaded a Proven Track Record.']) }), opts());
    expect(find(r, 'banned_phrase').map((c) => c.detail).sort()).toEqual(['proven track record', 'spearheaded']);
  });

  test('Github flagged, GitHub passes, github.com in a link ignored', async () => {
    const bad = await runChecks(input({ coverLetter: letter(['My Github is busy.']) }), opts());
    expect(find(bad, 'tech_casing')[0]).toMatchObject({ severity: 'hard' });
    const ok = await runChecks(
      input({ coverLetter: letter(['My GitHub is busy, see https://github.com/jordan-testcase and the rest of it, then react.']) }),
      opts(),
    );
    expect(find(ok, 'tech_casing')).toEqual([]);
    const link = await runChecks(
      input({ cv: { ...goodCv, contact: { ...goodCv.contact, links: [{ label: 'Code', url: 'https://github.com/Jordan-Testcase' }] } } }),
      opts(),
    );
    expect(find(link, 'tech_casing')).toEqual([]);
  });

  test('number not in base cv is unknown_fact; 3+ years and dash variants pass', async () => {
    const bad = await runChecks(input({ coverLetter: letter(['I managed 12 engineers and cut costs by 55%.']) }), opts());
    const details = find(bad, 'unknown_fact').map((c) => c.detail).join(' ');
    expect(details).toMatch(/12/);
    expect(details).toMatch(/55/);
    expect(find(bad, 'unknown_fact').every((c) => c.severity === 'hard')).toBe(true);

    const ok = await runChecks(input(), opts());
    expect(find(ok, 'unknown_fact')).toEqual([]);
  });

  test('numbers in urls, e-mails and phone are not facts', async () => {
    const cv = {
      ...goodCv,
      contact: { ...goodCv.contact, email: 'jordan99@example.com', phone: '0412 345 678', links: [{ label: 'Site', url: 'https://example.com/p/4821' }] },
    };
    const r = await runChecks(input({ cv }), opts());
    expect(find(r, 'unknown_fact')).toEqual([]);
  });

  test('an invented month-year date is unknown_fact', async () => {
    const cv = { ...goodCv, experience: [{ ...goodCv.experience[0], dates: 'Apr 2022 - Dec 2024' }] };
    const r = await runChecks(input({ cv }), opts());
    expect(find(r, 'unknown_fact').map((c) => c.detail).join(' ')).toMatch(/Apr 2022/);
  });

  test('unknown employer and title are unknown_fact', async () => {
    const cv = {
      ...goodCv,
      experience: [{ ...goodCv.experience[0], employer: 'Madeup Industries', title: 'Chief Wizard' }],
    };
    const r = await runChecks(input({ cv }), opts());
    const where = find(r, 'unknown_fact').map((c) => c.where);
    expect(where).toEqual(expect.arrayContaining(['cv.experience[0].employer', 'cv.experience[0].title']));
  });

  test('rephrased skill is unmatched_skill (review)', async () => {
    const cv = { ...goodCv, skills: [{ group: 'Tools', items: ['TypeScript', 'Report building'] }] };
    const r = await runChecks(input({ cv }), opts());
    expect(find(r, 'unmatched_skill')).toEqual([expect.objectContaining({ severity: 'review', detail: expect.stringContaining('Report building') })]);
  });

  test('misspelling is a review item; base cv, job ad and tech words are allowed', async () => {
    const r = await runChecks(
      input({
        coverLetter: letter(['I enjoyed the recieved feedback, the Newco roadmap, PostgreSQL and zorblat tooling.']),
        job: { title: 'Platform Engineer', employer: 'Newco', advertiser: null, rawText: 'zorblat is our product' },
      }),
      opts(),
    );
    const words = find(r, 'possible_misspelling').map((c) => c.detail).join(' ');
    expect(words).toMatch(/recieved/);
    expect(words).not.toMatch(/zorblat|Newco|PostgreSQL/);
    expect(find(r, 'possible_misspelling')[0].severity).toBe('review');
  });

  test('covered keyword missing from cv is keyword_not_found', async () => {
    const r = await runChecks(input({ keywordsCovered: ['TypeScript', 'Kubernetes'] }), opts());
    expect(find(r, 'keyword_not_found').map((c) => c.detail)).toEqual([expect.stringContaining('Kubernetes')]);
  });

  test('missing work rights is a warning', async () => {
    const r = await runChecks(input({ baseCv: { structured: { ...baseStructured, workRights: null } } }), opts());
    expect(find(r, 'missing_work_rights')[0]).toMatchObject({ severity: 'warning', doc: 'cv' });
    expect(codes(await runChecks(input(), opts()))).not.toContain('missing_work_rights');
  });

  test('link 999 is reachable, 404 is link_unreachable, bad scheme is link_invalid', async () => {
    const links = [
      { label: 'A', url: 'https://ok.example/a' },
      { label: 'B', url: 'https://linkedin.example/b' },
      { label: 'C', url: 'https://gone.example/c' },
      { label: 'D', url: 'ftp://files.example/d' },
      { label: 'E', url: 'mailto:jordan@example.com' },
    ];
    const fetchSeam = (async (url: string) => {
      if (url.includes('linkedin')) return { status: 999, body: null } as unknown as Response; // Response() rejects 999
      if (url.includes('gone')) return new Response('', { status: 404 });
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const cv = { ...goodCv, contact: { ...goodCv.contact, links } };
    const r = await runChecks(input({ cv }), opts({ fetch: fetchSeam }));
    expect(find(r, 'link_unreachable').map((c) => c.detail)).toEqual([expect.stringContaining('gone.example')]);
    expect(find(r, 'link_unreachable')[0].severity).toBe('warning');
    expect(find(r, 'link_invalid')).toEqual([expect.objectContaining({ severity: 'hard', where: 'cv.contact.links[3]' })]);
  });

  test('render_text flags a missing heading, missing name and wrong order', async () => {
    const render: NonNullable<RunOptions['render']> = async (doc) => ({
      pages: 1,
      text: doc === 'cv' ? 'SUMMARY\nSKILLS\nEDUCATION\nEXPERIENCE\nPROJECTS' : 'no name',
    });
    const r = await runChecks(input(), opts({ render }));
    const rt = find(r, 'render_text');
    expect(rt.every((c) => c.severity === 'hard')).toBe(true);
    expect(rt.some((c) => c.doc === 'cv')).toBe(true);
    expect(rt.some((c) => c.doc === 'cover_letter')).toBe(true);
  });
});
