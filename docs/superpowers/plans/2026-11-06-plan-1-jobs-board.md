# JobHunter Plan 1: Jobs Board (Intake → Cards) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop a job `.docx` into `Joblisting/` and see it appear as a card (title, company, short description, status, warnings) in a local web app, with all backend flow in n8n.

**Architecture:** Docker Compose runs four services: PostgreSQL (app data), a small TypeScript **worker** (file reading/parsing and DB migrations — the only code that touches job files), **n8n** (all orchestration: scheduled folder sync, Claude extraction calls, DB writes, and the HTTP API the UI calls), and **web** (React app served by nginx, which proxies `/api/*` to n8n webhooks). Claude is called from n8n's HTTP Request node against the Messages API with structured JSON output.

**Tech Stack:** Node 24, TypeScript, Fastify, mammoth, node-html-parser, pg, Vitest; n8n (pinned exact tag); PostgreSQL 17; React 19 + Vite + Testing Library; nginx; Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-06-jobhunter-design.md`

**Roadmap (later plans, not this one):** Plan 2 base documents + match score · Plan 3 Generate (writer/reviewer loop, checks, DOCX/PDF, job page) · Plan 4 editing, regenerate-with-instructions, versions, diff.

## Global Constraints

- Personal data never committed: `Joblisting/`, `PersonalDetailsCV/`, `PersonalDetailsCoverLetter/`, `output/`, `.env` stay git-ignored. Committed fixtures are generated in tests, never copied from real files.
- Job folder path comes from env `JOBLISTING_DIR` (default `./Joblisting`), mounted read-only into the worker at `/data/joblisting`.
- Every user-owned row carries `owner_id`; the single user is `00000000-0000-0000-0000-000000000001` (seeded).
- All job-file I/O goes through `services/worker/src/storage/jobFolder.ts` (spec §9.3).
- All UI→backend calls go through `apps/web/src/api/client.ts` (spec §9.4). All n8n API webhooks live under path prefix `api/`.
- Every job source produces the same `ScannedJob` record; nothing downstream knows the source beyond `source`/`sourceRef` (spec §9.1).
- Claude calls: n8n HTTP Request → `{{ $env.ANTHROPIC_BASE_URL }}/v1/messages`, headers `x-api-key`, `anthropic-version: 2026-10-21`, `content-type: application/json`; JSON via `output_config.format = {type: "json_schema", schema}`; read the first `content` block with `type == "text"`; treat `stop_reason` `refusal` or `max_tokens` as failure.
- Extraction model from env `EXTRACT_MODEL`, default `claude-haiku-5-5` (prices: $0.10 / 1M input, $0.50 / 1M output). Every Claude call writes a `cost_log` row.
- Statuses (ordered): `new`, `cv_ready`, `applied`, `interviewing`, `closed`. Display labels: New, CV ready, Applied, Interviewing, Closed.
- UI copy in Australian English.
- n8n workflows must be readable for a learner: every node has a descriptive name; each workflow has sticky notes explaining each stage; logic in visible nodes (Postgres/IF/Set) where n8n has one, Code nodes only for small transforms.
- Workflows are committed as JSON in `n8n/workflows/`, credentials are generated from `.env` by `scripts/n8n-bootstrap.sh` (never committed).

## Review Focus

1. Word lock files (`~$job1.docx`) and non-`.docx` files in the folder → ignored, no card (Task 3 test `ignores lock files and non-docx`).
2. Same file edited (same name, new content) → same card updated, status kept, details re-extracted (Task 5 e2e `edited file updates the same job`).
3. File deleted → card kept and marked "source file removed"; file restored → mark cleared (Task 5 e2e `deleted file marks job removed`).
4. Claude error / refusal → card still shows with "Details unavailable", retried on later syncs up to 3 attempts, then left failed (Task 5 e2e `extraction failure is retried then gives up`).
5. Corrupt or empty `.docx` → card with "Couldn't read this file" warning and no Claude call (Task 2 test `corrupt file returns unreadable warning`, Task 5 e2e `unreadable file makes no Claude call`).

---

### Task 1: Workspace, Docker stack skeleton, database schema

**Files:**
- Create: `package.json` (npm workspaces: `services/worker`, `apps/web`, `tests/e2e`), `tsconfig.base.json`, `.env.example`, `docker-compose.yml`, `docker-compose.test.yml`, `README.md`
- Create: `services/worker/package.json`, `services/worker/tsconfig.json`, `services/worker/Dockerfile`, `services/worker/src/server.ts`, `services/worker/src/main.ts`, `services/worker/src/db/migrate.ts`
- Create: `db/migrations/001_init.sql`
- Test: `services/worker/test/health.test.ts`, `services/worker/test/migrate.test.ts`

**Interfaces:**
- Produces: `buildServer(deps: { jobFolderDir: string }): FastifyInstance` with `GET /health → {ok: true}`; `runMigrations(pool: pg.Pool, dir: string): Promise<string[]>` (returns applied filenames, idempotent, tracked in `schema_migrations(filename text primary key, applied_at timestamptz)`).
- Produces tables (all `id uuid primary key default gen_random_uuid()`, `created_at timestamptz default now()`):
  - `users(id, name text not null)` + seed row id `00000000-0000-0000-0000-000000000001`, name `Prayush`.
  - `jobs(id, owner_id uuid not null references users, source text not null, source_ref text not null, content_hash text not null, url text, raw_text text not null, warnings jsonb not null default '[]', title text, employer text, advertiser text, short_description text, extraction_status text not null default 'pending' check in ('pending','in_progress','done','failed','skipped'), extraction_attempts int not null default 0, extraction_claimed_at timestamptz, status text not null default 'new' check in ('new','cv_ready','applied','interviewing','closed'), match_score int, match_explanation text, source_removed boolean not null default false, updated_at timestamptz default now(), unique(owner_id, source, source_ref))`
  - `job_status_history(id, job_id uuid not null references jobs on delete cascade, from_status text, to_status text not null, changed_at timestamptz default now())`
  - `cost_log(id, owner_id uuid not null references users, job_id uuid references jobs on delete set null, purpose text not null, model text not null, input_tokens int not null, output_tokens int not null, cost_usd numeric(10,6) not null)`

Compose services: `postgres` (postgres:17, db `jobhunter`, healthcheck), `worker` (build `services/worker`, env `DATABASE_URL`, `JOBLISTING_DIR=/data/joblisting`, mounts `${JOBLISTING_DIR:-./Joblisting}:/data/joblisting:ro`, runs migrations then listens on 3001, internal only), `n8n` (image `n8nio/n8n:<exact latest stable tag on the day — record it in README>`, port 5678, volume `n8n_data`, env `N8N_ENCRYPTION_KEY`, `ANTHROPIC_BASE_URL=https://api.anthropic.com`, `EXTRACT_MODEL`, `WORKER_URL=http://worker:3001`, `N8N_BLOCK_ENV_ACCESS_IN_NODE=false`, `GENERIC_TIMEZONE=Australia/Sydney`, mounts `./n8n/workflows:/workflows:ro`), `web` placeholder added in Task 7. `docker-compose.test.yml` is a standalone compose project (`name: jobhunter-test`) with the same services on different host ports (postgres `55433`, n8n `55678`, web `58080`), its own volumes, `JOBLISTING_DIR` → `./.tmp/e2e-joblisting` (writable bind), `ANTHROPIC_BASE_URL=http://anthropic-stub:8080` (the stub service itself is added in Task 4).

