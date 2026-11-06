import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { api, db, resetState, triggerSync, writeJobFile } from './lib';

const OWNER = '00000000-0000-0000-0000-000000000001';

async function listJobs(): Promise<any> {
  const res = await api.get('/api/jobs');
  expect(res.status).toBe(200);
  return res.json();
}

async function insertJob(ref: string, title: string, matchScore: number | null, createdAt?: string) {
  await db.query(
    `insert into jobs (owner_id, source, source_ref, content_hash, raw_text, title, extraction_status, match_score, created_at)
     values ($1, 'folder', $2, 'h', 'text', $3, 'done', $4, coalesce($5::timestamptz, now()))`,
    [OWNER, ref, title, matchScore, createdAt ?? null],
  );
}

describe('jobs API', () => {
  beforeEach(async () => {
    await resetState();
  });
  afterAll(async () => {
    await resetState();
  });

  test('lists jobs in the JobSummary shape', async () => {
    await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'Body' }]);
    await triggerSync();
    const { jobs } = await listJobs();
    expect(jobs).toHaveLength(1);
    expect(Object.keys(jobs[0]).sort()).toEqual(
      ['advertiser', 'createdAt', 'employer', 'extractionStatus', 'id', 'matchBreakdown', 'matchExplanation', 'matchScore', 'scoreStatus', 'shortDescription', 'sourceRef', 'sourceRemoved', 'status', 'title', 'url', 'warnings'].sort(),
    );
    expect(jobs[0]).toMatchObject({ sourceRef: 'a.docx', url: 'https://x.io/a', status: 'new', matchScore: null, matchExplanation: null, matchBreakdown: null, scoreStatus: 'pending', sourceRemoved: false });
    expect(Array.isArray(jobs[0].warnings)).toBe(true);
    expect(new Date(jobs[0].createdAt).toISOString()).toBe(jobs[0].createdAt);
  });

  test('orders by match score desc with unscored last', async () => {
    await insertJob('1.docx', 'forty', 40);
    await insertJob('2.docx', 'none', null);
    await insertJob('3.docx', 'ninety', 90);
    const { jobs } = await listJobs();
    expect(jobs.map((j: any) => j.title)).toEqual(['ninety', 'forty', 'none']);
    expect(typeof jobs[0].matchScore).toBe('number');
    expect(jobs[2].matchScore).toBeNull();
  });

  test('ties on score are newest first', async () => {
    await insertJob('1.docx', 'older', null, '2026-01-01T00:00:00Z');
    await insertJob('2.docx', 'newer', null, '2026-02-01T00:00:00Z');
    const { jobs } = await listJobs();
    expect(jobs.map((j: any) => j.title)).toEqual(['newer', 'older']);
  });

  test('empty list is an empty array', async () => {
    expect(await listJobs()).toEqual({ jobs: [] });
  });
});
