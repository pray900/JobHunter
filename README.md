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
5. `bash scripts/n8n-bootstrap.sh` to load credentials and workflows into n8n (see Testing > Bootstrap).

n8n runs at http://localhost:5678. The worker listens on 3001 inside the compose network only.

## Tests

- Start the test database: `docker compose -f docker-compose.test.yml up -d postgres`
- `npm install` then `npm test -w services/worker` (uses `TEST_DATABASE_URL`, default `postgres://jobhunter:test@localhost:55433/jobhunter`)
- Stop: `docker compose -f docker-compose.test.yml down`

The test stack (`docker-compose.test.yml`, project `jobhunter-test`) uses host ports 55433 (postgres), 55678 (n8n), 58080 (web, later) and `./.tmp/e2e-joblisting` as the job folder.

## Testing (e2e)

`npm run e2e` brings up the `jobhunter-test` stack (`docker compose -f docker-compose.test.yml up -d --build --wait`), runs `scripts/n8n-bootstrap.sh`, runs `tests/e2e/*.e2e.test.ts`, then tears the stack down (`down -v`). Set `E2E_KEEP_STACK=1` to leave it running while iterating.

The test stack includes `anthropic-stub` (host port 58081), a fake Anthropic Messages API that n8n reaches via `ANTHROPIC_BASE_URL`. It requires `x-api-key` and `anthropic-version: 2026-10-21` (else 400); user text containing `STUB_FAIL` returns 500, `STUB_REFUSE` returns `stop_reason: "refusal"`, anything else returns a canned extraction. `GET /_requests` lists recorded request bodies, `POST /_reset` clears them. Helpers live in `tests/e2e/lib.ts` (`stack`, `writeJobFile`, `removeJobFile`, `triggerSync`, `db`, `stub`, `api`).

### Bootstrap

`scripts/n8n-bootstrap.sh [compose-file]` (default `docker-compose.yml`; run with bash, Git Bash on Windows is fine) is idempotent. For n8n 2.46.6 it:

1. Waits for `/healthz`.
2. Creates the owner account via `POST /rest/owner/setup` (n8n 2.x needs an owner to own imported items; an already-set-up instance just returns a 4xx, ignored). Defaults `owner@jobhunter.local` / `Jobhunter-Local-1`, override with `N8N_OWNER_EMAIL` / `N8N_OWNER_PASSWORD`.
3. Builds the credentials JSON (`jh-postgres` / "JobHunter Postgres", `jh-anthropic` / "Anthropic") from the postgres container's `POSTGRES_PASSWORD` and `ANTHROPIC_API_KEY` in `.env`, pipes it over stdin to a temp file inside the n8n container, runs `n8n import:credentials --input=/tmp/jh-credentials.json`, then deletes it. Fixed ids make re-import an upsert. With the test compose file an empty key becomes a dummy.
4. `n8n import:workflow --separate --input=/workflows` (imported inactive; workflow JSON needs stable `id`s to stay idempotent).
5. `n8n publish:workflow --id=<id>` for every id from `n8n list:workflow --onlyId` (2.x replaced `update:workflow --active`; `publish:workflow --all` is no longer supported).
6. If any workflows exist, restarts the n8n container (publish only takes effect on restart) and waits until it is healthy and has finished registering published workflows.

Workflows removed from `n8n/workflows/` are not deleted from n8n by re-running the bootstrap.