`.env.example` keys: `ANTHROPIC_API_KEY=`, `POSTGRES_PASSWORD=change-me`, `N8N_ENCRYPTION_KEY=change-me-32-chars`, `JOBLISTING_DIR=./Joblisting`, `EXTRACT_MODEL=claude-haiku-5-5`.

- [ ] **Step 1: Write failing tests**

```ts
// health.test.ts
test('GET /health returns ok', async () => {
  const app = buildServer({ jobFolderDir: '/nonexistent' });
  const res = await app.inject({ method: 'GET', url: '/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});
// migrate.test.ts — uses TEST_DATABASE_URL (postgres from docker-compose.test.yml on :55433), drops & recreates schema public first
test('applies 001_init once and seeds the single user', async () => {
  expect(await runMigrations(pool, MIGRATIONS_DIR)).toEqual(['001_init.sql']);
  expect(await runMigrations(pool, MIGRATIONS_DIR)).toEqual([]);
  const { rows } = await pool.query('select id, name from users');
  expect(rows).toEqual([{ id: '00000000-0000-0000-0000-000000000001', name: 'Prayush' }]);
});
test('jobs are unique per owner/source/source_ref', async () => {
  const insert = `insert into jobs(owner_id, source, source_ref, content_hash, raw_text) values ($1,'folder','a.docx','h','t')`;
  await pool.query(insert, [USER_ID]);
  await expect(pool.query(insert, [USER_ID])).rejects.toThrow(/duplicate key/);
});
```

