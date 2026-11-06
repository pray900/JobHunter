import { describe, expect, test } from 'vitest';
import { filterJobs, sortJobs } from './filterJobs';
import { job } from './jobFixtures';

const jobs = [
  job({ id: '1', title: 'Salesforce Developer', employer: 'Globex', status: 'new' }),
  job({ id: '2', title: 'Analyst', employer: 'Acme Corp', status: 'applied' }),
  job({ id: '3', title: 'Engineer', advertiser: 'ACME Recruit', status: 'new' }),
  job({ id: '4', title: 'Tester', shortDescription: 'Works with acme tools', status: 'applied' }),
];
const s = (matchScore: number | null) => job({ matchScore });

describe('filterJobs', () => {
  test('filters by status and query, keeping order', () => {
    expect(filterJobs(jobs, { status: 'applied', query: 'acme' }).map((j) => j.id)).toEqual(['2', '4']);
  });
  test('query is case-insensitive and matches title, employer, advertiser, description', () => {
    expect(filterJobs(jobs, { status: 'all', query: 'ACME' }).map((j) => j.id)).toEqual(['2', '3', '4']);
    expect(filterJobs(jobs, { status: 'all', query: 'salesforce' }).map((j) => j.id)).toEqual(['1']);
  });
  test('query also matches sourceRef (the heading of untitled cards)', () => {
    const untitled = [job({ id: 'u', title: null, sourceRef: 'Contoso-Platform-Lead.docx' }), ...jobs];
    expect(filterJobs(untitled, { status: 'all', query: 'contoso' }).map((j) => j.id)).toEqual(['u']);
  });
  test('all + empty query returns everything', () => {
    expect(filterJobs(jobs, { status: 'all', query: '' })).toEqual(jobs);
  });
});

describe('sortJobs', () => {
  test('puts unscored last', () => {
    expect(sortJobs([s(null), s(40), s(90)]).map((j) => j.matchScore)).toEqual([90, 40, null]);
  });
  test('ties break by newest first', () => {
    const a = job({ id: 'a', matchScore: 50, createdAt: '2026-01-01T00:00:00.000Z' });
    const b = job({ id: 'b', matchScore: 50, createdAt: '2026-02-01T00:00:00.000Z' });
    expect(sortJobs([a, b]).map((j) => j.id)).toEqual(['b', 'a']);
  });
});
