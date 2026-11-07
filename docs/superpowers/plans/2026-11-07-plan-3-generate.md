# JobHunter Plan 3: Generate (writer, reviewer, checks, downloads, job page) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking Generate on a job writes a tailored 1-page CV and cover letter from Prayush's base CV, checks them in code, has an independent Claude reviewer push back for up to 3 rounds, and shows the result with every reason on a job page with Word and PDF downloads.

**Architecture:** Same shape as Plans 1–2. The worker gains a **template renderer** (structured CV/letter → DOCX with the `docx` package → PDF through a new internal **Gotenberg** container) and **pure check functions**. n8n gains two workflows: **Generate documents** (a queue: the click only records a request; a 30-second schedule claims it and runs writer → code checks → reviewer → revise, with a heartbeat so a lost run never writes) and **Job page API** (generate, detail, status, company notes, downloads). The web app gains a job page. Editing, Regenerate with instructions, version history and the diff view are **Plan 4**.

**Tech Stack:** as Plan 2, plus worker deps `docx`, `unpdf`, `nspell`, `dictionary-en-au` (each pinned to an exact version at least two weeks old, verified with `npm view`), and the `gotenberg/gotenberg` image pinned to an exact 8.x tag verified with `docker pull`.

**Spec:** `docs/superpowers/specs/2026-11-06-jobhunter-design.md` — implements §2 anti-goals (as checks and prompt rules), §6.2 Generate, §6.3 source of truth, §6.3a cover-letter sources, §6.4 checks, §7.2 job page (without editing, diff, instruction box, version history), §8 GenerationVersion. Prerequisite: Plan 2 merged (it is, main 39ce728).

## Global Constraints

- Everything in Plans 1–2's Global Constraints still holds: personal data never committed (test fixtures use invented names only, never Prayush's, his employers', "Decode Global" or "Ms. Li"); owner id `00000000-0000-0000-0000-000000000001` on every user-owned row; all UI→backend calls through `apps/web/src/api/client.ts`; n8n API webhooks under `api/` with Allowed Origins `http://localhost:8080,http://localhost:5173`; every state-changing webhook's first node is the `X-JobHunter: 1` gate (403 `missing_jobhunter_header`); `settings.saveDataSuccessExecution: "none"` and `saveManualExecutions: false` on every workflow; readable workflows with sticky notes; parameterised SQL only; never a dollar sign followed by a digit inside SQL comments (write `[N]`); webhook answers within 30 s; only shipped workflow ids are published; migrations 001–003 are never edited.
- **Paid calls only after a click** (spec §3): the schedule only picks up a generation run that a Generate click created. A failed attempt is retried by the schedule (1 min after attempt 1, 5 min after attempt 2, cap 3 attempts), each attempt restarting from round 1.
- Claude calls follow Plan 1–2 rules: headers `x-api-key`, `anthropic-version: 2026-10-21`; `output_config: { effort, format: { type: "json_schema", schema } }`; read the first `text` block; `refusal`, `max_tokens` or invalid JSON = failed attempt; price looked up **before** the claim; a `cost_log` row whenever usage returns, priced by the response's `model`, with `job_id` and `generation_run_id`; header `anthropic-beta: server-side-fallback-2026-07-01` and body `"fallbacks": "default"` for opus/sonnet. Never send `thinking: {type:"disabled"}`, `budget_tokens`, `temperature`, `top_p`, `top_k` or prefill.
- Models (env, priced in the price table): `WRITER_MODEL` default `claude-opus-5-5` ($4 / $20 per 1M), effort `medium`, `max_tokens: 16000`, HTTP timeout 280 s; `REVIEW_MODEL` default `claude-opus-5-5`, effort `medium`, `max_tokens: 8000`, timeout 280 s. `GENERATION_MAX_ROUNDS` default `3`.
- The base CV is the PDF/DOCX as uploaded (sent as in Plan 2: PDF as a base64 document block, DOCX as text in `<document>…</document>`) plus its `structured` analysis. The base cover letter goes only as its `structured` (previousTarget, reusableParagraphs, toneNotes). Facts come **only** from the base CV (spec §6.3).
- The reviewer is a separate call with its own system prompt. It gets the job ad, the base CV, the writer's output (documents, reasons, keyword coverage) and the code-check results — never the writer's prompt or thinking.
- Template ids: `standard-ats` (the only one). Template rules: A4, single column, no tables, no text boxes, no columns; one font family `Arial` (Gotenberg/LibreOffice renders it as metric-compatible Liberation Sans); body 10.5 pt, name 18 pt bold, section headings 11.5 pt bold uppercase with a bottom border and keep-with-next; dates right-aligned with a right tab stop on the title line; bullets through Word numbering, not typed characters; date format `Mon YYYY – Mon YYYY` / `Present` as given by the base CV. Cover letter: same font, 11 pt, target 1 page, hard limit 2.
- Downloads are rendered on demand from the stored version (no generated files on disk). File name: `{cv.name} - CV - {target}.{docx|pdf}` / `{cv.name} - Cover letter - {target}.{ext}`, target = employer, else advertiser, else `Job`; characters outside `[A-Za-z0-9 ._()-]` removed, at most 100 characters before the extension.
- Australian English in generated documents and UI copy.