- [ ] **Step 2: Run** `docker compose -f docker-compose.test.yml up -d postgres && npm test -w services/worker` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** `buildServer`, `runMigrations`, `001_init.sql`, `main.ts` (reads env, runs migrations, listens `0.0.0.0:3001`), Dockerfile (node:24-slim, multi-stage build), both compose files, `.env.example`, README "Run it" section (`cp .env.example .env`, fill key, `docker compose up -d`, then Task 4's bootstrap).
- [ ] **Step 4: Run** `npm test -w services/worker` — Expected: PASS. Then `docker compose up -d --build && docker compose ps` — Expected: postgres, worker, n8n all `running`/`healthy`; `curl -s localhost:5678/healthz` returns `{"status":"ok"}`.
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat: workspace, docker stack and initial schema"`

---

### Task 2: Job file parser

**Files:**
- Create: `services/worker/src/jobs/parseJobDocx.ts`, `services/worker/src/jobs/types.ts`, `tests/helpers/makeDocx.ts`
- Test: `services/worker/test/parseJobDocx.test.ts`, `services/worker/test/realFiles.smoke.test.ts`

**Interfaces:**
- Produces: `type WarningCode = 'missing_url' | 'unreadable_file' | 'empty_description'`; `interface ParsedJob { url: string | null; body: string; warnings: WarningCode[] }`; `parseJobDocx(bytes: Buffer): Promise<ParsedJob>`.
- Produces (test helper): `type DocxPara = { text: string } | { hyperlinkField: { url: string; display: string } } | { hyperlink: { url: string; display: string } } | { empty: true }`; `makeDocx(paras: DocxPara[]): Promise<Buffer>` — builds a minimal valid .docx with JSZip (`[Content_Types].xml`, `_rels/.rels`, `word/document.xml`, `word/_rels/document.xml.rels`); `hyperlinkField` emits a complex field (`w:fldChar begin` / `w:instrText HYPERLINK "url"` / `separate` / display run / `end`), `hyperlink` emits `w:hyperlink r:id`.

Approach: `mammoth.convertToHtml`, parse with node-html-parser, take block elements in order, skip empty ones. URL = first non-empty block's first `a[href]` if it is http(s), else the first `https?://\S+` match in that block's text. If found, body = remaining blocks' text joined by `\n`; if not, `missing_url` and body = all blocks. HTML entities decoded (so `&amp;` → `&`). Body trimmed; empty → `empty_description`. Any mammoth/zip error → `{url: null, body: '', warnings: ['unreadable_file']}`. If mammoth drops complex-field hyperlinks, fall back to reading `word/document.xml` `w:instrText` for `HYPERLINK "…"` in the first paragraph.

- [ ] **Step 1: Write failing tests**

```ts
test('URL on first line, rest is body', async () => {
  const r = await parseJobDocx(await makeDocx([{ text: 'https://au.seek.com/job/1' }, { text: 'Salesforce Developer' }, { text: 'Apex & LWC' }]));
  expect(r).toEqual({ url: 'https://au.seek.com/job/1', body: 'Salesforce Developer\nApex & LWC', warnings: [] });
});
test('skips leading empty paragraphs', async () => {
  const r = await parseJobDocx(await makeDocx([{ empty: true }, { text: 'https://x.io/a?b=1&c=2' }, { text: 'Body' }]));
  expect(r.url).toBe('https://x.io/a?b=1&c=2');
});
test('reads URL from a Word HYPERLINK field', async () => {
  const url = 'https://www.linkedin.com/jobs/search-results/?currentJobId=1&keywords=salesforce';
  const r = await parseJobDocx(await makeDocx([{ hyperlinkField: { url, display: url } }, { text: 'Body' }]));
  expect(r.url).toBe(url);
});
test('reads URL from a hyperlink whose display text differs', async () => {
  const r = await parseJobDocx(await makeDocx([{ hyperlink: { url: 'https://x.io/j', display: 'Apply here' } }, { text: 'Body' }]));
  expect(r.url).toBe('https://x.io/j');
});
test('no URL on first line → missing_url, whole text is body', async () => {
  const r = await parseJobDocx(await makeDocx([{ text: 'Salesforce Developer' }, { text: 'Body' }]));
  expect(r).toEqual({ url: null, body: 'Salesforce Developer\nBody', warnings: ['missing_url'] });
});
test('URL only → empty_description', async () => {
  expect((await parseJobDocx(await makeDocx([{ text: 'https://x.io' }]))).warnings).toEqual(['empty_description']);
});
test('corrupt file returns unreadable warning', async () => {
  expect(await parseJobDocx(Buffer.from('not a zip'))).toEqual({ url: null, body: '', warnings: ['unreadable_file'] });
});
// realFiles.smoke.test.ts — describe.skipIf(no .docx in ../../Joblisting): every real file parses with a non-null http(s) URL and non-empty body. Never snapshot or print contents.
```

- [ ] **Step 2: Run** `npm test -w services/worker -- parseJobDocx` — Expected: FAIL.
- [ ] **Step 3: Implement** `parseJobDocx` and `makeDocx` as above.
- [ ] **Step 4: Run** `npm test -w services/worker` — Expected: PASS, and the smoke test runs (not skipped) on Prayush's machine with 3 files passing.
- [ ] **Step 5: Commit** `git commit -am "feat(worker): parse job docx files"` (add new files first).

---

### Task 3: Job folder storage + scan endpoint

**Files:**
- Create: `services/worker/src/storage/jobFolder.ts`, `services/worker/src/jobs/scan.ts`
- Modify: `services/worker/src/server.ts` (register route)
- Test: `services/worker/test/jobFolder.test.ts`, `services/worker/test/scanRoute.test.ts`

**Interfaces:**
- Consumes: `parseJobDocx` (Task 2).
- Produces: `listJobFiles(dir: string): Promise<{ name: string; bytes: Buffer }[]>` — only `*.docx` (case-insensitive), skips names starting `~$` or `.`, sorted by name, non-recursive; missing dir → `[]`.
- Produces: `interface ScannedJob { source: 'folder'; sourceRef: string; contentHash: string; url: string | null; body: string; warnings: WarningCode[] }` (`contentHash` = sha256 hex of bytes); `scanJobFolder(dir: string): Promise<ScannedJob[]>`; route `POST /jobs/scan → { jobs: ScannedJob[] }`.

- [ ] **Step 1: Write failing tests** (temp dir via `fs.mkdtemp`)

```ts
test('ignores lock files and non-docx', async () => {
  // write job1.docx (valid), ~$job1.docx, notes.txt, .hidden.docx, JOB2.DOCX (valid)
  expect((await listJobFiles(dir)).map(f => f.name)).toEqual(['JOB2.DOCX', 'job1.docx']);
});
test('missing folder returns empty list', async () => {
  expect(await listJobFiles(path.join(dir, 'nope'))).toEqual([]);
});
test('POST /jobs/scan returns ScannedJob records', async () => {
  const app = buildServer({ jobFolderDir: dir });
  const res = await app.inject({ method: 'POST', url: '/jobs/scan' });
  const job = res.json().jobs.find((j: ScannedJob) => j.sourceRef === 'job1.docx');
  expect(job).toMatchObject({ source: 'folder', url: 'https://x.io/1', body: 'Body', warnings: [] });
  expect(job.contentHash).toMatch(/^[0-9a-f]{64}$/);
});
test('changed content changes the hash', async () => { /* rewrite job1.docx, rescan, hash differs */ });
```

- [ ] **Step 2: Run** `npm test -w services/worker -- jobFolder scanRoute` — Expected: FAIL.
- [ ] **Step 3: Implement** `listJobFiles`, `scanJobFolder`, route.
- [ ] **Step 4: Run** `npm test -w services/worker` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): job folder scan endpoint`

---

### Task 4: n8n bootstrap + Anthropic stub (test infrastructure)

**Files:**
- Create: `scripts/n8n-bootstrap.sh`, `tests/stubs/anthropic-stub/server.mjs`, `tests/stubs/anthropic-stub/Dockerfile`, `tests/e2e/package.json`, `tests/e2e/vitest.config.ts`, `tests/e2e/globalSetup.ts`, `tests/e2e/lib.ts`
- Modify: `docker-compose.test.yml` (add `anthropic-stub` service on internal port 8080, host port `58081`), `README.md`
- Test: `tests/e2e/infra.e2e.test.ts`

**Interfaces:**
- Produces: `scripts/n8n-bootstrap.sh [compose-file]` — idempotent: waits for n8n `/healthz`; writes credentials JSON to a temp file inside the container (never in repo) from `.env`: `{id: "jh-postgres", name: "JobHunter Postgres", type: "postgres"}` and `{id: "jh-anthropic", name: "Anthropic", type: "anthropicApi"}`; runs `n8n import:credentials`, `n8n import:workflow --separate --input=/workflows`, then activates/publishes all workflows with the CLI command the pinned n8n version documents; restarts n8n if that version requires it for activation. Also creates the n8n owner account non-interactively if the pinned version needs one for webhooks (document in README).
- Produces stub: `POST /v1/messages` — validates headers (`x-api-key` present, `anthropic-version: 2026-10-21`) else 400; if the user content contains `STUB_FAIL` → HTTP 500; if it contains `STUB_REFUSE` → 200 with `stop_reason: "refusal"`; otherwise 200 with `{content:[{type:"text", text: JSON.stringify(<canned extraction>)}], stop_reason:"end_turn", usage:{input_tokens:1000, output_tokens:100}}` where canned extraction = `{title: "Stub Title", employer: "Stub Employer", advertiser: null, short_description: "Stub description."}`. `GET /_requests` → recorded request bodies; `POST /_reset` clears them.
- Produces (e2e lib): `stack.up()/down()` (compose project `jobhunter-test`, then bootstrap), `writeJobFile(name, paras: DocxPara[])`, `removeJobFile(name)`, `triggerSync(): Promise<void>` (POST `http://localhost:55678/webhook/api/jobs/sync`, awaits completion), `db.query(sql, params)` (pg on :55433), `stub.requests()`, `stub.reset()`, `api.get(path)` (via web on :58080 once Task 7 exists; until then n8n `:55678/webhook/`).

