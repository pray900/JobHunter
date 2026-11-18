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
      ? `${cv.name}\nSUMMARY\nx\nSKILLS\nx\nPROFESSIONAL EXPERIENCE\nx\nPROJECTS\nx\nEDUCATION\nx`
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

  describe('fit', () => {
    const cv3: TailoredCv = {
      ...goodCv,
      projects: [
        { name: 'Side Project', bullets: ['Small CLI tool.'] },
        { name: 'Second Project', bullets: ['Another tool.'] },
        { name: 'Zorbleflux Project', bullets: ['A misspellt zorbleflux tool.'] },
      ],
    };
    const renderBy = (pagesFor: (cv: TailoredCv) => number): NonNullable<RunOptions['render']> =>
      async (doc, d, cv, l) => (doc === 'cv' ? { pages: pagesFor(cv), text: (await okRender(doc, d, cv, l)).text } : okRender(doc, d, cv, l));

    test('drops a project to fit; other checks run on the fitted CV', async () => {
      const r = await runChecks(input({ cv: cv3, dropProjects: true }), opts({ render: renderBy((cv) => (cv.projects.length > 2 ? 2 : 1)) }));
      expect(r.cv.projects.map((p) => p.name)).toEqual(['Side Project', 'Second Project']);
      expect(r.fit).toEqual({ step: 0, droppedProjects: ['Zorbleflux Project'] });
      expect(find(r, 'cv_pages')).toHaveLength(0);
      expect(r.cvPages).toBe(1);
      expect(find(r, 'possible_misspelling').some((c) => c.detail === 'misspellt')).toBe(false);
    });

    test('unfixable overflow keeps the CV and reports cv_pages', async () => {
      const r = await runChecks(input({ cv: cv3, dropProjects: true }), opts({ render: renderBy(() => 2) }));
      expect(r.cv).toEqual(cv3);
      expect(r.fit.droppedProjects).toEqual([]);
      expect(find(r, 'cv_pages')[0]).toMatchObject({ severity: 'hard', detail: 'The CV is 2 pages even at the smallest layout; the limit is 1.' });
    });

    test('without dropProjects the CV is never cut: cv_pages at the floor, full CV checked', async () => {
      for (const over of [{}, { dropProjects: false }]) {
        const r = await runChecks(input({ cv: cv3, ...over }), opts({ render: renderBy((cv) => (cv.projects.length > 2 ? 2 : 1)) }));
        expect(r.cv).toEqual(cv3);
        expect(r.fit.droppedProjects).toEqual([]);
        expect(r.cvPages).toBe(2);
        expect(find(r, 'cv_pages')[0]).toMatchObject({ severity: 'hard', detail: 'The CV is 2 pages even at the smallest layout; the limit is 1.' });
        expect(find(r, 'possible_misspelling').some((c) => c.detail === 'misspellt')).toBe(true);
      }
    });

    test('keyword_not_found ignores a keyword that only a dropped project carried', async () => {
      const render = renderBy((cv) => (cv.projects.length > 2 ? 2 : 1));
      const dropped = await runChecks(input({ cv: cv3, dropProjects: true, keywordsCovered: ['zorbleflux', 'nowhereword'] }), opts({ render }));
      expect(find(dropped, 'keyword_not_found').map((c) => c.detail)).toEqual(['The keyword "nowhereword" is listed as covered but is not in the CV.']);
      const kept = await runChecks(input({ cv: cv3, keywordsCovered: ['zorbleflux'] }), opts({ render: renderBy(() => 1) }));
      expect(find(kept, 'keyword_not_found')).toEqual([]);
    });

    test('manual edits protect a project', async () => {
      const manualEdits = [{ path: 'cv.projects[2].bullets[0]', text: 'A misspellt zorbleflux tool.' }];
      const r = await runChecks(input({ cv: cv3, manualEdits, dropProjects: true }), opts({ render: renderBy((cv) => (cv.projects.length > 2 ? 2 : 1)) }));
      expect(r.cv).toEqual(cv3);
      expect(r.fit.droppedProjects).toEqual([]);
      expect(find(r, 'cv_pages')).toHaveLength(1);
    });
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

  describe('numbers and dates (Plan 7)', () => {
    const withBullets = (bullets: string[], projectBullets = ['Small CLI tool.']): TailoredCv => ({
      ...goodCv,
      experience: [{ ...goodCv.experience[0], bullets }],
      projects: [{ name: 'Side Project', bullets: projectBullets } as TailoredCv['projects'][number]],
    });

    test('a new number in an experience bullet or a project bullet passes', async () => {
      const r = await runChecks(
        input({ cv: withBullets(['Built an invoicing service used by 12 teams.'], ['Small CLI tool saving 30 minutes a week.']) }),
        opts(),
      );
      expect(find(r, 'unknown_fact')).toEqual([]);
    });

    test('the same new number in the summary or headline is still a hard fail', async () => {
      const summary = await runChecks(input({ cv: { ...goodCv, summary: 'Engineer who led 12 teams.' } }), opts());
      expect(find(summary, 'unknown_fact').map((c) => [c.where, c.severity])).toEqual([['cv.summary', 'hard']]);
      const headline = await runChecks(input({ cv: { ...goodCv, headline: 'Backend Engineer, 12 years' } }), opts());
      expect(find(headline, 'unknown_fact').map((c) => [c.where, c.severity])).toEqual([['cv.headline', 'hard']]);
    });

    // The summary names the job title once; a title like "Clerk Grade 7/8" must not count as new numbers there.
    test("numbers in the job title pass where the text names the title, and nowhere else", async () => {
      const job = { ...input().job, title: 'Clerk Grade 7/8' };
      const named = await runChecks(input({ job, cv: { ...goodCv, summary: 'Engineer applying for the Clerk Grade 7/8 role.' } }), opts());
      expect(find(named, 'unknown_fact')).toEqual([]);
      const loose = await runChecks(input({ job, cv: { ...goodCv, summary: 'Engineer who led 7 teams.' } }), opts());
      expect(find(loose, 'unknown_fact').map((c) => [c.where, c.severity])).toEqual([['cv.summary', 'hard']]);
    });

    test('a new month-year date in a bullet is still a hard fail', async () => {
      const r = await runChecks(input({ cv: withBullets(['Built an invoicing service in Jun 2023.']) }), opts());
      const hits = find(r, 'unknown_fact');
      expect(hits.every((c) => c.where === 'cv.experience[0].bullets[0]' && c.severity === 'hard')).toBe(true);
      expect(hits.some((c) => /date "Jun 2023"/.test(c.detail))).toBe(true);
    });

    test('a letter may repeat a number from a CV bullet, but not one found nowhere', async () => {
      const cv = withBullets(['Built an invoicing service used by 12 teams.']);
      const ok = await runChecks(input({ cv, coverLetter: letter(['I built an invoicing service used by 12 teams.']) }), opts());
      expect(find(ok, 'unknown_fact')).toEqual([]);
      const bad = await runChecks(input({ cv, coverLetter: letter(['I built a service used by 12 teams and cut costs by 55%.']) }), opts());
      const hits = find(bad, 'unknown_fact');
      expect(hits.map((c) => c.doc)).toEqual(['cover_letter']);
      expect(hits[0].detail).toMatch(/55/);
      expect(hits[0].detail).not.toMatch(/"12"/);
    });

    test('years of experience and bare years in a bullet are still hard fails; other figures pass', async () => {
      const years = await runChecks(input({ cv: withBullets(['Spent 5 years building APIs.']) }), opts());
      expect(find(years, 'unknown_fact').map((c) => [c.where, c.severity])).toEqual([['cv.experience[0].bullets[0]', 'hard']]);
      const plus = await runChecks(input({ cv: withBullets(['Built APIs with 8+ years of Python.']) }), opts());
      expect(find(plus, 'unknown_fact').length).toBe(1);
      const bare = await runChecks(input({ cv: withBullets(['Shipped the billing rewrite in 2019.']) }), opts());
      expect(find(bare, 'unknown_fact').map((c) => c.detail).join(' ')).toMatch(/2019/);
      const ok = await runChecks(input({ cv: withBullets(['Reduced load time by 40% for a team of 6.']) }), opts());
      expect(find(ok, 'unknown_fact')).toEqual([]);
    });

    test('a letter cannot repeat a years term from a bullet, but may repeat a plain figure', async () => {
      const cv = withBullets(['Spent 8 years building APIs and cut load time by 35%.']);
      const r = await runChecks(input({ cv, coverLetter: letter(['I have 8 years building APIs and cut load time by 35%.']) }), opts());
      const hits = find(r, 'unknown_fact');
      expect(hits.map((c) => c.doc).sort()).toEqual(['cover_letter', 'cv']);
      expect(hits.find((c) => c.doc === 'cover_letter')!.detail).toMatch(/"8"/);
      expect(hits.find((c) => c.doc === 'cover_letter')!.detail).not.toMatch(/35/);
    });

    test('a new number outside experience and project bullets still fails', async () => {
      const cases: [string, TailoredCv][] = [
        ['cv.skills[0].items[1]', { ...goodCv, skills: [{ group: 'Languages', items: ['TypeScript', 'SQL 77'] }] }],
        ['cv.education[0].statusText', { ...goodCv, education: [{ ...goodCv.education[0], statusText: 'Completed 77' }] }],
        ['cv.experience[0].location', { ...goodCv, experience: [{ ...goodCv.experience[0], location: 'Sydney 77' }] }],
        ['cv.projects[0].name', { ...goodCv, projects: [{ name: 'Side Project 77', bullets: ['Small CLI tool.'] } as TailoredCv['projects'][number]] }],
      ];
      for (const [where, cv] of cases) {
        const r = await runChecks(input({ cv }), opts());
        const hit = find(r, 'unknown_fact').find((c) => c.where === where && /number "77"/.test(c.detail));
        expect(hit, where).toMatchObject({ severity: 'hard' });
      }
    });
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
      text: doc === 'cv' ? 'SUMMARY\nSKILLS\nEDUCATION\nPROFESSIONAL EXPERIENCE\nPROJECTS' : 'no name',
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
      text: doc === 'cv' ? `${cv.name}\nSKILLS\nx\nPROFESSIONAL EXPERIENCE\nx\nPROJECTS\nx\nEDUCATION\nx` : `${cv.name}`,
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

describe('heading order uses Professional Experience', () => {
  test('a PDF text with EXPERIENCE but not PROFESSIONAL EXPERIENCE fails render_text', async () => {
    const render: NonNullable<RunOptions['render']> = async (doc, d, cv, l) =>
      doc === 'cv' ? { pages: 1, text: `${cv.name}\nSUMMARY\nx\nSKILLS\nx\nEXPERIENCE\nx\nPROJECTS\nx\nEDUCATION\nx` } : okRender(doc, d, cv, l);
    const r = await runChecks(input(), opts({ render }));
    expect(find(r, 'render_text').map((c) => c.detail)).toEqual([expect.stringContaining('PROFESSIONAL EXPERIENCE')]);
  });
});

describe('long_paragraph', () => {
  const w = (n: number) => Array.from({ length: n }, () => 'steady').join(' ');
  const withExp = (bullets: string[]): TailoredCv => ({ ...goodCv, experience: [{ ...goodCv.experience[0], bullets }] });

  test('41-word summary is long_paragraph', async () => {
    const r = await runChecks(input({ cv: { ...goodCv, summary: w(41) } }), opts());
    expect(find(r, 'long_paragraph')).toEqual([
      { code: 'long_paragraph', severity: 'hard', doc: 'cv', where: 'cv.summary', detail: '41 words; keep it to 40 or fewer.' },
    ]);
  });

  test('40-word bullet passes', async () => {
    const r = await runChecks(input({ cv: withExp([w(40)]) }), opts());
    expect(find(r, 'long_paragraph')).toEqual([]);
  });

  test('a long bullet reports its path', async () => {
    const r = await runChecks(input({ cv: withExp(['Built it.', w(45)]) }), opts());
    expect(find(r, 'long_paragraph').map((c) => c.where)).toEqual(['cv.experience[0].bullets[1]']);
  });

  test('long skill group line is long_paragraph at cv.skills[i]', async () => {
    const items = Array.from({ length: 40 }, () => 'SQL');
    const cv = { ...goodCv, skills: [goodCv.skills[0], { group: 'Tools', items }] };
    const r = await runChecks(input({ cv }), opts());
    const hits = find(r, 'long_paragraph');
    expect(hits.map((c) => c.where)).toEqual(['cv.skills[1]']);
    expect(hits[0].detail).toBe('41 words; keep it to 40 or fewer.');
  });

  test('cover letter paragraphs are not checked', async () => {
    const r = await runChecks(input({ coverLetter: letter([w(80)]) }), opts());
    expect(find(r, 'long_paragraph')).toEqual([]);
  });

  test('long locked bullet is kept', async () => {
    // The worker reports it at its path; the Generate workflow marks it locked and keeps it ("Your edit — kept as you asked").
    const long = w(50);
    const r = await runChecks(input({ cv: withExp([long]), manualEdits: [{ path: 'cv.experience[0].bullets[0]', text: long }] }), opts());
    const hits = find(r, 'long_paragraph');
    expect(hits).toHaveLength(1);
    expect(hits[0].where).toBe('cv.experience[0].bullets[0]');
  });
});

describe('government template', () => {
  const govCv: TailoredCv = {
    ...goodCv,
    competencies: ['Reporting: built weekly reports', 'Delivery: cut processing time by 30%'],
    experience: [{ ...goodCv.experience[0], achievements: ['Cut processing time by 30%'] }],
  };
  const govRender = (pages: number): NonNullable<RunOptions['render']> => async (doc, _d, cv) => ({
    pages: doc === 'cv' ? pages : 1,
    text:
      doc === 'cv'
        ? `${cv.name}\nPROFESSIONAL SUMMARY\nx\nKEY SKILLS & COMPETENCIES\nx\nPROFESSIONAL EXPERIENCE\nx\nPROJECTS\nx\nQUALIFICATIONS\nx\nREFEREES\nReferees available on request`
        : `${cv.name}\nDear`,
  });
  const gov = (over: Partial<CheckInput> = {}) => input({ templateId: 'au-government', cv: govCv, ...over });
  const cov = (answeredIn: string, why = '') => ({ criteriaCoverage: [{ criterion: 'Communicates well', answeredIn, why }] });

  test('page limit is 2 for government, 1 for standard', async () => {
    expect(find(await runChecks(gov(), opts({ render: govRender(2) })), 'cv_pages')).toHaveLength(0);
    const three = find(await runChecks(gov(), opts({ render: govRender(3) })), 'cv_pages');
    expect(three).toHaveLength(1);
    expect(three[0].detail.endsWith('the limit is 2.')).toBe(true);
    const std = await runChecks(
      input(),
      opts({ render: async (doc, d, cv, l) => (doc === 'cv' ? { pages: 2, text: (await okRender(doc, d, cv, l)).text } : okRender(doc, d, cv, l)) }),
    );
    expect(find(std, 'cv_pages')[0].detail.endsWith('the limit is 1.')).toBe(true);
  });

  test('government render_text needs Referees available on request', async () => {
    const noRef: NonNullable<RunOptions['render']> = async (doc, d, cv, l) => {
      const r = await govRender(1)(doc, d, cv, l);
      return { ...r, text: r.text.replace('Referees available on request', '') };
    };
    expect(find(await runChecks(gov(), opts({ render: govRender(1) })), 'render_text')).toHaveLength(0);
    const r = find(await runChecks(gov(), opts({ render: noRef })), 'render_text');
    expect(r.some((c) => c.detail.includes('Referees available on request'))).toBe(true);
  });

  describe('criteria coverage', () => {
    const run = (c: ReturnType<typeof cov>) => runChecks(gov(c), opts({ render: govRender(1) }));
    test.each(['coverLetter', 'cv.summary', 'cv.competencies[0]', 'cv.experience[0].achievements[0]', 'cv.experience[0].bullets[0]'])(
      '%s passes',
      async (p) => {
        expect(find(await run(cov(p)), 'criteria_coverage')).toHaveLength(0);
      },
    );
    test('a missing path fails', async () => {
      const r = find(await run(cov('cv.experience[0].achievements[5]')), 'criteria_coverage');
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ severity: 'hard', doc: 'cv', where: 'criteriaCoverage[0]' });
    });
    test('a project path fails with the project detail', async () => {
      const withProject = gov({ ...cov('cv.projects[0].bullets[0]'), cv: { ...govCv, projects: [{ name: 'P', bullets: ['b'] }] } });
      const r = find(await runChecks(withProject, opts({ render: govRender(1) })), 'criteria_coverage');
      expect(r[0].detail).toBe('Answer selection criteria in the summary, competencies, experience or the cover letter, not in a project.');
    });
    test('empty answeredIn needs a why', async () => {
      expect(find(await run(cov('', 'Not covered by this role')), 'criteria_coverage')).toHaveLength(0);
      expect(find(await run(cov('', '')), 'criteria_coverage')).toHaveLength(1);
    });
    test('absent criteriaCoverage skips the check', async () => {
      expect(find(await runChecks(gov(), opts({ render: govRender(1) })), 'criteria_coverage')).toHaveLength(0);
    });
  });

  test('new figures are allowed in achievements and competencies but not the summary', async () => {
    const r = await runChecks(gov(), opts({ render: govRender(1) }));
    expect(find(r, 'unknown_fact')).toHaveLength(0);
    const s = await runChecks(gov({ cv: { ...govCv, summary: 'Cut processing time by 30%' } }), opts({ render: govRender(1) }));
    expect(find(s, 'unknown_fact').some((c) => c.where === 'cv.summary')).toBe(true);
  });

  test('long_paragraph flags a 41-word achievement and competency', async () => {
    const long = Array.from({ length: 41 }, () => 'word').join(' ');
    const cv = { ...govCv, competencies: [long], experience: [{ ...goodCv.experience[0], achievements: [long] }] };
    const wheres = find(await runChecks(gov({ cv }), opts({ render: govRender(1) })), 'long_paragraph').map((c) => c.where);
    expect(wheres).toContain('cv.experience[0].achievements[0]');
    expect(wheres).toContain('cv.competencies[0]');
  });

  test('a keyword only in an achievement is found', async () => {
    const cv = { ...goodCv, experience: [{ ...goodCv.experience[0], achievements: ['Led procurement reform'] }] };
    const r = await runChecks(gov({ cv, keywordsCovered: ['procurement'] }), opts({ render: govRender(1) }));
    expect(find(r, 'keyword_not_found')).toHaveLength(0);
  });
});