## Review Focus

1. **Double Generate** (double click, two tabs) → exactly one run; the second click answers `409 {error:"generation_in_progress"}` and no extra Claude call (Task 6 e2e `second generate while running is 409`).
2. **Writer can't get it to pass** (2-page CV every round) → after `GENERATION_MAX_ROUNDS` the best round is saved, `review.passed = false`, `unresolved` lists "CV is 2 pages", job shows it plainly; no fourth round (Task 5 e2e `stops after max rounds and keeps the best`).
3. **Run interrupted** (n8n restarted mid-run, or a call hangs) → the stale run is reclaimed after 6 minutes within the 3-attempt cap; the old execution, if it wakes, cannot save or log against the new claim (Task 5 e2e `lost claim stops the old execution`).
4. **Target company is also a skill or a past employer** (employer "Salesforce", or a past employer equal to the target) → not flagged as leakage; the base cover letter's previous company and addressee **are** flagged anywhere in output (Task 3 tests `target that is a skill is not leakage`, `previous target is leakage`).
5. **Not ready to generate** (no analysed base CV, or job extraction not done) → Generate refused `422 {error:"base_cv_not_ready"|"job_not_ready"}` with the reason shown; nothing queued, no Claude call (Task 6 e2e `generate refused when not ready`).

---

### Task 1: Schema for generation, and the base CV records the name

**Files:**
- Create: `db/migrations/004_generation.sql`
- Modify: `n8n/prompts/analyse-cv.md`, `n8n/workflows/base-documents-sync.json` (CV prompt text + JSON schema), `tests/stubs/anthropic-stub/server.mjs` (canned `analyse_cv.name: 'Stub Person'`)
- Test: `services/worker/test/migrate.test.ts`, `tests/e2e/documents.e2e.test.ts`

**Interfaces:**
- Produces tables/columns:
  - `generation_runs(id uuid pk default gen_random_uuid(), created_at, updated_at, owner_id uuid not null references users, job_id uuid not null references jobs on delete cascade, status text not null default 'pending' check in ('pending','in_progress','done','failed'), stage text check in ('queued','writing','checking','reviewing','saving') default 'queued', round int not null default 0, attempts int not null default 0, claimed_at timestamptz, error text, rounds jsonb not null default '[]', instruction text)` + partial unique index `generation_runs_one_active_per_job on (job_id) where status in ('pending','in_progress')`.
  - `document_versions(id uuid pk, created_at, owner_id uuid not null references users, job_id uuid not null references jobs on delete cascade, run_id uuid references generation_runs on delete set null, version_no int not null, label text not null, base_cv_id uuid references base_documents on delete set null, base_cv_hash text not null, base_cover_letter_id uuid references base_documents on delete set null, base_cover_letter_hash text, template_id text not null, cv jsonb not null, cover_letter jsonb not null, reasons jsonb not null, keyword_coverage jsonb not null, review jsonb not null, checks jsonb not null, instruction text, manual_edit boolean not null default false, unique(job_id, version_no))`.
  - `jobs` gains `company_notes text`. `cost_log` gains `generation_run_id uuid references generation_runs on delete set null`.
  - The migration re-queues the active CV once when its analysis has no name: `update base_documents set analysis_status='pending', analysis_attempts=0, analysis_claimed_at=null where kind='cv' and active and analysis_status='done' and not (structured ? 'name')` (one ≈ $0.06 re-analysis; content hash unchanged, so no rescoring).