- [ ] **Step 1: Write failing test** `infra.e2e.test.ts`: after `globalSetup`, `GET :55678/healthz` is ok; `GET :58081/_requests` returns `[]`; `docker compose exec n8n n8n list:credentials`-equivalent (or n8n REST) shows both credential names.
- [ ] **Step 2: Run** `npm run e2e` (root script: `vitest run --config tests/e2e/vitest.config.ts`) — Expected: FAIL.
- [ ] **Step 3: Implement** stub, Dockerfile, bootstrap script, e2e harness, README "Testing" section.
- [ ] **Step 4: Run** `npm run e2e` — Expected: PASS. Run `scripts/n8n-bootstrap.sh` a second time — Expected: no duplicates, exit 0.
- [ ] **Step 5: Commit** `test: n8n bootstrap and anthropic stub for e2e`

---

### Task 5: n8n workflow "Job intake sync"

**Files:**
- Create: `n8n/workflows/job-intake-sync.json`, `n8n/prompts/extract-job.md` (prompt text, copied into the workflow; kept here for review/diffs)
- Test: `tests/e2e/intake.e2e.test.ts`

**Interfaces:**
- Consumes: `POST {WORKER_URL}/jobs/scan` (Task 3), tables (Task 1), credentials `jh-postgres`, `jh-anthropic` (Task 4).
- Produces: workflow named **"Job intake sync"** with two triggers — Schedule (every 30 seconds) and Webhook `POST api/jobs/sync` (responds when the run finishes, `{ok: true, scanned: n, extracted: n}`).

