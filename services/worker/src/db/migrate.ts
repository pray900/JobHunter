import fs from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

/** Applies pending *.sql files in filename order; returns the filenames applied. */
export async function runMigrations(pool: pg.Pool, dir: string): Promise<string[]> {
  await pool.query(
    `create table if not exists schema_migrations (
       filename text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
  const { rows } = await pool.query<{ filename: string }>('select filename from schema_migrations');
  const done = new Set(rows.map((r) => r.filename));
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await fs.readFile(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations(filename) values ($1)', [file]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
    applied.push(file);
  }
  return applied;
}
