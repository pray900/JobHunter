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
  expect(await runMigrations(pool, MIGRATIONS_DIR)).toEqual(['001_init.sql', '002_base_documents.sql']);
  expect(await runMigrations(pool, MIGRATIONS_DIR)).toEqual([]);
  const { rows } = await pool.query('select id, name from users');
  expect(rows).toEqual([{ id: USER_ID, name: 'Prayush' }]);
});

test('applies 002 after 001', async () => {
  await pool.query('drop schema public cascade; create schema public;');
  const dir001 = await fs.mkdtemp(path.join(os.tmpdir(), 'jobhunter-mig-'));
  try {
    await fs.copyFile(path.join(MIGRATIONS_DIR, '001_init.sql'), path.join(dir001, '001_init.sql'));
    expect(await runMigrations(pool, dir001)).toEqual(['001_init.sql']);
  } finally {
    await fs.rm(dir001, { recursive: true, force: true });
  }
  expect(await runMigrations(pool, MIGRATIONS_DIR)).toEqual(['002_base_documents.sql']);
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