Stages (each a sticky note in the workflow):
1. **Scan folder** — HTTP Request to worker.
2. **Upsert jobs** — Postgres, one parameterised query per item: insert, or on conflict update `content_hash, url, raw_text, warnings, source_removed=false, updated_at=now()`; when `content_hash` changed also set `extraction_status` by the initial-value rule below, `extraction_attempts=0`, and clear `title, employer, advertiser, short_description`. Initial `extraction_status` is `skipped` when warnings include `unreadable_file` or `empty_description`, else `pending`. New rows also insert `job_status_history(null → 'new')`. Never touch `status` on update.
3. **Mark removed files** — Aggregate source refs; `update jobs set source_removed = true where owner_id=$1 and source='folder' and not (source_ref = any($2))` (an empty folder marks all).
4. **Claim pending extractions** — `update jobs set extraction_status='in_progress', extraction_claimed_at=now(), extraction_attempts = extraction_attempts + 1 where id in (select id from jobs where source_removed = false and (extraction_status in ('pending') or (extraction_status='failed' and extraction_attempts < 3) or (extraction_status='in_progress' and extraction_claimed_at < now() - interval '5 minutes')) for update skip locked) returning id, raw_text, url` — this makes overlapping runs safe.
5. **Ask Claude for title/company/summary** — HTTP Request (credential `jh-anthropic`, timeout 60s, never error the workflow: continue on fail) with body `{model: $env.EXTRACT_MODEL, max_tokens: 1024, output_config: {effort: "low", format: {type: "json_schema", schema: <schema below>}}, system: <extract-job.md>, messages: [{role: "user", content: "<job_ad>\n" + raw_text + "\n</job_ad>"}]}`. Schema: object, `additionalProperties: false`, required all of `title` (string), `employer` (string or null), `advertiser` (string or null), `short_description` (string, ≤ 200 chars stated in prompt).
6. **Save details or failure** — IF HTTP ok and `stop_reason == "end_turn"` and parsed JSON valid → update fields, `extraction_status='done'`; else `extraction_status='failed'`. Either way when a response with `usage` came back, insert `cost_log(owner_id, job_id, purpose='extract_job', model, input_tokens, output_tokens, cost_usd)` with cost = `in*0.10/1e6 + out*0.50/1e6` for `claude-haiku-5-5` (price table in one small Code node, keyed by model).

