# JobHunter

Local app (n8n + TypeScript worker + Postgres + React) that turns Word job ads into job cards.

## Pinned versions

- n8n: `n8nio/n8n:2.46.6` (latest stable on 2026-11-06)
- Postgres: `postgres:17`
- Worker: Node 24

## Run it

1. `cp .env.example .env`
2. Edit `.env`: set `ANTHROPIC_API_KEY`, and replace `POSTGRES_PASSWORD` and `N8N_ENCRYPTION_KEY` with random values.
3. Put Word job ads (`.docx`) in `./Joblisting` (or set `JOBLISTING_DIR`). It is mounted read-only into the worker.
4. `docker compose up -d --build`
5. Run Task 4's bootstrap to import the n8n workflows (see later tasks).

n8n runs at http://localhost:5678. The worker listens on 3001 inside the compose network only.

## Tests

- Start the test database: `docker compose -f docker-compose.test.yml up -d postgres`
- `npm install` then `npm test -w services/worker` (uses `TEST_DATABASE_URL`, default `postgres://jobhunter:test@localhost:55433/jobhunter`)
- Stop: `docker compose -f docker-compose.test.yml down`

The test stack (`docker-compose.test.yml`, project `jobhunter-test`) uses host ports 55433 (postgres), 55678 (n8n), 58080 (web, later) and `./.tmp/e2e-joblisting` as the job folder.
