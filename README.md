# JobHunter

A local app that turns Word job ads into job cards. Four parts run in Docker: Postgres (data), a TypeScript worker (reads the `.docx` files), n8n (the workflows that glue it together and call Claude) and a React web page.

Everything runs on your machine. The only thing that leaves it is the job ad text sent to Claude to pull out the title, employer and a short summary.

## Pinned versions

- n8n: `n8nio/n8n:2.46.6` (latest stable on 2026-11-06)
- Postgres: `postgres:17`
- Worker: Node 24
- Extraction model: `claude-haiku-5-5` (set by `EXTRACT_MODEL`)

## Set it up from scratch

You need Docker Desktop (running) and Git Bash. Run every command below from the project folder in Git Bash.

1. Copy the settings file: `cp .env.example .env`
2. Open `.env` and set:
   - `ANTHROPIC_API_KEY` to your key.
   - `POSTGRES_PASSWORD` and `N8N_ENCRYPTION_KEY` to your own random values (replace `change-me`).
   - Leave `N8N_OWNER_EMAIL` and `N8N_OWNER_PASSWORD` empty; the bootstrap fills them in.
3. Create the job folder: `mkdir -p Joblisting` (or the folder you set in `JOBLISTING_DIR`). It must exist before you start the stack; see Where to put job files.
4. Start everything: `docker compose up -d --build`
5. Load the credentials and workflows into n8n: `bash scripts/n8n-bootstrap.sh`

   It creates your n8n login, saves it in `.env` (it only prints "n8n owner login saved in .env"), imports the workflows and publishes them. It is safe to run again, but it resets the shipped workflows to the repo JSON (see Bootstrap below).
6. Open the job board: http://localhost:8080

Until you add job files the board is empty. Match scores arrive in Plan 2, so every card says "Not scored yet" for now.

Every service has `restart: unless-stopped`, so after a reboot Docker Desktop brings the stack back by itself once it starts. If it is not running, start it with `docker compose up -d`.

## Where to put job files

Put one Word file (`.docx`) per job in the `Joblisting/` folder in the project root. To use another folder, set `JOBLISTING_DIR` in `.env` and run `docker compose up -d` again. The worker sees the folder read-only.

The folder must exist before `docker compose up`. The worker mount is declared with `create_host_path: false`, so on a Linux Docker engine a missing folder stops the worker from starting instead of Compose creating an empty one. Docker Desktop on Windows still creates a missing folder for the mount, so there check the path in `JOBLISTING_DIR` yourself: a typo gives you an empty board, not an error.

- The first non-empty line of the file must be the link to the job posting. That becomes the "Open job posting" button on the card.
- The folder is checked every 30 seconds. A new file becomes a card, an edited file is read again, and a deleted or renamed file keeps its card but shows "Source file removed".
- Word's temporary lock files (names starting with `~$`) are ignored.
- If the folder is missing or cannot be read, the sync fails loudly and changes nothing. It never marks jobs as removed because of a broken scan.
- `Joblisting/`, `PersonalDetailsCV/`, `PersonalDetailsCoverLetter/` and `.env` are git-ignored, so personal data is never committed.

## Open n8n

Go to http://localhost:5678. The login is in `.env`: `N8N_OWNER_EMAIL` and `N8N_OWNER_PASSWORD`. The web page is on port 8080; the worker and Postgres are only reachable inside the Docker network (use `docker compose exec postgres psql -U jobhunter` for the database).

In the left menu click **Workflows**, then open one. Each workflow has coloured sticky notes (`## 1. ...`, `## 2. ...`) that group the nodes into stages. Read them left to right. To see what a run did, open **Executions** in the workflow and click a run; each node shows the data it received and produced.

## Reading the workflows in n8n

### Job intake sync

Runs every 30 seconds and also when the web page or a test calls `POST /webhook/api/jobs/sync`.