Prompt (`extract-job.md`) must say: the text is a job ad copy-pasted from a job site and includes site clutter (buttons, "People you can reach out to", premium ads, match widgets, follower counts, EEO boilerplate) — ignore it; `employer` is the hiring organisation (null if unnamed, e.g. "a Queensland Government entity" → null), `advertiser` is a recruiter/agency if different (else null); never output names of individual people; `short_description` is one neutral sentence in Australian English describing the role, not the company marketing; never invent anything not in the ad.

- [ ] **Step 1: Write failing e2e tests** (`stub.reset()` and clean `jobs` before each)

```ts
test('new file becomes a job with extracted details', async () => {
  await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'Salesforce Developer at Acme' }]);
  await triggerSync();
  const [job] = (await db.query(`select * from jobs where source_ref='a.docx'`)).rows;
  expect(job).toMatchObject({ url: 'https://x.io/a', title: 'Stub Title', employer: 'Stub Employer', status: 'new', extraction_status: 'done', source_removed: false });
  const [cost] = (await db.query(`select * from cost_log where job_id=$1`, [job.id])).rows;
  expect(cost).toMatchObject({ purpose: 'extract_job', model: 'claude-haiku-5-5', input_tokens: 1000, output_tokens: 100 });
  expect(Number(cost.cost_usd)).toBeCloseTo(0.00015, 6);
  expect((await db.query(`select to_status from job_status_history where job_id=$1`, [job.id])).rows).toEqual([{ to_status: 'new' }]);
});
test('unchanged file is not re-extracted', async () => { /* sync twice → stub.requests().length === 1 */ });
test('edited file updates the same job', async () => {
  // sync a.docx; set status='applied' in DB; rewrite a.docx with new body; sync
  // → still 1 row for a.docx, status 'applied', raw_text new, extraction_status 'done', stub saw 2 requests
});
test('deleted file marks job removed', async () => { /* remove → source_removed true; restore → false */ });
test('missing URL creates a job with warning', async () => { /* warnings = ["missing_url"], url null, still extracted */ });
test('unreadable file makes no Claude call', async () => { /* write bytes 'junk' as bad.docx → warnings ["unreadable_file"], extraction_status 'skipped', stub.requests() empty */ });
test('extraction failure is retried then gives up', async () => {
  // body contains STUB_FAIL; sync 4 times → extraction_status 'failed', extraction_attempts 3, stub saw 3 requests, title null
});
test('refusal counts as failure', async () => { /* STUB_REFUSE → extraction_status 'failed' after first sync */ });
test('overlapping syncs do not double-call Claude', async () => { /* Promise.all([triggerSync(), triggerSync()]) on a new file → stub.requests().length === 1 */ });
test('request uses structured output and the configured model', async () => {
  // stub.requests()[0] has model 'claude-haiku-5-5', output_config.format.type 'json_schema', and headers checked by stub
});
```

