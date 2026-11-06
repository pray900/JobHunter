import type { JobSummary } from '../api/types';

export const baseJob: JobSummary = {
  id: '1',
  title: 'Developer',
  employer: null,
  advertiser: null,
  shortDescription: null,
  url: null,
  status: 'new',
  matchScore: null,
  warnings: [],
  extractionStatus: 'done',
  sourceRemoved: false,
  sourceRef: 'dev.docx',
  createdAt: '2026-11-01T00:00:00.000Z',
};

export function job(over: Partial<JobSummary>): JobSummary {
  return { ...baseJob, ...over };
}
