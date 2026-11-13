# JobHunter

A local app that turns Word job ads into job cards and scores each one against your base CV. Five parts run in Docker: Postgres (data), a TypeScript worker (reads the `.docx` files), Gotenberg (makes PDFs), n8n (the workflows that glue it together and call Claude) and a React web page.

Everything runs on your machine. The only things that leave it are the job ad text, your CV and your cover letter, which are sent to Claude (see Cost for when).

## Pinned versions

- n8n: `n8nio/n8n:2.46.6` (latest stable on 2026-11-06)
- Postgres: `postgres:17`
- Worker: Node 24
- Job extraction model: `claude-haiku-5-5` (`EXTRACT_MODEL`)
- CV and cover letter reading model: `claude-opus-5-5` (`ANALYSE_MODEL`)
- Match scoring model: `claude-sonnet-5-5` (`SCORE_MODEL`)
- CV and cover letter writer: `claude-opus-5-5` (`WRITER_MODEL`)
- Independent reviewer: `claude-opus-5-5` (`REVIEW_MODEL`); at most `GENERATION_MAX_ROUNDS` (default 3, at most 5) write-and-review rounds per Generate

## Set it up from scratch

You need Docker Desktop (running) and Git Bash. Run every command below from the project folder in Git Bash.

1. Copy the settings file: `cp .env.example .env`
2. Open `.env` and set:
   - `ANTHROPIC_API_KEY` to your key. The other keys (`ANALYSE_MODEL`, `SCORE_MODEL`, `EXTRACT_MODEL`, `JOBLISTING_DIR`) already have working defaults.
   - `POSTGRES_PASSWORD` and `N8N_ENCRYPTION_KEY` to your own random values (replace `change-me`).
   - Leave `N8N_OWNER_EMAIL` and `N8N_OWNER_PASSWORD` empty; the bootstrap fills them in.
3. Create the job folder: `mkdir -p Joblisting` (or the folder you set in `JOBLISTING_DIR`). It must exist before you start the stack; see Where to put job files.
4. Start everything: `docker compose up -d --build`
5. Load the credentials and workflows into n8n: `bash scripts/n8n-bootstrap.sh`

   It creates your n8n login, saves it in `.env` (it only prints "n8n owner login saved in .env"), imports the workflows and publishes them. It is safe to run again, but it resets the shipped workflows to the repo JSON (see Bootstrap below).
6. Open the job board: http://localhost:8080

Until you add job files the board is empty. Open **My documents** (top menu) and upload your CV first; until a CV is read, cards say "Not scored yet".

Every service has `restart: unless-stopped`, so after a reboot Docker Desktop brings the stack back by itself once it starts. If it is not running, start it with `docker compose up -d`.

## Where to put job files

Put one Word file (`.docx`) per job in the `Joblisting/` folder in the project root. To use another folder, set `JOBLISTING_DIR` in `.env` and run `docker compose up -d` again. The worker sees the folder read-only.

The folder must exist before `docker compose up`. The worker mount is declared with `create_host_path: false`, so on a Linux Docker engine a missing folder stops the worker from starting instead of Compose creating an empty one. Docker Desktop on Windows still creates a missing folder for the mount, so there check the path in `JOBLISTING_DIR` yourself: a typo gives you an empty board, not an error.

- The first non-empty line of the file must be the link to the job posting. That becomes the "Open job posting" button on the card.
- The folder is checked every 60 seconds. A new file becomes a card, an edited file is read again, and a deleted or renamed file keeps its card but shows "Source file removed".
- Word's temporary lock files (names starting with `~$`) are ignored.
- If the folder is missing or cannot be read, the sync fails loudly and changes nothing. It never marks jobs as removed because of a broken scan.
- `Joblisting/`, `.env` and the old `PersonalDetailsCV/` / `PersonalDetailsCoverLetter/` folders are git-ignored, so personal data is never committed.

## My documents (your CV and cover letter)

JobHunter uses **one** base CV and **one** base cover letter, and they only come in through the app. Open http://localhost:8080/documents (**My documents** in the top menu). There are two slots, one for the CV and one for the cover letter.