- [ ] **Step 2: Run** `npm run e2e -- intake` — Expected: FAIL (webhook 404).
- [ ] **Step 3: Build the workflow** in the test n8n editor (`localhost:55678`) or by hand, following the stages above with sticky notes; export with `n8n export:workflow` to `n8n/workflows/job-intake-sync.json`; strip any instance-specific IDs that break re-import; re-run bootstrap.
- [ ] **Step 4: Run** `npm run e2e` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(n8n): job intake sync workflow`

---

### Task 6: n8n workflow "Jobs API"

**Files:**
- Create: `n8n/workflows/jobs-api.json`
- Test: `tests/e2e/jobsApi.e2e.test.ts`

**Interfaces:**
- Consumes: tables (Task 1).
- Produces: Webhook `GET api/jobs` → `200 { jobs: JobSummary[] }` where
  `JobSummary = { id: string; title: string | null; employer: string | null; advertiser: string | null; shortDescription: string | null; url: string | null; status: 'new'|'cv_ready'|'applied'|'interviewing'|'closed'; matchScore: number | null; warnings: ('missing_url'|'unreadable_file'|'empty_description')[]; extractionStatus: 'pending'|'in_progress'|'done'|'failed'|'skipped'; sourceRemoved: boolean; sourceRef: string; createdAt: string }`,
  filtered to `owner_id = 00000000-0000-0000-0000-000000000001`, ordered `match_score desc nulls last, created_at desc`.

- [ ] **Step 1: Write failing tests**

```ts
test('lists jobs in the JobSummary shape', async () => {
  await writeJobFile('a.docx', [{ text: 'https://x.io/a' }, { text: 'Body' }]); await triggerSync();
  const { jobs } = await api.get('/api/jobs');
  expect(jobs).toHaveLength(1);
  expect(Object.keys(jobs[0]).sort()).toEqual(['advertiser','createdAt','employer','extractionStatus','id','matchScore','shortDescription','sourceRef','sourceRemoved','status','title','url','warnings'].sort());
});
test('orders by match score desc with unscored last', async () => {
  // insert 3 jobs directly with match_score 40, null, 90 → titles in order 90, 40, null
});
test('empty list is an empty array', async () => { expect((await api.get('/api/jobs')).jobs).toEqual([]); });
```

- [ ] **Step 2: Run** `npm run e2e -- jobsApi` — Expected: FAIL.
- [ ] **Step 3: Build and export** the workflow (Webhook → Postgres select with column aliases → Respond to Webhook), with sticky notes.
- [ ] **Step 4: Run** `npm run e2e` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(n8n): jobs list API`

---

### Task 7: Web app — Jobs board

**Files:**
- Create: `apps/web/` (Vite React TS: `package.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`), `apps/web/src/api/types.ts`, `apps/web/src/api/client.ts`, `apps/web/src/jobs/filterJobs.ts`, `apps/web/src/jobs/JobCard.tsx`, `apps/web/src/jobs/JobsPage.tsx`, `apps/web/src/jobs/labels.ts`, `apps/web/Dockerfile`, `apps/web/nginx.conf`
- Modify: `docker-compose.yml`, `docker-compose.test.yml` (add `web`: port 8080 / 58080), `tests/e2e/lib.ts` (`api.get` via web)
- Test: `apps/web/src/jobs/filterJobs.test.ts`, `apps/web/src/jobs/JobCard.test.tsx`, `apps/web/src/jobs/JobsPage.test.tsx`, `tests/e2e/web.e2e.test.ts`

**Interfaces:**
- Consumes: `GET /api/jobs` (Task 6) — `JobSummary` type copied verbatim into `api/types.ts`.
- Produces (in `api/types.ts`): `type JobStatus = 'new'|'cv_ready'|'applied'|'interviewing'|'closed'`, `type WarningCode = 'missing_url'|'unreadable_file'|'empty_description'`, `JobSummary` (using both).
- Produces: `fetchJobs(): Promise<JobSummary[]>` (throws `ApiError(status, message)` on non-2xx); `filterJobs(jobs: JobSummary[], f: { status: JobStatus | 'all'; query: string }): JobSummary[]` (query matches title, employer, advertiser, shortDescription, case-insensitive; preserves order); `sortJobs(jobs): JobSummary[]` (same order rule as the API, used defensively); `statusLabel(s: JobStatus): string`; `warningText(w: WarningCode): string` → `missing_url`: "No job link found on the first line", `unreadable_file`: "Couldn't read this file", `empty_description`: "No job description found".