- Produces: `analyse_cv` output gains required `name: string | null` (the person's name as written at the top).

- [ ] **Step 1: Failing tests** — `applies 004 after 003`; `only one active run per job` (second pending insert for the same job violates the index; a `done` + a `pending` is fine); `004 re-queues a done CV without a name` (and leaves one with a name alone); e2e `cv analysis records the name` (stub answer's `name` lands in `structured.name`).
- [ ] **Step 2: Run** `npm test -w services/worker -- migrate` — Expected: FAIL.
- [ ] **Step 3: Implement** the migration, the prompt line (`- name: his name as written at the top of the CV. null if missing.`), the schema field, the stub field; keep the e2e test that the workflow prompt matches the `.md` file passing.
- [ ] **Step 4: Run** `npm test` and `npm run e2e` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): generation runs and document versions`

---

### Task 2: Standard ATS template, DOCX and PDF rendering

**Files:**
- Create: `services/worker/src/generation/types.ts`, `services/worker/src/generation/validate.ts`, `services/worker/src/templates/standardAts.ts`, `services/worker/src/templates/index.ts`, `services/worker/src/render/pdf.ts`, `services/worker/src/generation/routes.ts`
- Modify: `services/worker/src/server.ts`, `services/worker/package.json`, `docker-compose.yml`, `docker-compose.test.yml` (service `gotenberg`, no host port, `restart: unless-stopped` in main; worker env `GOTENBERG_URL` default `http://gotenberg:3000`), `README.md`
- Test: `services/worker/test/standardAts.test.ts`, `services/worker/test/renderRoute.test.ts`

**Interfaces:**
- Produces types (`generation/types.ts`):
  - `TailoredCv { name: string; headline: string; contact: { location: string|null; email: string|null; phone: string|null; links: { label: string; url: string }[] }; summary: string; workRights: string|null; skills: { group: string; items: string[] }[]; experience: { title: string; employer: string; location: string|null; dates: string; bullets: string[] }[]; education: { qualification: string; institution: string; dates: string; statusText: string }[]; projects: { name: string; bullets: string[] }[] }`
  - `TailoredLetter { date: string; addressee: string; salutation: string; paragraphs: string[]; signOff: string; name: string }` (contact block comes from the CV's `contact` so both match).
  - `TemplateId = 'standard-ats'`; `DocKind = 'cv' | 'cover_letter'`; `RenderFormat = 'docx' | 'pdf'`.
- Produces: `validateTailoredCv(x: unknown): TailoredCv` / `validateTailoredLetter(x: unknown): TailoredLetter` (throw `InvalidDocumentError` naming the bad path); `renderDocx(templateId, kind, cv, letter?): Promise<Buffer>`; `docxToPdf(docx: Buffer, gotenbergUrl): Promise<Buffer>` (POST `/forms/libreoffice/convert`, 20 s timeout); `readPdf(pdf: Buffer): Promise<{ pages: number; text: string }>` (`unpdf`).
- Produces route: `POST /generation/render` JSON `{ templateId, doc: DocKind, format: RenderFormat, cv, coverLetter }` → the file bytes with the right content type (`application/vnd.openxmlformats-officedocument.wordprocessingml.document` / `application/pdf`); `400 {error:"invalid_document", path}`; `502 {error:"pdf_render_failed"}` when Gotenberg fails.

- [ ] **Step 1: Failing tests** — `docx has no tables, one font, numbered bullets` (unzip `word/document.xml`: no `<w:tbl`, every `w:rFonts` is Arial, bullets use `w:numPr`, headings have `w:keepNext`); `dates sit on a right tab stop`; `validate rejects a missing name and names the path`; `render route returns docx bytes starting with PK`; with a fake Gotenberg (`fetch` seam) `pdf route returns %PDF and 502 when gotenberg fails`; `readPdf counts pages` (two-page fixture PDF made in the test).
- [ ] **Step 2: Run** `npm test -w services/worker -- standardAts renderRoute` — Expected: FAIL.
- [ ] **Step 3: Implement.** Section order: name, headline, contact line, work rights (only when not null), Summary, Skills, Experience, Projects (omitted when empty), Education. Cover letter: contact block, date, addressee, salutation, paragraphs, sign-off, name.
- [ ] **Step 4: Run** `npm test -w services/worker`, then an e2e `render through gotenberg gives a 1-page PDF` against the test stack — Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): standard ATS template with DOCX and PDF rendering`

---

### Task 3: Generation code checks

**Files:**
- Create: `services/worker/src/generation/checks.ts`, `services/worker/src/generation/textOf.ts`, `config/au-spelling.txt` (`us au` per line: optimize optimise, analyze analyse, color colour, behavior behaviour, modeling modelling, center centre, organization organisation, … at least 40 pairs; words that are the same in both, like "program" in software, are left out), `config/tech-casing.txt` (canonical forms: JavaScript, TypeScript, GitHub, GitLab, Salesforce, Node.js, React, PostgreSQL, Apex, Lightning Web Components, SOQL, REST, API, AWS, Docker, Tableau, Python, Java, SQL, CI/CD, …)
- Modify: `services/worker/src/generation/routes.ts`, `services/worker/package.json`
- Test: `services/worker/test/generationChecks.test.ts`, `services/worker/test/checkRoute.test.ts`

**Interfaces:**
- Produces: `interface CheckResult { code: CheckCode; severity: 'hard' | 'warning' | 'review'; doc: DocKind; detail: string; where?: string }` with codes and severities:
  - hard: `cv_pages` (> 1), `letter_pages` (> 2), `placeholder` (`[...]`, `{{...}}`, `XX%`, `Lorem`, `TBD`, `<...>`), `company_leakage`, `title_leakage`, `banned_phrase` (`config/banned-phrases.txt`), `us_spelling`, `tech_casing`, `unknown_fact` (a number/percentage, month-year date, employer or job title in the output that does not appear in the base CV's `structured`), `keyword_not_found` (a keyword the writer lists as covered is not in the CV text; US/AU variants count as equal), `link_invalid` (not an `http(s)` URL or `mailto:`), `render_text` (PDF text missing a section heading or the name, or sections out of order).
  - review (the reviewer must rule): `unmatched_skill` (a skill not found in the base CV, possibly an honest rephrase), `possible_misspelling` (not in `dictionary-en-au`, the base CV, the job ad, or the tech list).
  - warning: `missing_work_rights` (base CV has none — writer can't fix it), `link_unreachable` (HEAD/GET failed or 404/410 within 5 s; 401/403/429/999 count as reachable).
- Produces: `runChecks(input: CheckInput): Promise<{ checks: CheckResult[]; cvPages: number; letterPages: number }>` where `CheckInput = { templateId; cv; coverLetter; keywordsCovered: string[]; job: { title: string|null; employer: string|null; advertiser: string|null; rawText: string }; baseCv: { structured: object }; baseCoverLetter: { structured: object } | null; otherJobs: { title: string|null; employer: string|null; advertiser: string|null }[] }`. Leakage names = base cover letter `previousTarget.company/addressee/role` + other jobs' employer/advertiser (titles → `title_leakage`), minus anything equal to the target's employer/advertiser/title, minus anything that appears in the base CV `structured` (own employers, skills). Whole-word, case-insensitive. Links, e-mail addresses and URLs are removed from text before spelling/casing checks.
- Produces route: `POST /generation/check` (body = `CheckInput`) → `{ checks, cvPages, letterPages }`, renders both PDFs itself; `400 invalid_document`.

- [ ] **Step 1: Failing tests** (invented names only) — `placeholder variants are hard fails`; `previous target is leakage` (letter structured previousTarget `{company:'Oldco Pty', addressee:'Ms. Quill'}` → both flagged in output, `where` names the field); `target that is a skill is not leakage` (target employer `Salesforce`, skill `Salesforce`); `own past employer is not leakage`; `us spelling flagged, au passes, keyword match treats them equal`; `Github flagged, GitHub passes, github.com in a link ignored`; `number not in base cv is unknown_fact; '3+ years' present passes`; `unknown employer and title are unknown_fact`; `rephrased skill is unmatched_skill (review)`; `covered keyword missing from cv is keyword_not_found`; `missing work rights is a warning`; `link 999 is reachable, 404 is link_unreachable` (fetch seam); `check route returns pages` (fake Gotenberg returning 2-page PDF → `cv_pages` hard).
- [ ] **Step 2: Run** `npm test -w services/worker -- generationChecks checkRoute` — Expected: FAIL.
- [ ] **Step 3: Implement** with `nspell` + `dictionary-en-au`; lists read once at start from `/app/config` (env `CONFIG_DIR`).
- [ ] **Step 4: Run** `npm test -w services/worker` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): code checks for generated CVs and cover letters`

---

### Task 4: Writer and reviewer prompts, and a scriptable stub

**Files:**
- Create: `n8n/prompts/write-documents.md` (first line `purpose: write_documents`), `n8n/prompts/review-documents.md` (first line `purpose: review_documents`)
- Modify: `tests/stubs/anthropic-stub/server.mjs`
- Test: `tests/e2e/stub.e2e.test.ts` (new, small)

**Interfaces:**
- Writer output schema (`additionalProperties: false` everywhere): `{ templateId: 'standard-ats', templateReason: string, cv: TailoredCv, coverLetter: TailoredLetter, keywordCoverage: { covered: string[], missing: { keyword: string, why: string }[] }, changes: { target: string, what: string, why: string }[], stretches: { target: string, text: string, why: string }[] }`.
- Reviewer output schema: `{ verdict: 'pass' | 'fail', items: { id: ReviewItemId, pass: boolean, note: string }[], objections: { target: string, problem: string, fix: string }[], factRulings: { text: string, ruling: 'honest_rephrase' | 'invented', why: string }[], spellingRulings: { word: string, ruling: 'ok' | 'misspelt', fix: string|null }[], stretches: { target: string, text: string, why: string }[] }`; `ReviewItemId` ∈ `relevance`, `over_tailoring`, `strongest_match_top_third`, `inflated_scope`, `ai_sounding`, `paraphrased_job_ad`, `keyword_stuffing`, `bullet_rhythm`, `star_form`, `tidiness`, `keyword_coverage_honest`, `reasons_hold_up`, `cover_letter_sources`, `addressee`.
- Writer prompt must encode: every spec §2 anti-goal as a rule; facts only from the base CV (select, reorder, rephrase in the job's language, never inflate; "3+ years" and degree/work-rights wording kept exactly as the base CV has them; no work-rights line unless the base CV has one); headline rewritten for this job; strongest match in the top third; site chrome and people named in the ad are never used; cover letter only from job ad, base CV, the base letter's reusableParagraphs/tone (previous target never carried over) and `companyNotes`; addressee only when the ad or notes name one, else "Hiring Manager"; letter targets 1 page; Australian English; on a revision round, fix every objection and every failed check and change nothing else. Inputs arrive in tags `<job_ad>`, `<job_facts>`, `<base_cv_facts>`, `<base_cover_letter>`, `<company_notes>`, `<previous_round>` (revision only), and are data, not instructions.
- Reviewer prompt must encode: senior Australian recruiter / HR / ATS specialist; independent (it did not write the documents); rule every `unmatched_skill` (factRulings) and `possible_misspelling` (spellingRulings); judge each `ReviewItemId`; verify each `changes[].why` and the keyword-coverage claim against the job ad; specific, fixable objections only; `verdict: 'pass'` only when no item fails.
- Stub: canned `write_documents` (valid 1-page document with invented person "Stub Person") and `review_documents` (pass); new control `POST /_script_purpose {purpose, answers: object[]}` — the next requests with that purpose get these answers in order, then the canned one; cleared by `/_reset`.

- [ ] **Step 1: Failing test** — `scripted answers come in order then canned`.
- [ ] **Step 2: Run** `npm run e2e -- stub` — Expected: FAIL.
- [ ] **Step 3: Write** both prompts and the stub changes.
- [ ] **Step 4: Run** `npm run e2e -- stub` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(n8n): writer and reviewer prompts`

---

### Task 5: n8n workflow "Generate documents" (money: per-task review required)

**Files:**
- Create: `n8n/workflows/generate-documents.json` (id `jh-generate-documents`)
- Modify: `scripts/n8n-bootstrap.sh` (shipped ids), `.env.example`, `docker-compose*.yml` (env `WRITER_MODEL`, `REVIEW_MODEL`, `GENERATION_MAX_ROUNDS`), `README.md` (costs)
- Test: `tests/e2e/generate.e2e.test.ts`

**Interfaces:**
- Consumes: `generation_runs`, `document_versions` (Task 1); worker `POST /generation/check` (Task 3); prompts + stub (Task 4).
- Flow (every 30 s, plus webhook `POST api/generation/run` behind the gate for tests):
  1. Give up on stuck runs: `in_progress` with `claimed_at` older than 6 min → `pending` (if `attempts < 3`) else `failed` with `error = 'Generation stopped and gave up after 3 attempts.'`.
  2. Look up both model prices (missing price → stop, nothing claimed).
  3. Claim **one** run: `pending` and due (`attempts = 0`, or `updated_at` older than 1 min after attempt 1 / 5 min after attempt 2), `order by created_at, id limit 1 for update skip locked` → `in_progress`, `attempts + 1`, `claimed_at = now()`, `round = 0`, `rounds = '[]'`.
  4. Load inputs: job (raw text, title, employer, advertiser, company_notes), active base CV (`done`; else fail the run "Your base CV isn't ready."), active base cover letter if `done`, other jobs' title/employer/advertiser, base CV file bytes from the worker.
  5. Loop round 1..`GENERATION_MAX_ROUNDS`: **heartbeat** (`update … set claimed_at = now(), stage = $s, round = $r where id = [1] and claimed_at = [token] returning claimed_at` — no row → stop this execution silently) → writer call → worker checks → reviewer call → append `{round, writer, checks, review, passed}` to `rounds`. `passed` = reviewer `verdict = 'pass'` and no `hard` check and no `invented` fact ruling and no `misspelt` spelling ruling. Passed → leave the loop.
  6. Save (heartbeat-guarded, one transaction): the passing round, else the best (fewest hard checks + failed review items + invented rulings; ties → latest) as the next `version_no` with `label = 'Generated'`, `review = { passed, rounds: n, verdicts: [...], unresolved: [...] }` (unresolved = the best round's remaining hard checks, failed items with notes, warnings like `missing_work_rights`), `reasons = { templateReason, changes, stretches (writer ∪ reviewer), factRulings }`; run `done`; job `status = 'cv_ready'` **only if** it is `new` (with a `job_status_history` row).
  7. Any failed call → `cost_log` row if usage returned, run back to `pending` (attempts < 3, error kept) or `failed`; heartbeat-guarded.
- Cost rows: purposes `write_documents` / `review_documents`, with `job_id` and `generation_run_id`.

- [ ] **Step 1: Failing e2e tests** — `generates and saves version 1 with status cv ready`; `a failed review triggers a revision with the objections` (stub scripted fail → pass; second writer request contains `<previous_round>` and the objection text); `stops after max rounds and keeps the best` (writer scripted to always produce a 2-page CV → 3 writer + 3 reviewer requests, `review.passed=false`, unresolved has `cv_pages`); `status stays applied when already applied`; `lost claim stops the old execution` (delay writer, move the run's `claimed_at` and re-claim, release → the old execution saves no version and changes no run state; the cost row for the call it already made is still written); `api error retries with backoff then fails after 3`; `reviewer never sees the writer prompt` (reviewer request body does not contain the writer prompt's first line); `costs logged per call with run id`; `nothing runs without a pending run` (schedule tick → no stub requests); `prompt in the workflow matches the .md files`.
- [ ] **Step 2: Run** `npm run e2e -- generate` — Expected: FAIL.
- [ ] **Step 3: Implement** the workflow with sticky notes for each numbered step.
- [ ] **Step 4: Run** `npm run e2e` (all) — Expected: PASS.
- [ ] **Step 5: Commit** `feat(n8n): generate documents with an independent reviewer`

---

### Task 6: n8n workflow "Job page API" + jobs list fields (security: per-task review required)

**Files:**
- Create: `n8n/workflows/job-page-api.json` (id `jh-job-page-api`)
- Modify: `n8n/workflows/jobs-api.json` (list adds `generation` and `hasVersion`), `scripts/n8n-bootstrap.sh`, `apps/web/nginx.conf` (allow binary downloads; `client_max_body_size` unchanged)
- Test: `tests/e2e/jobPageApi.e2e.test.ts`, `tests/e2e/jobsApi.e2e.test.ts`

**Interfaces:**
- `POST api/jobs/generate?id=` (gate) → `202 { runId }`; `404 job_not_found`; `409 generation_in_progress` (index violation or existing active run); `422 base_cv_not_ready` / `job_not_ready` (extraction not `done`). Only inserts a `pending` run; makes no Claude call.
- `GET api/jobs/detail?id=` → `{ job: { id, title, employer, advertiser, url, status, rawText, matchScore, matchExplanation, matchBreakdown, warnings, companyNotes }, generation: { status, stage, round, attempts, error } | null, version: { id, versionNo, label, createdAt, templateId, cv, coverLetter, reasons, keywordCoverage, review, checks, baseCvSourceRef, costUsd } | null }` (latest version; `costUsd` = sum of its run's cost rows; match score hidden when its basis is stale, as in the jobs list).
- `POST api/jobs/status?id=` (gate) body `{ status }` ∈ `new, cv_ready, applied, interviewing, closed` → `200 { status }`, writes `job_status_history`; `400 bad_status`.
- `POST api/jobs/notes?id=` (gate) body `{ notes }` (string ≤ 4000 chars) → `200`; `400 bad_notes`.
- `GET api/jobs/download?id=&doc=cv|cover_letter&format=docx|pdf` → file bytes from worker `/generation/render` with `Content-Disposition: attachment; filename="…"` (Global Constraints name rule; also `filename*=UTF-8''…`); `404 no_version`; `400 bad_request`.
- Jobs list items gain `generation: { status, stage, round } | null` (latest run) and `hasVersion: boolean`.

- [ ] **Step 1: Failing e2e tests** — `generate queues one run and answers 202`; `second generate while running is 409`; `generate refused when not ready` (no CV → 422 base_cv_not_ready; extraction failed → 422 job_not_ready; no run row, no stub request); `state-changing endpoints need the header` (generate/status/notes → 403 without it); `detail returns the latest version and its cost`; `status change writes history; bad status 400`; `notes over 4000 chars 400`; `download docx starts with PK, pdf with %PDF, file name sanitised`; `download without a version is 404`; `CORS allows only the web origins`.
- [ ] **Step 2: Run** `npm run e2e -- jobPageApi jobsApi` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run e2e` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(n8n): job page API with generate, status, notes and downloads`

---

### Task 7: Web — job page, Generate on cards

Use the frontend-design skill (CLAUDE.md UI rules: dark default, neutral greys, blue-green accent, status colours with labels, Inter, sidebar layout, keyboard focus visible).

**Files:**
- Create: `apps/web/src/job/JobPage.tsx`, `apps/web/src/job/DocumentPreview.tsx` (CV and letter laid out like the template: same section order and headings), `apps/web/src/job/ReasonsPanel.tsx`, `apps/web/src/job/highlightKeywords.ts`, `apps/web/src/job/labels.ts` (check and review-item display text)
- Modify: `apps/web/src/App.tsx` (route `/jobs/:id`), `apps/web/src/api/client.ts`, `apps/web/src/api/types.ts` (shape validation as for existing responses), `apps/web/src/jobs/JobCard.tsx` (card links to the job page; status New shows **Generate**; running shows "Writing… round n"), `apps/web/src/styles.css`
- Test: `apps/web/src/job/JobPage.test.tsx`, `apps/web/src/job/highlightKeywords.test.ts`, `apps/web/src/api/client.test.ts`, `apps/web/src/jobs/JobCard.test.tsx`

**Interfaces:**
- Consumes: Task 6 endpoints. Client functions: `fetchJobDetail(id)`, `generate(id)`, `setStatus(id, status)`, `saveCompanyNotes(id, notes)`, `downloadUrl(id, doc, format): string` (a plain link; downloads are GETs).
- Job page layout: header (title · employer/advertiser, status dropdown, **Open job posting ↗** via `safeHref`, Download CV DOCX/PDF, Download cover letter DOCX/PDF); "Based on: {baseCvSourceRef}" and "Template: Standard ATS — {templateReason}"; tabs **CV · Cover letter** (preview); job ad with covered keywords highlighted; "My notes about this company" box (saved on blur, shows "Saved"); reasons panel (match score + explanation; keyword coverage covered / missing with why; changes with why; stretches marked "Stretch — you decide"; reviewer verdict, rounds taken, unresolved items in amber; code checks grouped hard / warnings; "This generation cost $x.xx"); Generate button (or "Generate again" when a version exists — runs a fresh generation, no instruction box in Plan 3); while a run is pending/in progress, poll detail every 5 s and show stage and round; failed run shows its error in amber with **Try again**.
- `highlightKeywords(text, keywords): { text: string; hit: boolean }[]` — case-insensitive, whole word, US/AU variants equal (same pairs as `config/au-spelling.txt`, copied into `apps/web/src/job/auSpelling.ts` with a test that the two lists match).

- [ ] **Step 1: Failing tests** — `shows the cv preview and reasons`; `unresolved items are amber with a label`; `generate button queues and shows progress` (mock client: 202 then detail in_progress round 2 → "Reviewing… round 2"); `409 shows already running`; `422 shows the reason`; `downloads are links with doc and format`; `status dropdown saves`; `notes save on blur`; `highlight treats optimise and optimize as the same`; `card shows Generate only for new jobs without a run`; `client rejects a malformed detail response`.
- [ ] **Step 2: Run** `npm test -w apps/web` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w apps/web` and the web e2e — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): job page with generated CV, cover letter and reasons`

---

### Task 8: Real-run verification (controller, on Prayush's stack)

- [ ] **Step 1:** `docker compose up -d --build`, `bash scripts/n8n-bootstrap.sh`; confirm the CV re-analysis from Task 1 added `name` (≈ $0.06).
- [ ] **Step 2:** Click Generate on the highest-scoring job (the browser or `POST api/jobs/generate` with `X-JobHunter: 1`); wait for `done`.
- [ ] **Step 3:** Check: PDF is 1 page; letter ≤ 2 pages; no previous-target names; no banned phrases; facts traceable; reasons and reviewer verdict present; cost per run recorded (expected ≈ $0.25 per round).
- [ ] **Step 4:** Record results and cost in the ledger; report anything that reads wrong to Prayush before merging.

---

### Amendment (Prayush, 2026-11-07, after the Task 3 review)

- **Cover-letter numbers:** in the cover letter only, numbers and dates that appear in the job ad (or the target title/employer) are allowed and are not `unknown_fact`. The CV still allows only numbers and dates from the base CV.
- **Leakage from other jobs:** other jobs' employer/advertiser/title names match **case-sensitively** (whole word), so ordinary words ("insight into") are not flagged. The base cover letter's previous company/addressee/role stay case-insensitive, and also ignore punctuation ("Ms Li" = "Ms. Li").