1. Click **Upload CV** (or **Upload cover letter**) in an empty slot and choose a `.pdf` or `.docx` (up to 5 MB). It is read by Claude straight away; the slot shows "Analysing…", then "Ready".
2. To change it, click **Replace** in the slot and confirm in the page. The new file replaces the current one in one step; if the upload fails, the current file stays. Uploading the same file again changes nothing and costs nothing.
3. After reading, each slot shows warnings: **work rights** missing or unclear, **degree status** unclear, and **banned phrases** found in the letter (for example "leveraging", "fast-paced"). A Word file with no text in it shows "Couldn't read this file" and is never sent to Claude.

If reading your CV or letter failed 3 times, uploading it again tries again (about $0.06 for a CV, $0.03 for a letter).

Where the files are kept:

- The worker keeps the uploaded files in its own storage, a Docker volume (`documents_data`, mounted at `/data/documents` inside the worker). Nothing on your disk outside Docker is read or written, and there is no delete: you can only replace a file.
- Uploaded file names are cleaned to letters, digits, space and `. _ ( ) -`.
- `docker compose down` keeps the volume; `docker compose down -v` deletes it together with the database, after which you upload your CV and cover letter again.
- The old `PersonalDetailsCV/` and `PersonalDetailsCoverLetter/` folders are no longer used. JobHunter never reads or changes them; you can delete them yourself. After updating, upload your CV and cover letter once on the My documents page.

### View and correct what was read

Each ready slot has a **View and edit** link. The page shows the original file on the left (a PDF is shown on the page; a Word file gets a **Download original** button) and the facts Claude read from it on the right, with warnings in amber.

- **Edit** (or press **E**) turns the facts into a form where every field can be changed. Lists can add, remove and move items. **Save** stores your corrections. Saving is free and never calls Claude.
- A CV edit re-scores every job once (about US$0.016 each, the same as a new CV). The form shows the total before you save. Saving facts identical to what was read stores no edit and re-scores nothing. Cover letter edits re-score nothing.
- **Undo all edits** goes back to what was read from the file.
- Once edited, the corrected facts are your base CV or cover letter everywhere: scoring, Generate, Regenerate, the edit checks and the Diff vs base CV tab. The original CV file is no longer sent to Claude, so the writer and the reviewer never see two versions.
- Replacing the file drops your edits (the Replace dialog warns you first). Uploading the same file again keeps them. An earlier file uploaded again later comes back without its old edits.
- If the CV changed since the page opened, Save is refused until you reload the page.
- Versions made before a CV edit show "made from an earlier base CV" on their Diff tab until the edit is undone.

## How match scores work

Each job card shows a score from 0 to 100: how well your one base CV fits that job ad, with a **"Why this score?"** explanation (what matched, what is missing). The board sorts best match first.

- A score is recomputed only when your CV changes or the job file changes. Otherwise it is kept and costs nothing.
- Scoring runs every 30 seconds in the "Job match scoring" workflow. Each run scores at most **10 jobs**, and each job intake run reads at most **10 job files**, so a burst (a new CV, many new files) is spread over several runs instead of hitting Anthropic rate limits. The rest wait for the next run.
- A failed score is retried up to 3 times in total (after 1, then 5 minutes).

## Job page: edit, versions, regenerate

Open a job card to see its job ad next to the tailored CV and cover letter. Every change adds a new **version**; nothing is ever overwritten or deleted, and the current version is the newest one.

- **Generate** (or **Generate again**) writes new documents from your base CV, then the code checks and the reviewer judge them (see Cost). Generate again ignores the version on screen and your edits; they stay in the history.
- **Edit** (or press **E**) opens the CV and cover letter as a form. Headline, summary, contact details, bullets, skills and the letter can be changed. Name, work rights, role titles, employers, dates and education are copied from your base CV and are read-only (change them there). **Save** adds an "Edited" version. It runs the free code checks again (rules you broke show in amber, and things the reviewer would have ruled on, such as a technology that is not in your base CV, show as "Needs a look"), but not the reviewer: an edited version says "Not reviewed: your edits came after the review". If a generation finishes while you are editing, your edit is still saved as the newest version and the other one stays in the history. Leaving the page with unsaved edits (a link, reload or closing the tab) asks first.
- **Version history** lists every version with where it came from (Generated, Regenerated, Edited by you, Restored), when, and its review result. Click one to view it read-only and download its own files (the file name ends in " - v3" and so on). **Restore this version** copies it as a new version.
- **Regenerate with an instruction** (press **G** to jump to the box) asks Claude for a new version of the version on screen, for example "Make the summary shorter". Your manual edits are **kept exactly as you wrote them**: Claude copies them word for word whatever the instruction says, and a check that fails inside your own edit is listed as "Your edit — kept as you asked" (the version is then shown as not passed) instead of being "fixed". Claude never adds facts that are not in your base CV anywhere else, and the code checks and reviewer judge the rest as strictly as any version. A regenerate always uses your current base CV. If it fails, **Try again** repeats the same regenerate (same instruction, same starting version).
- **A** marks the job Applied, **S** skips it (Closed). Shortcuts never fire while you type in a field; the **?** button lists them.