- **Start**: the "Every 30 seconds" schedule (switched off when `JOBHUNTER_SCHEDULE_ENABLED` is `false`, as in the test stack) or the webhook.
- **1. Scan folder**: asks the worker to read every `.docx`. If the scan fails, the run answers 502 and stops with no changes.
- **2. Upsert jobs**: one query per file. New file: insert the job and its first status. Known file: refresh the text and link, and only if the content changed reset the extraction. Unreadable or empty files are marked `skipped` and never sent to Claude.
- **3. Mark removed files**: jobs whose file is gone get `source_removed = true`. The job itself is kept.
- **4. Claim pending extractions**: gives up on claims stuck for over 5 minutes, checks `EXTRACT_MODEL` has a known price (stops before spending anything if not), then claims the jobs to extract (new or changed, or failed with fewer than 3 attempts once they have waited 1 minute after the first attempt or 5 minutes after the second, so a short outage does not use up all 3 attempts).
- **5. Ask Claude**: one call per claimed job, using structured output so the answer is always title, employer, advertiser and short description.
- **6. Save details or failure**: a good answer is saved and the job is `done`; anything else is `failed` and retried (after 1, then 5 minutes) up to 3 attempts in total. Token cost is logged in `cost_log`. Saves only apply if the job still holds this run's claim.
- **Finish**: waits for all branches and answers the webhook with `{ ok, scanned, extracted }`.

### Jobs API

Serves the job board.

- **Start**: `GET /webhook/api/jobs`, called by the web page.
- **1. Read the job list**: one SQL query returns the whole list as a JSON array, so an empty table gives `[]`. Best match first, unscored jobs last, newest first on ties.
- **2. Reply**: answers `200 { jobs: [...] }`.

Both webhooks ("GET api/jobs" here and "POST api/jobs/sync" in Job intake sync) set **Allowed Origins (CORS)** to `http://localhost:8080,http://localhost:5173` (the board and the Vite dev server), so other websites you visit cannot read your jobs through your browser. nginx also strips n8n's CORS headers from `/api/`, since the board calls it from its own origin.

## Cost

Each new job costs about $0.0005 in Claude calls at Haiku 5.5 prices. Reading the folder every 30 seconds costs nothing; Claude is only called for new or changed files (and retries of failed ones). Check the real total any time with `docker compose exec postgres psql -U jobhunter -c "select sum(cost_usd) from cost_log"`.

## Tests

Run the commands from the project folder.

- Unit tests: start the test database with `docker compose -f docker-compose.test.yml up -d postgres`, run `npm install`, then `npm test`. It runs the worker and web tests; the worker tests need that test database (`TEST_DATABASE_URL`, default `postgres://jobhunter:test@localhost:55433/jobhunter`), the web tests alone (`npm test -w apps/web`) need nothing. Stop the database with `docker compose -f docker-compose.test.yml down`.
- End-to-end: `npm run e2e` (needs Docker running; it starts and removes its own separate stack).

The test stack (`docker-compose.test.yml`, project `jobhunter-test`) uses host ports 55433 (postgres), 55678 (n8n), 58080 (web) and 58081 (fake Anthropic), all bound to 127.0.0.1, and `./.tmp/e2e-joblisting` as the job folder. It never touches your real data or key.


### End-to-end details

`npm run e2e` brings up the `jobhunter-test` stack (`docker compose -f docker-compose.test.yml up -d --build --wait`), runs `scripts/n8n-bootstrap.sh`, runs `tests/e2e/*.e2e.test.ts`, then tears the stack down (`down -v`). Set `E2E_KEEP_STACK=1` to leave it running while iterating.

The test stack includes `anthropic-stub` (host port 58081), a fake Anthropic Messages API that n8n reaches via `ANTHROPIC_BASE_URL`. It requires `x-api-key` and `anthropic-version: 2026-10-21` (else 400); user text containing `STUB_FAIL` returns 500, `STUB_REFUSE` returns `stop_reason: "refusal"`, anything else returns a canned extraction. `GET /v1/models` (used by the bootstrap key check) answers 200 for any key except `bad-key` (401). `GET /_requests` lists recorded Messages request bodies, `POST /_reset` clears them. Helpers live in `tests/e2e/lib.ts` (`stack`, `writeJobFile`, `removeJobFile`, `triggerSync`, `db`, `stub`, `api`).