UI: header "Jobs"; status chips "All (n)", "New (n)", "CV ready (n)", "Applied (n)", "Interviewing (n)", "Closed (n)"; search box "Search jobs"; responsive card grid. Card: status label, match score badge or "Not scored yet", title (fallback: `sourceRef`), company line (`employer`, plus "via {advertiser}" when both, `advertiser` alone when no employer), short description, warnings as visible notices, "Details unavailable" when `extractionStatus` is `failed`, "Reading job…" when `pending`/`in_progress`, "Source file removed" badge when `sourceRemoved`, and "Open job posting ↗" link (`target="_blank" rel="noopener noreferrer"`) when `url`. Loading and error states ("Couldn't load jobs. Is the backend running?" + Retry). Auto-refresh every 15 s. Empty state: "No jobs yet. Add a Word file to your Joblisting folder." nginx serves `dist/` and proxies `location /api/` → `http://n8n:5678/webhook/api/`.

- [ ] **Step 1: Write failing tests**

```ts
// filterJobs.test.ts
test('filters by status and query, keeping order', () => {
  expect(filterJobs(jobs, { status: 'applied', query: 'acme' }).map(j => j.id)).toEqual(['2']);
});
test('all + empty query returns everything', () => { expect(filterJobs(jobs, { status: 'all', query: '' })).toEqual(jobs); });
test('sortJobs puts unscored last', () => { expect(sortJobs([s(null), s(40), s(90)]).map(j => j.matchScore)).toEqual([90, 40, null]); });
// JobCard.test.tsx
test('shows title, company via advertiser, and posting link', () => {
  render(<JobCard job={{ ...base, title: 'Salesforce Developer', employer: null, advertiser: 'Redwolf + Rosch', url: 'https://au.seek.com/job/1' }} />);
  expect(screen.getByText('Salesforce Developer')).toBeInTheDocument();
  expect(screen.getByText('Redwolf + Rosch')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /open job posting/i })).toHaveAttribute('href', 'https://au.seek.com/job/1');
});
test('shows warnings, removed badge and failed state', () => { /* warning text, "Source file removed", "Details unavailable", falls back to sourceRef title */ });
// JobsPage.test.tsx (mock api/client)
test('renders chips with counts and filters on click', async () => { /* "Applied (1)" click → only applied card */ });
test('shows error with retry', async () => { /* fetchJobs rejects → error text; Retry calls again */ });
test('shows empty state', async () => { /* [] → empty-state text */ });
// web.e2e.test.ts
test('web proxies /api/jobs to n8n', async () => { /* GET :58080/api/jobs → 200 {jobs: [...]} ; GET :58080/ → html containing <div id="root"> */ });
```

- [ ] **Step 2: Run** `npm test -w apps/web` and `npm run e2e -- web` — Expected: FAIL.
- [ ] **Step 3: Implement** the files above; keep `fetch` calls only in `api/client.ts`.
- [ ] **Step 4: Run** `npm test -w apps/web && npm run e2e` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): jobs board`

---

### Task 8: Real-run verification and README walkthrough

**Files:**
- Modify: `README.md` (setup from scratch, where to put files, how to open n8n and read each workflow, how to run tests, cost note: about $0.0005 per new job at Haiku 5.5 prices)

- [ ] **Step 1: Run the real stack** — `cp .env.example .env` (Prayush fills `ANTHROPIC_API_KEY`), `docker compose up -d --build`, `bash scripts/n8n-bootstrap.sh`.
- [ ] **Step 2: Verify with Prayush's 3 real job files** — open `http://localhost:8080`. Expected: 3 cards; job1 "Salesforce Developer" / Sierra Cloud; job2 "Salesforce Developer / Software Engineer" via Redwolf + Rosch with no named employer; job3 "Specialist Solution Engineer, Data & Analytics" / Salesforce; each has a working "Open job posting ↗"; no card shows a person's name. `select sum(cost_usd) from cost_log` < 0.01.
- [ ] **Step 3: Verify folder behaviour by hand** — rename `job3.docx` → card shows "Source file removed" within ~30 s and a new card appears for the new name; open a job file in Word (creates `~$` lock file) → no extra card.
- [ ] **Step 4: Run all tests** — `npm test --workspaces && npm run e2e` — Expected: all PASS.
- [ ] **Step 5: Commit** `docs: README walkthrough for plan 1`