Editing, saving an edit, restoring, viewing versions, the Diff vs base CV tab and downloads are **free** (no Claude call). A Regenerate costs the same as a Generate.

## Open n8n

Go to http://localhost:5678. The login is in `.env`: `N8N_OWNER_EMAIL` and `N8N_OWNER_PASSWORD`. The web page is on port 8080; the worker and Postgres are only reachable inside the Docker network (use `docker compose exec postgres psql -U jobhunter` for the database).

In the left menu click **Workflows**, then open one. Each workflow has coloured sticky notes (`## 1. ...`, `## 2. ...`) that group the nodes into stages. Read them left to right. To see what a run did, open **Executions** in the workflow and click a run; each node shows the data it received and produced.

The shipped workflows **don't save successful runs** (workflow settings `saveDataSuccessExecution: none`, `saveManualExecutions: false`), so the execution list only shows failed runs and the database doesn't fill up with a run every 30 seconds. While learning, switch it on per workflow: open the workflow, **⋯ → Settings**, set **Save successful production executions** to *Save* (and **Save manual executions** to *Save*), then save. You will then see every run under **Executions**. Re-running the bootstrap resets it.
## Reading the workflows in n8n

There are eight shipped workflows: Job intake sync, Jobs API, Base documents sync (reads your CV and cover letter), Documents API (serves and changes the My documents page, reads and saves your corrections to the base CV and cover letter, and serves the original file), Job match scoring, Generate documents (writes, checks and reviews a tailored CV and cover letter after a Generate or Regenerate click), Job page API (the job page: details, status, notes, downloads, and queueing Generate / Regenerate) and Versions API (version history, saving an edit, restoring a version; never calls Claude). The first two are described step by step below; open the others in n8n and read their sticky notes the same way.

### Job intake sync

Runs every 30 seconds and also when the web page or a test calls `POST /webhook/api/jobs/sync`.

- **Start**: the "Every 30 seconds" schedule (switched off when `JOBHUNTER_SCHEDULE_ENABLED` is `false`, as in the test stack) or the webhook.
- **Header check** (webhook only): `POST /webhook/api/jobs/sync` must send the header `X-JobHunter: 1` (the web app always does), otherwise it answers `403 {"error":"missing_jobhunter_header"}` and nothing runs. This stops other websites triggering a sync from your browser with a plain cross-site POST, which CORS alone does not block. Call it yourself with `curl -X POST -H 'X-JobHunter: 1' http://localhost:5678/webhook/api/jobs/sync`.
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

Both of these webhooks ("GET api/jobs" here and "POST api/jobs/sync" in Job intake sync) set **Allowed Origins (CORS)** to `http://localhost:8080,http://localhost:5173` (the board and the Vite dev server), so other websites you visit cannot read your jobs through your browser. nginx also strips n8n's CORS headers from `/api/`, since the board calls it from its own origin.

## Cost

Real costs measured on 2026-11-07, in US dollars (Anthropic bills in US$):

| What | Model | Cost | When |
| --- | --- | --- | --- |
| Reading your CV | Opus 5.5 | about US$0.06 | only when you upload a new or changed CV |
| Reading your cover letter | Opus 5.5 | about US$0.03 | only when you upload a new or changed letter |
| Scoring one job | Sonnet 5.5 | about US$0.016 | when the job or your CV changes |
| Reading one job file | Haiku 5.5 | about US$0.0003 | new or changed job file (and retries) |
| Writing a CV and cover letter (one round) | Opus 5.5 | about US$0.15 (measured on a real run, 2026-11-08) | only after you click Generate |
| Reviewing them (one round) | Opus 5.5 | about US$0.14 (measured on a real run, 2026-11-08) | once per writing round |
| Regenerate with an instruction | Opus 5.5 | the same as Generate (about US$0.30–0.90) | only after you click Regenerate |
| Edit, save an edit, restore, version history, Diff vs base CV, download | none | free | any time |
| Save a base document edit | none | free (a CV edit re-scores every job once, like a new CV) | after you click Save |