### Bootstrap

`scripts/n8n-bootstrap.sh [compose-file]` (default `docker-compose.yml`; run with bash, Git Bash on Windows is fine) is idempotent. `JOBHUNTER_ENV_FILE` overrides which env file it reads and writes (default `.env` in the project folder). Values in `.env` may be wrapped in one pair of matching quotes (`KEY="value"` or `KEY='value'`); the quotes are stripped. For n8n 2.46.6 it:

1. Waits for `/healthz`.
2. Creates the owner account (n8n 2.x needs an owner to own imported items) after checking `/rest/settings` for setup state; an already-set-up instance is fine, any other failure aborts. Real stack: `N8N_OWNER_EMAIL` / `N8N_OWNER_PASSWORD` come from `.env`; if missing, the script generates a random password (email default `prayush@jobhunter.local`), appends them to the git-ignored `.env` and prints only "n8n owner login saved in .env". Only `docker-compose.test.yml` (detected by file name) uses a fixed throwaway login. The real stack's n8n port is bound to 127.0.0.1.
3. Real stack only: checks `ANTHROPIC_API_KEY` from `.env` with a free `GET /v1/models` request, run inside the n8n container with the key passed over stdin (never on a command line, never printed). A rejected key (401/403) stops with "Your Anthropic API key was rejected — check ANTHROPIC_API_KEY in .env"; a network error or any other status also stops, naming the status. `JOBHUNTER_ANTHROPIC_BASE_URL` overrides the URL checked (the tests point it at the stub).
4. Builds the credentials JSON (`jh-postgres` / "JobHunter Postgres", `jh-anthropic` / "Anthropic") from the postgres container's `POSTGRES_PASSWORD` and `ANTHROPIC_API_KEY` in `.env`, pipes it over stdin to a temp file inside the n8n container, runs `n8n import:credentials --input=/tmp/jh-credentials.json`, then deletes it (a trap also deletes it if the script fails or is interrupted). Fixed ids make re-import an upsert. The test stack always uses a dummy key, never the real one.
5. `n8n import:workflow --separate --input=/workflows` (imported inactive; workflow JSON needs stable `id`s to stay idempotent).
6. `n8n publish:workflow --id=<id>` for each workflow `id` in `n8n/workflows/*.json` (2.x replaced `update:workflow --active`; `publish:workflow --all` is no longer supported). Workflows you created yourself in n8n are not published or changed.
7. If any shipped workflows exist, restarts the n8n container (publish only takes effect on restart), waits for `/healthz`, then probes every webhook path found in `n8n/workflows/*.json` (with a non-matching HTTP method, so nothing runs) until n8n reports it registered; exits non-zero on timeout. CLI failures abort the script.

Re-running the bootstrap resets the shipped workflows ("Job intake sync" and "Jobs API") to the JSON in `n8n/workflows/`, so edits you made to them in the n8n editor are overwritten. Export your edits first (in the workflow, **...** > **Download**, or `docker compose exec n8n n8n export:workflow --id=<id>`). Your own workflows are left alone. Workflows removed from `n8n/workflows/` are not deleted from n8n.

## Troubleshooting

- Cards stuck on "Details unavailable" after you fixed `ANTHROPIC_API_KEY` (wrong key, or a key saved with quotes by an older bootstrap): extraction gave up after 3 failed attempts. Re-run `bash scripts/n8n-bootstrap.sh` to load the fixed key, then queue the failed jobs again with `docker compose exec postgres psql -U jobhunter -c "update jobs set extraction_status='pending', extraction_attempts=0 where extraction_status='failed';"`. The next sync (within 30 seconds) retries them.
