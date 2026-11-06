import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
  api,
  db,
  makePdf,
  resetState,
  triggerScoring,
  triggerSync,
  putDocument,
  writeJobFile,
} from './lib';

const OWNER = '00000000-0000-0000-0000-000000000001';

async function listJobs(): Promise<any> {
  const res = await api.get('/api/jobs');
  expect(res.status).toBe(200);
  return res.json();
}

async function insertJob(ref: string, title: string, matchScore: number | null, createdAt?: string, basis: string | null = null) {
  await db.query(
    `insert into jobs (owner_id, source, source_ref, content_hash, raw_text, title, extraction_status, match_score,
                       match_basis_hash, score_status, created_at)
     values ($1, 'folder', $2, 'h', 'text', $3, 'done', $4, $6, case when $4::int is null then 'pending' else 'done' end,
             coalesce($5::timestamptz, now()))`,
    [OWNER, ref, title, matchScore, createdAt ?? null, basis],
  );
}

/** Uploads the base CV (which analyses it). Returns its hash (the scoring basis). */
async function readyCv(tag = 'v1'): Promise<string> {
  await putDocument('cv', 'cv.pdf', makePdf(`Base CV STUB_HEADLINE:${tag}`));
  const [cv] = await db.query(`select content_hash from base_documents where kind='cv' and active and analysis_status='done'`);
  expect(cv).toBeDefined();
  return cv.content_hash;
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
    const basis = await readyCv();
    await insertJob('1.docx', 'forty', 40, undefined, basis);
    await insertJob('2.docx', 'none', null);
    await insertJob('3.docx', 'ninety', 90, undefined, basis);
    const { jobs } = await listJobs();
    expect(jobs.map((j: any) => j.title)).toEqual(['ninety', 'forty', 'none']);
    expect(typeof jobs[0].matchScore).toBe('number');
    expect(jobs[2].matchScore).toBeNull();
  });

  test('a score from another basis is hidden, the card shows pending, and ordering uses the returned score', async () => {
    const basis = await readyCv();
    await insertJob('1.docx', 'current', 40, undefined, basis);
    await insertJob('2.docx', 'old cv', 95, undefined, 'older-basis');
    const { jobs } = await listJobs();
    expect(jobs.map((j: any) => j.title)).toEqual(['current', 'old cv']);
    expect(jobs[0]).toMatchObject({ matchScore: 40, scoreStatus: 'done' });
    expect(jobs[1]).toMatchObject({ matchScore: null, matchExplanation: null, matchBreakdown: null, scoreStatus: 'pending' });
  });

  test('CV replaced: old scores disappear; they come back only after rescoring', async () => {
    await readyCv('v1');
    await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'Job A' }]);
    await triggerSync();
    expect((await triggerScoring()).scored).toBe(1);
    expect((await listJobs()).jobs[0]).toMatchObject({ scoreStatus: 'done' });
    expect(typeof (await listJobs()).jobs[0].matchScore).toBe('number');

    // A different CV that is analysed: the old score stays hidden (pending) until the job is rescored.
    await putDocument('cv', 'cv2.pdf', makePdf('Base CV STUB_HEADLINE:v2'));
    expect((await listJobs()).jobs[0]).toMatchObject({ matchScore: null, matchExplanation: null, matchBreakdown: null, scoreStatus: 'pending' });
    expect((await triggerScoring()).scored).toBe(1);
    const job = (await listJobs()).jobs[0];
    expect(job.scoreStatus).toBe('done');
    expect(typeof job.matchScore).toBe('number');
  });

  test('a replacement CV whose analysis failed: no score is shown', async () => {
    await readyCv('v1');
    await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'Job A' }]);
    await triggerSync();
    expect((await triggerScoring()).scored).toBe(1);
    // No ready CV any more, so no score is shown, whatever was saved.
    await putDocument('cv', 'cv2.pdf', makePdf('STUB_FAIL please'));
    expect((await listJobs()).jobs[0]).toMatchObject({ matchScore: null, matchExplanation: null, matchBreakdown: null });
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
