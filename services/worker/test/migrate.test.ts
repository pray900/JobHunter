import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

const USER_ID = '00000000-0000-0000-0000-000000000001';
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://jobhunter:test@localhost:55433/jobhunter',
});

beforeAll(async () => {
  await pool.query('drop schema public cascade; create schema public;');
});
afterAll(async () => {
  await pool.end();
});

test('applies 001_init once and seeds the single user', async () => {
  expect(await runMigrations(pool, MIGRATIONS_DIR)).toEqual([
    '001_init.sql',
    '002_base_documents.sql',
    '003_single_base_document.sql',
    '004_generation.sql',
  ]);
  expect(await runMigrations(pool, MIGRATIONS_DIR)).toEqual([]);
  const { rows } = await pool.query('select id, name from users');
  expect(rows).toEqual([{ id: USER_ID, name: 'Prayush' }]);
});

// Applies only the named migrations from the repo, so later ones can be tested on an older DB.
async function migrateUpTo(files: string[]): Promise<string[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jobhunter-mig-'));
  try {
    for (const f of files) await fs.copyFile(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
    return await runMigrations(pool, dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('applies 002 after 001', async () => {
  await pool.query('drop schema public cascade; create schema public;');
  expect(await migrateUpTo(['001_init.sql'])).toEqual(['001_init.sql']);
  expect(await migrateUpTo(['001_init.sql', '002_base_documents.sql'])).toEqual(['002_base_documents.sql']);
});

test('applies 003 after 002: no labels or conflict checks, one active document per kind', async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrateUpTo(['001_init.sql', '002_base_documents.sql']);
  await pool.query(
    `insert into base_documents(owner_id, kind, source_ref, content_hash, media_type, label) values ($1,'cv','old.pdf','h','application/pdf','x')`,
    [USER_ID],
  );
  expect(await migrateUpTo(['001_init.sql', '002_base_documents.sql', '003_single_base_document.sql'])).toEqual([
    '003_single_base_document.sql',
  ]);
  const { rows: cols } = await pool.query(
    `select column_name from information_schema.columns where table_name = 'base_documents' and column_name in ('label','label_suggested','active')`,
  );
  expect(cols.map((c) => c.column_name)).toEqual(['active']);
  const { rows: tables } = await pool.query(`select to_regclass('base_document_checks') as t`);
  expect(tables).toEqual([{ t: null }]);
  const { rows: existing } = await pool.query(`select active from base_documents where source_ref = 'old.pdf'`);
  expect(existing).toEqual([{ active: false }]);

  const insert = `insert into base_documents(owner_id, kind, source_ref, content_hash, media_type, active) values ($1,$2,$3,'h','application/pdf',$4)`;
  await pool.query(insert, [USER_ID, 'cv', 'a.pdf', true]);
  await pool.query(insert, [USER_ID, 'cv', 'b.pdf', false]);
  await pool.query(insert, [USER_ID, 'cover_letter', 'c.pdf', true]);
  await expect(pool.query(insert, [USER_ID, 'cv', 'd.pdf', true])).rejects.toThrow(/duplicate key/);
});

test('jobs are unique per owner/source/source_ref', async () => {
  const insert = `insert into jobs(owner_id, source, source_ref, content_hash, raw_text) values ($1,'folder','a.docx','h','t')`;
  await pool.query(insert, [USER_ID]);
  await expect(pool.query(insert, [USER_ID])).rejects.toThrow(/duplicate key/);
});

test('base_documents unique per owner/kind/source_ref', async () => {
  const insert = `insert into base_documents(owner_id, kind, source_ref, content_hash, media_type) values ($1,'cv','cv.pdf','h','application/pdf')`;
  await pool.query(insert, [USER_ID]);
  await expect(pool.query(insert, [USER_ID])).rejects.toThrow(/duplicate key/);
});

test('jobs.score_status defaults to pending', async () => {
  await pool.query(
    `insert into jobs(owner_id, source, source_ref, content_hash, raw_text) values ($1,'folder','score.docx','h','t')`,
    [USER_ID],
  );
  const { rows } = await pool.query(`select score_status, score_attempts from jobs where source_ref = 'score.docx'`);
  expect(rows).toEqual([{ score_status: 'pending', score_attempts: 0 }]);
});

test('applies 004 after 003', async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrateUpTo(['001_init.sql', '002_base_documents.sql', '003_single_base_document.sql']);
  expect(await runMigrations(pool, MIGRATIONS_DIR)).toEqual(['004_generation.sql']);
  const { rows } = await pool.query(
    `select to_regclass('generation_runs') as r, to_regclass('document_versions') as v,
       (select count(*) from information_schema.columns where table_name='jobs' and column_name='company_notes')::int as n,
       (select count(*) from information_schema.columns where table_name='cost_log' and column_name='generation_run_id')::int as c`,
  );
  expect(rows[0]).toMatchObject({ r: 'generation_runs', v: 'document_versions', n: 1, c: 1 });
});

test('only one active run per job', async () => {
  const { rows } = await pool.query(
    `insert into jobs(owner_id, source, source_ref, content_hash, raw_text) values ($1,'folder','run.docx','h','t') returning id`,
    [USER_ID],
  );
  const jobId = rows[0].id;
  const insert = `insert into generation_runs(owner_id, job_id, status) values ($1,$2,$3)`;
  await pool.query(insert, [USER_ID, jobId, 'done']);
  await pool.query(insert, [USER_ID, jobId, 'pending']);
  await expect(pool.query(insert, [USER_ID, jobId, 'pending'])).rejects.toThrow(/duplicate key/);
  await expect(pool.query(insert, [USER_ID, jobId, 'in_progress'])).rejects.toThrow(/duplicate key/);
});

test('004 re-queues a done CV without a name', async () => {
  await pool.query('drop schema public cascade; create schema public;');
  await migrateUpTo(['001_init.sql', '002_base_documents.sql', '003_single_base_document.sql']);
  const insert = `insert into base_documents(owner_id, kind, source_ref, content_hash, media_type, active, analysis_status, analysis_attempts, structured)
    values ($1,$2,$3,'h','application/pdf',$4,'done',1,$5::jsonb)`;
  await pool.query(insert, [USER_ID, 'cv', 'noname.pdf', true, JSON.stringify({ headline: 'x' })]);
  await pool.query(insert, [USER_ID, 'cover_letter', 'letter.pdf', true, JSON.stringify({ tone: 'x' })]);
  expect(await runMigrations(pool, MIGRATIONS_DIR)).toEqual(['004_generation.sql']);
  const { rows } = await pool.query(`select source_ref, analysis_status, analysis_attempts from base_documents order by source_ref`);
  expect(rows).toEqual([
    { source_ref: 'letter.pdf', analysis_status: 'done', analysis_attempts: 1 },
    { source_ref: 'noname.pdf', analysis_status: 'pending', analysis_attempts: 0 },
  ]);

  await pool.query('drop schema public cascade; create schema public;');
  await migrateUpTo(['001_init.sql', '002_base_documents.sql', '003_single_base_document.sql']);
  await pool.query(insert, [USER_ID, 'cv', 'named.pdf', true, JSON.stringify({ name: 'A Person' })]);
  await runMigrations(pool, MIGRATIONS_DIR);
  const { rows: after } = await pool.query(`select analysis_status, analysis_attempts from base_documents`);
  expect(after).toEqual([{ analysis_status: 'done', analysis_attempts: 1 }]);
});