A Generate click costs one round (about US$0.30) when the first draft passes the review, and at most `GENERATION_MAX_ROUNDS` rounds (3: about US$0.90), so about US$0.30–0.90 per click. A failed attempt (an API error, or n8n restarted mid-run) is retried after 1, then 5 minutes, at most 3 attempts, and a retry **continues from the last finished round** (rounds already paid for are kept and count towards `GENERATION_MAX_ROUNDS`). Only the round that was cut off is paid for twice, so the worst case for one click is 2 × (rounds + 2) calls: 10 calls (about US$1.50, at about US$0.15 per call) at 3 rounds, 14 calls (about US$2.10) at the maximum of 5. A round whose documents are malformed is not reviewed, so it costs only the writer call. A Regenerate is a Generate with your instruction and the same limits; when the only problems left are inside your own kept edits, it stops at once instead of paying for rounds that cannot fix them. Nothing is written or reviewed without a click: the "Generate documents" workflow only picks up runs that a Generate click queued, and every call's cost is logged with its job and generation run.

Reading the job folder every 30 seconds costs nothing, and the documents sync only reads your CV and letter after an upload or to retry a failed reading. A new CV re-scores every job once (10 per run). Check the real total any time with `docker compose exec postgres psql -U jobhunter -c "select sum(cost_usd) from cost_log"`.

## PDF and Word output

The worker renders tailored CVs and cover letters with the Standard ATS template (A4, one column, Arial, no tables or text boxes) to Word through the `docx` library. PDFs are made by converting that Word file with Gotenberg (`gotenberg/gotenberg:8.21.1`), a fifth container with no host port and `restart: unless-stopped`. The worker finds it through `GOTENBERG_URL` (default `http://gotenberg:3000`). If Gotenberg is down, the PDF request answers `502 pdf_render_failed` and Word output still works.

## Tests

Run the commands from the project folder.

- Unit tests: start the test database with `docker compose -f docker-compose.test.yml up -d postgres`, run `npm install`, then `npm test`. It runs the worker and web tests; the worker tests need that test database (`TEST_DATABASE_URL`, default `postgres://jobhunter:test@localhost:55433/jobhunter`), the web tests alone (`npm test -w apps/web`) need nothing. Stop the database with `docker compose -f docker-compose.test.yml down`.
- End-to-end: `npm run e2e` (needs Docker running; it starts and removes its own separate stack).

The test stack (`docker-compose.test.yml`, project `jobhunter-test`) uses host ports 55433 (postgres), 55678 (n8n), 58080 (web) and 58081 (fake Anthropic), all bound to 127.0.0.1, and `./.tmp/e2e-joblisting` as the job folder; its uploaded documents go to its own volume (`documents_test_data`). It never touches your real data or key.


### End-to-end details

`npm run e2e` brings up the `jobhunter-test` stack (`docker compose -f docker-compose.test.yml up -d --build --wait`), runs `scripts/n8n-bootstrap.sh`, runs `tests/e2e/*.e2e.test.ts`, then tears the stack down (`down -v`). Set `E2E_KEEP_STACK=1` to leave it running while iterating.

The test stack includes `anthropic-stub` (host port 58081), a fake Anthropic Messages API (it also answers the CV, cover letter and scoring requests with canned data) that n8n reaches via `ANTHROPIC_BASE_URL`. It requires `x-api-key` and `anthropic-version: 2026-10-21` (else 400); user text containing `STUB_FAIL` returns 500, `STUB_REFUSE` returns `stop_reason: "refusal"`, anything else returns a canned extraction. `GET /v1/models` (used by the bootstrap key check) answers 200 for any key except `bad-key` (401). `GET /_requests` lists recorded Messages request bodies, `POST /_reset` clears them. Helpers live in `tests/e2e/lib.ts` (`stack`, `writeJobFile`, `removeJobFile`, `triggerSync`, `putDocument` (uploads through the API), `getFacts` / `saveFacts` (read and save base document facts), `storedDocuments`, `db`, `stub`, `api`).

