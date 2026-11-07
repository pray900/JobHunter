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
  contact: { location: 'Sydney NSW', email: 'jordan@example.com', phone: '0400 000 000', links: ['https://github.com/jordan-testcase'] },
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
    const baseCv = { structured: { ...baseStructured, contact: { ...baseStructured.contact, email: 'jordan99@example.com', phone: '0412 345 678', links: ['https://example.com/p/4821'] } } };
    const r = await runChecks(input({ cv, baseCv }), opts());
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
    const baseCv = { structured: { ...baseStructured, contact: { ...baseStructured.contact, links: links.map((l) => l.url) } } };
    const r = await runChecks(input({ cv, baseCv }), opts({ fetch: fetchSeam }));
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

  // ---------- fix round 1 ----------
  const twoRoles = {
    ...baseStructured,
    roles: [
      { title: 'Software Engineer (Intern)', employer: 'Acme Pty Ltd', dates: 'Mar 2022 - Dec 2024', bullets: ['Built an invoicing service.'] },
      { title: 'Data Analyst', employer: 'Betaco', dates: 'Jan 2019 - Feb 2022', bullets: ['Cut report time by 40%.'] },
    ],
  };
  const exp = (over: object) => ({ ...goodCv, experience: [{ ...goodCv.experience[0], title: 'Software Engineer (Intern)', ...over }] });

  test('I1: correct AU inflections are not flagged as US spelling', async () => {
    const r = await runChecks(input({ coverLetter: letter(['I fulfilled the brief, was fulfilling it, and literally read the literal text.']) }), opts());
    expect(find(r, 'us_spelling')).toEqual([]);
  });

  test('I2: shifted dates and a title from another role are unknown_fact', async () => {
    const base = { structured: twoRoles };
    const ok = await runChecks(input({ cv: exp({}), baseCv: base }), opts());
    expect(find(ok, 'unknown_fact')).toEqual([]);
    const dates = await runChecks(input({ cv: exp({ dates: 'Jan 2019 - Dec 2024' }), baseCv: base }), opts());
    expect(find(dates, 'unknown_fact').map((c) => c.where)).toContain('cv.experience[0].dates');
    const title = await runChecks(input({ cv: exp({ title: 'Data Analyst' }), baseCv: base }), opts());
    expect(find(title, 'unknown_fact').map((c) => c.where)).toContain('cv.experience[0].title');
    const dropped = await runChecks(input({ cv: exp({ dates: 'Mar 2022' }), baseCv: base }), opts());
    expect(find(dropped, 'unknown_fact').map((c) => c.where)).toContain('cv.experience[0].dates');
    const edu = await runChecks(
      input({ cv: { ...goodCv, education: [{ ...goodCv.education[0], dates: '2016 - 2021' }] } }),
      opts(),
    );
    expect(find(edu, 'unknown_fact').map((c) => c.where)).toContain('cv.education[0].dates');
  });

  test('I3: dropping a bracketed title qualifier is unknown_fact; a bracket on an employer is ignored', async () => {
    const base = { structured: twoRoles };
    const r = await runChecks(input({ cv: exp({ title: 'Software Engineer' }), baseCv: base }), opts());
    expect(find(r, 'unknown_fact').map((c) => c.where)).toContain('cv.experience[0].title');
    const bracketed = { ...twoRoles, roles: [{ ...twoRoles.roles[0], employer: 'Acme Pty Ltd (Sydney)' }, twoRoles.roles[1]] };
    const ok = await runChecks(input({ cv: exp({}), baseCv: { structured: bracketed } }), opts());
    expect(find(ok, 'unknown_fact')).toEqual([]);
  });

  test('I4: a work-rights line the base lacks, or words differently, is unknown_fact', async () => {
    const none = await runChecks(
      input({ cv: { ...goodCv, workRights: 'Full working rights in Australia' }, baseCv: { structured: { ...baseStructured, workRights: null } } }),
      opts(),
    );
    expect(find(none, 'unknown_fact')).toEqual([expect.objectContaining({ severity: 'hard', where: 'cv.workRights' })]);
    const reworded = await runChecks(
      input({
        cv: { ...goodCv, workRights: 'Australian Citizen.' },
        baseCv: { structured: { ...baseStructured, workRights: 'Full working rights (485 visa)' } },
      }),
      opts(),
    );
    expect(find(reworded, 'unknown_fact').map((c) => c.where)).toContain('cv.workRights');
    const punct = await runChecks(
      input({ cv: { ...goodCv, workRights: 'Australian  citizen.' } }),
      opts(),
    );
    expect(find(punct, 'unknown_fact')).toEqual([]);
  });

  test('I5: the letter may use numbers and dates from the job ad; the CV may not', async () => {
    const job = { title: 'Developer APS 6', employer: 'Newco', advertiser: null, rawText: 'Join our 2027 graduate program from Feb 2027.' };
    const ok = await runChecks(input({ job, coverLetter: letter(['I am applying for the Developer APS 6 role in your 2027 program starting Feb 2027.']) }), opts());
    expect(find(ok, 'unknown_fact')).toEqual([]);
    const cv = await runChecks(input({ job, cv: { ...goodCv, summary: 'Engineer ready for the 2027 program.' } }), opts());
    expect(find(cv, 'unknown_fact').map((c) => c.doc)).toEqual(['cv']);
  });

  test('I6: other-job names match case-sensitively; the previous target ignores case and punctuation', async () => {
    const honest = await runChecks(
      input({
        otherJobs: [{ title: 'Data Engineer', employer: 'Insight', advertiser: null }],
        coverLetter: letter(['I want insight into your platform, where a data engineer helped me.']),
      }),
      opts(),
    );
    expect(find(honest, 'company_leakage')).toEqual([]);
    expect(find(honest, 'title_leakage')).toEqual([]);
    const leaked = await runChecks(
      input({ otherJobs: [{ title: null, employer: 'Insight', advertiser: null }], coverLetter: letter(['I admire Insight.']) }),
      opts(),
    );
    expect(find(leaked, 'company_leakage').length).toBe(1);
    const base = { structured: { previousTarget: { company: 'Oldco', addressee: 'Ms. Quill', role: null } } };
    const noStop = await runChecks(input({ baseCoverLetter: base, coverLetter: { ...LETTER, salutation: 'Dear ms quill,' } }), opts());
    expect(find(noStop, 'company_leakage').map((c) => c.where)).toEqual(['coverLetter.salutation']);
  });

  test('M1: percentages and contact digits are not interchangeable with plain numbers', async () => {
    const base = { structured: { ...baseStructured, contact: { ...baseStructured.contact, location: 'Sydney NSW 2000' } } };
    const r = await runChecks(input({ baseCv: base, coverLetter: letter(['I served 2,000 users and 40 teams.']) }), opts());
    const d = find(r, 'unknown_fact').map((c) => c.detail).join(' ');
    expect(d).toMatch(/2,000/);
    expect(d).toMatch(/40/);
  });

  test('M3: a technology missing from the base CV is a review item', async () => {
    const cv = { ...goodCv, summary: 'Engineer with 3+ years building services on Kubernetes.' };
    const r = await runChecks(input({ cv }), opts());
    expect(find(r, 'unmatched_skill')).toEqual([expect.objectContaining({ severity: 'review', detail: expect.stringContaining('Kubernetes') })]);
  });

  test('M6: changed contact details are unknown_fact', async () => {
    const cv = { ...goodCv, contact: { ...goodCv.contact, email: 'other@example.com', phone: '0499 999 999' } };
    const r = await runChecks(input({ cv }), opts());
    const where = find(r, 'unknown_fact').map((c) => c.where);
    expect(where).toEqual(expect.arrayContaining(['cv.contact.email', 'cv.contact.phone']));
  });

  test('M7: links to private hosts or not in the base are not fetched', async () => {
    const seen: string[] = [];
    const fetchSeam = (async (url: string) => {
      seen.push(url);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const links = [
      { label: 'A', url: 'http://gotenberg:3000/forms' },
      { label: 'B', url: 'http://169.254.169.254/latest' },
      { label: 'C', url: 'https://unlisted.example/x' },
    ];
    const baseCv = { structured: { ...baseStructured, contact: { ...baseStructured.contact, links: [links[0].url, links[1].url] } } };
    const r = await runChecks(input({ cv: { ...goodCv, contact: { ...goodCv.contact, links } }, baseCv }), opts({ fetch: fetchSeam }));
    expect(seen).toEqual([]);
    expect(find(r, 'link_invalid').map((c) => c.where)).toEqual(['cv.contact.links[0]', 'cv.contact.links[1]']);
    expect(find(r, 'unknown_fact').map((c) => c.where)).toEqual(['cv.contact.links[2]']);
  });

  test('M8: a link written in prose is validated against the base and the job ad', async () => {
    const r = await runChecks(input({ coverLetter: letter(['See https://invented.example/portfolio for samples.']) }), opts());
    expect(find(r, 'unknown_fact').map((c) => c.where)).toContain('coverLetter.paragraphs[0]');
    const ok = await runChecks(input({ coverLetter: letter(['See https://github.com/jordan-testcase for samples.']) }), opts());
    expect(find(ok, 'unknown_fact')).toEqual([]);
  });


  // ---------- fix round 2 ----------
  const withBaseLinks = (links: string[]) => ({ structured: { ...baseStructured, contact: { ...baseStructured.contact, links } } });
  const withLink = (url: string) => ({ ...goodCv, contact: { ...goodCv.contact, links: [{ label: 'Profile', url }] } });

  test('N1: links compare without scheme, www, case or trailing slash; a different path still fails', async () => {
    const cases: [string, string, boolean][] = [
      ['linkedin.com/in/x', 'https://linkedin.com/in/x', true],
      ['http://linkedin.com/in/x', 'https://linkedin.com/in/x', true],
      ['https://www.linkedin.com/in/x/', 'https://linkedin.com/in/x', true],
      ['linkedin.com/in/x', 'https://www.LinkedIn.com/in/x/', true],
      ['linkedin.com/in/x', 'https://linkedin.com/in/y', false],
    ];
    for (const [base, out, passes] of cases) {
      const r = await runChecks(input({ cv: withLink(out), baseCv: withBaseLinks([base]) }), opts());
      expect(find(r, 'unknown_fact').filter((c) => c.where === 'cv.contact.links[0]').length === 0, `${base} vs ${out}`).toBe(passes);
      expect(find(r, 'link_invalid')).toEqual([]);
    }
  });

  test('N1: a link written in prose matches a scheme-less base link', async () => {
    const r = await runChecks(
      input({ baseCv: withBaseLinks(['linkedin.com/in/x']), coverLetter: letter(['My profile is at https://www.linkedin.com/in/x/ today.']) }),
      opts(),
    );
    expect(find(r, 'unknown_fact').filter((c) => c.where === 'coverLetter.paragraphs[0]')).toEqual([]);
  });

  test('N2: phone numbers compare by digits with +61 and 0 equivalent', async () => {
    const run = (basePhone: string, outPhone: string) =>
      runChecks(
        input({
          cv: { ...goodCv, contact: { ...goodCv.contact, phone: outPhone } },
          baseCv: { structured: { ...baseStructured, contact: { ...baseStructured.contact, phone: basePhone } } },
        }),
        opts(),
      );
    expect(find(await run('+61 412 345 678', '0412 345 678'), 'unknown_fact')).toEqual([]);
    expect(find(await run('0412-345-678', '+61 (0)412 345 678'.replace('(0)', '')), 'unknown_fact')).toEqual([]);
    expect(find(await run('0412 345 678', '+61412345678'), 'unknown_fact')).toEqual([]);
    expect(find(await run('0412 345 678', '0412 345 679'), 'unknown_fact').map((c) => c.where)).toEqual(['cv.contact.phone']);
  });

  test('N3: dropping the base work-rights line is a hard work_rights_dropped', async () => {
    const r = await runChecks(input({ cv: { ...goodCv, workRights: null } }), opts());
    expect(find(r, 'work_rights_dropped')).toEqual([
      expect.objectContaining({ severity: 'hard', doc: 'cv', detail: 'Your base CV has a work-rights line; keep it.' }),
    ]);
    const none = await runChecks(input({ cv: { ...goodCv, workRights: null }, baseCv: { structured: { ...baseStructured, workRights: null } } }), opts());
    expect(find(none, 'work_rights_dropped')).toEqual([]);
  });


  // ---------- final review fixes ----------
  describe('final review: names copied from the base CV', () => {
    const copiedBase = {
      ...baseStructured,
      workRights: 'Authorized to work in Australia (485 visa)',
      roles: [{ title: 'Data Visualization Analyst', employer: 'Dynamic Solutions Pty Ltd', dates: 'Mar 2022 - Dec 2024', bullets: ['Built an invoicing service.'] }],
      education: [{ qualification: 'Certificate in Dynamic Systems', institution: 'Dynamic Learning Institute', dates: '2018 - 2021', statusText: 'Completed with Honors' }],
    };
    const copiedCv: TailoredCv = {
      ...goodCv,
      workRights: 'Authorized to work in Australia (485 visa)',
      experience: [{ title: 'Data Visualization Analyst', employer: 'Dynamic Solutions Pty Ltd', location: 'Sydney', dates: 'Mar 2022 – Dec 2024', bullets: ['Built an invoicing service.'] }],
      education: [{ qualification: 'Certificate in Dynamic Systems', institution: 'Dynamic Learning Institute', dates: '2018 - 2021', statusText: 'Completed with Honors' }],
    };
    const run = (cv: TailoredCv) => runChecks(input({ cv, baseCv: { structured: copiedBase } }), opts());

    test('US spelling and banned words in a title, employer, institution, qualification, statusText or work-rights line copied exactly pass', async () => {
      const r = await run(copiedCv);
      expect(find(r, 'us_spelling')).toEqual([]);
      expect(find(r, 'banned_phrase')).toEqual([]);
      expect(find(r, 'unknown_fact')).toEqual([]);
      expect(r.checks.filter((c) => c.severity === 'hard')).toEqual([]);
    });

    test('the same words in a bullet or the summary still fail', async () => {
      const cv: TailoredCv = {
        ...copiedCv,
        summary: 'Authorized analyst with 3+ years building services.',
        experience: [{ ...copiedCv.experience[0], bullets: ['Built a visualization service at a dynamic company.'] }],
      };
      const r = await run(cv);
      expect(find(r, 'us_spelling').map((c) => c.where).sort()).toEqual(['cv.experience[0].bullets[0]', 'cv.summary']);
      expect(find(r, 'banned_phrase').map((c) => c.where)).toEqual(['cv.experience[0].bullets[0]']);
    });

    test('a copied field that no longer matches the base CV gets no exemption', async () => {
      const cv: TailoredCv = { ...copiedCv, experience: [{ ...copiedCv.experience[0], title: 'Dynamic Visualization Lead' }] };
      const r = await run(cv);
      expect(find(r, 'us_spelling').map((c) => c.where)).toContain('cv.experience[0].title');
      expect(find(r, 'banned_phrase').map((c) => c.where)).toContain('cv.experience[0].title');
    });
  });

  test('M5: a name that differs from the base CV is unknown_fact', async () => {
    const ok = await runChecks(input({ cv: { ...goodCv, name: 'Jordan  Testcase' } }), opts());
    expect(find(ok, 'unknown_fact')).toEqual([]);
    const cv = await runChecks(input({ cv: { ...goodCv, name: 'Jordon Testcase' } }), opts());
    expect(find(cv, 'unknown_fact').map((c) => c.where)).toEqual(['cv.name']);
    const letterName = await runChecks(input({ coverLetter: { ...LETTER, name: 'J. Testcase' } }), opts());
    expect(find(letterName, 'unknown_fact').map((c) => c.where)).toEqual(['coverLetter.name']);
    const noName = await runChecks(input({ baseCv: { structured: { ...baseStructured, name: null } } }), opts());
    expect(find(noName, 'unknown_fact')).toEqual([]);
  });

  test('M11: an empty summary needs no SUMMARY heading in the rendered CV', async () => {
    const render: NonNullable<RunOptions['render']> = async (doc, _d, cv) => ({
      pages: 1,
      text: doc === 'cv' ? `${cv.name}\nSKILLS\nx\nEXPERIENCE\nx\nPROJECTS\nx\nEDUCATION\nx` : `${cv.name}`,
    });
    const r = await runChecks(input({ cv: { ...goodCv, summary: '' } }), opts({ render }));
    expect(find(r, 'render_text')).toEqual([]);
  });

  test('I2: an education entry without an institution or qualification is checked against the base', async () => {
    const base = { ...baseStructured, education: [{ qualification: 'Salesforce Certified Platform Developer I', institution: '', dates: '2023', statusText: '' }] };
    const cv: TailoredCv = { ...goodCv, education: [{ qualification: 'Salesforce Certified Platform Developer I', institution: '', dates: '2023', statusText: '' }] };
    const r = await runChecks(input({ cv, baseCv: { structured: base } }), opts());
    expect(r.checks.filter((c) => c.severity === 'hard')).toEqual([]);
  });

  test('R1: bracketed text added to a copied employer is checked; brackets the base has pass', async () => {
    const base = { ...baseStructured, roles: [{ ...baseStructured.roles[0], employer: 'Acme Widgets Pty Ltd' }] };
    const cv: TailoredCv = { ...goodCv, experience: [{ ...goodCv.experience[0], employer: 'Acme Widgets (passionate, optimized team of 50) Pty Ltd' }] };
    const r = await runChecks(input({ cv, baseCv: { structured: base } }), opts());
    const where = 'cv.experience[0].employer';
    expect(find(r, 'banned_phrase').map((c) => c.where)).toContain(where);
    expect(find(r, 'us_spelling').map((c) => c.where)).toContain(where);
    expect(find(r, 'unknown_fact').map((c) => c.where)).toContain(where);

    const bracketed = { ...baseStructured, roles: [{ ...baseStructured.roles[0], employer: 'Dynamic Widgets (Optimization Division) Pty Ltd' }] };
    const honest: TailoredCv = { ...goodCv, experience: [{ ...goodCv.experience[0], employer: 'Dynamic Widgets (Optimization Division) Pty Ltd' }] };
    const ok = await runChecks(input({ cv: honest, baseCv: { structured: bracketed } }), opts());
    expect(ok.checks.filter((c) => c.severity === 'hard')).toEqual([]);
  });
});
