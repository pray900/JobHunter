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
  expect(await runMigrations(pool, MIGRATIONS_DIR)).toEqual(['001_init.sql']);
  expect(await runMigrations(pool, MIGRATIONS_DIR)).toEqual([]);
  const { rows } = await pool.query('select id, name from users');
  expect(rows).toEqual([{ id: USER_ID, name: 'Prayush' }]);
});

test('jobs are unique per owner/source/source_ref', async () => {
  const insert = `insert into jobs(owner_id, source, source_ref, content_hash, raw_text) values ($1,'folder','a.docx','h','t')`;
  await pool.query(insert, [USER_ID]);
  await expect(pool.query(insert, [USER_ID])).rejects.toThrow(/duplicate key/);
});
