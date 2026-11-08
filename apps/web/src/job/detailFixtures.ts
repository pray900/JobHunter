import type { DocumentVersion, JobDetail } from '../api/types';

export const baseVersion: DocumentVersion = {
  id: 'v1',
  versionNo: 1,
  label: 'Generated',
  origin: 'generated',
  parentVersionId: null,
  manualEdits: [],
  isCurrent: true,
  createdAt: '2026-11-07T01:00:00.000Z',
  templateId: 'standard-ats',
  cv: {
    name: 'Sam Citizen',
    headline: 'Salesforce Developer',
    contact: {
      location: 'Sydney NSW',
      email: 'sam@example.com',
      phone: '0400 000 000',
      links: [{ label: 'GitHub', url: 'https://github.com/sam' }],
    },
    summary: 'I optimise Apex triggers for large orgs.',
    workRights: 'Australian citizen',
    skills: [{ group: 'Languages', items: ['Apex', 'JavaScript'] }],
    experience: [
      { title: 'Developer', employer: 'Acme', location: 'Sydney', dates: '2020 - 2024', bullets: ['Built LWC components.'] },
    ],
    education: [{ qualification: 'BSc', institution: 'UNSW', dates: '2016 - 2019', statusText: 'Completed' }],
    projects: [{ name: 'JobHunter', bullets: ['Local job tracker.'] }],
  },
  coverLetter: {
    date: '7 November 2026',
    addressee: 'Hiring Manager',
    salutation: 'Dear Hiring Manager,',
    paragraphs: ['I am keen on this role.', 'My Apex work fits.'],
    signOff: 'Yours sincerely,',
    name: 'Sam Citizen',
  },
  reasons: {
    templateReason: 'Plain layout reads best in applicant tracking systems.',
    changes: [{ target: 'cv.summary', what: 'Led with Apex', why: 'The ad asks for Apex first.' }],
    stretches: [{ target: 'cv.experience[0]', text: 'Built LWC components.', why: 'LWC is only lightly covered in your base CV.' }],
    factRulings: [],
  },
  keywordCoverage: { covered: ['Apex', 'LWC'], missing: [{ keyword: 'CPQ', why: 'Not in your base CV.' }] },
  review: {
    passed: false,
    rounds: 2,
    verdicts: ['fail', 'fail'],
    unresolved: [
      { source: 'review', id: 'ai_sounding', note: 'The summary sounds generic.' },
      { source: 'check', code: 'cv_pages', severity: 'hard', doc: 'cv', detail: 'The CV is 2 pages; the limit is 1.' },
    ],
  },
  checks: [
    { code: 'cv_pages', severity: 'hard', doc: 'cv', detail: 'The CV is 2 pages; the limit is 1.' },
    { code: 'link_unreachable', severity: 'warning', doc: 'cv', detail: 'https://github.com/sam did not answer.' },
  ],
  baseCvSourceRef: 'MyCV.docx',
  costUsd: 0.42,
};

export const baseDetail: JobDetail = {
  job: {
    id: 'j1',
    title: 'Salesforce Developer',
    employer: 'Acme',
    advertiser: null,
    url: 'https://au.seek.com/job/1',
    status: 'cv_ready',
    rawText: 'We need Apex and LWC. You will optimize triggers.',
    matchScore: 82,
    matchExplanation: 'Strong Apex fit.',
    matchBreakdown: { matched: ['Apex'], missing: ['CPQ'], notes: [] },
    warnings: [],
    companyNotes: null,
  },
  generation: { status: 'done', stage: 'saving', round: 2, attempts: 1, error: null },
  version: baseVersion,
  versions: 1,
  baseCv: null,
};
