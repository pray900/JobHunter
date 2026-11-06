import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from './db/migrate.js';
import { buildServer } from './server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const pool = new pg.Pool({ connectionString: databaseUrl });
const migrationsDir = process.env.MIGRATIONS_DIR ?? path.resolve(here, '../../../db/migrations');
const applied = await runMigrations(pool, migrationsDir);
console.log(`migrations applied: ${applied.join(', ') || 'none'}`);

const app = buildServer({
  jobFolderDir: process.env.JOBLISTING_DIR ?? './Joblisting',
  // A Docker named volume in compose; never the old PersonalDetails* folders.
  documentsDir: process.env.DOCUMENTS_DIR ?? '/data/documents',
  logger: true,
});
await app.listen({ host: '0.0.0.0', port: 3001 });