### Bootstrap

`scripts/n8n-bootstrap.sh [compose-file]` (default `docker-compose.yml`; run with bash, Git Bash on Windows is fine) is idempotent. `JOBHUNTER_ENV_FILE` overrides which env file it reads and writes (default `.env` in the project folder). Values in `.env` may be wrapped in one pair of matching quotes (`KEY="value"` or `KEY='value'`); the quotes are stripped. For n8n 2.46.6 it:

1. Waits for `/healthz`.
2. Creates the owner account (n8n 2.x needs an owner to own imported items) after checking `/rest/settings` for setup state; an already-set-up instance is fine, any other failure aborts. Real stack: `N8N_OWNER_EMAIL` / `N8N_OWNER_PASSWORD` come from `.env`; if missing, the script generates a random password (email default `prayush@jobhunter.local`), appends them to the git-ignored `.env` and prints only "n8n owner login saved in .env". Only `docker-compose.test.yml` (detected by file name) uses a fixed throwaway login. The real stack's n8n port is bound to 127.0.0.1.
3. Real stack only: checks `ANTHROPIC_API_KEY` from `.env` with a free `GET /v1/models` request, run inside the n8n container with the key passed over stdin (never on a command line, never printed). A rejected key (401/403) stops with "Your Anthropic API key was rejected — check ANTHROPIC_API_KEY in .env"; a network error or any other status also stops, naming the status. `JOBHUNTER_ANTHROPIC_BASE_URL` overrides the URL checked (the tests point it at the stub).
4. Builds the credentials JSON (`jh-postgres` / "JobHunter Postgres", `jh-anthropic` / "Anthropic") from the postgres container's `POSTGRES_PASSWORD` and `ANTHROPIC_API_KEY` in `.env`, pipes it over stdin to a temp file inside the n8n container, runs `n8n import:credentials --input=/tmp/jh-credentials.json`, then deletes it (a trap also deletes it if the script fails or is interrupted). Fixed ids make re-import an upsert. The test stack always uses a dummy key, never the real one.
5. `n8n import:workflow --separate --input=/workflows` (imported inactive; workflow JSON needs stable `id`s to stay idempotent). Importing a published workflow queues an "unpublish" record holding the old version in n8n's publication outbox; the script waits (up to 120 s, `JOBHUNTER_PUBLISH_WAIT_S` overrides it; normally under 15 s) until the running n8n has processed it. Otherwise n8n would apply that record after the publish below and keep serving the old version.
6. `n8n publish:workflow --id=<id>` for each workflow `id` in `n8n/workflows/*.json` (2.x replaced `update:workflow --active`; `publish:workflow --all` is no longer supported). Workflows you created yourself in n8n are not published or changed.
7. If any shipped workflows exist, restarts the n8n container (publish only takes effect on restart), waits for `/healthz`, waits until n8n's published version of each shipped workflow is the one just imported (read from n8n's SQLite database), then probes every webhook path found in `n8n/workflows/*.json` (with a non-matching HTTP method, so nothing runs) until n8n reports it registered; exits non-zero on timeout. CLI failures abort the script.

After pulling workflow changes, one bootstrap run makes them live. Re-running the bootstrap resets the shipped workflows (all eight) to the JSON in `n8n/workflows/`, so edits you made to them in the n8n editor are overwritten. Export your edits first (in the workflow, **...** > **Download**, or `docker compose exec n8n n8n export:workflow --id=<id>`). Your own workflows are left alone. Workflows removed from `n8n/workflows/` are not deleted from n8n.

## Troubleshooting

- Cards stuck on "Details unavailable" after you fixed `ANTHROPIC_API_KEY` (wrong key, or a key saved with quotes by an older bootstrap): extraction gave up after 3 failed attempts. Re-run `bash scripts/n8n-bootstrap.sh` to load the fixed key, then queue the failed jobs again with `docker compose exec postgres psql -U jobhunter -c "update jobs set extraction_status='pending', extraction_attempts=0 where extraction_status='failed';"`. The next sync (within 30 seconds) retries them.
