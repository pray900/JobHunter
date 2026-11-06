# JobHunter Plan 2: Base Documents + Match Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prayush's base CVs and cover letters are read from their folders (or uploaded on a "My documents" page), analysed by Claude into structured facts, checked for conflicts and missing lines, and every job card gets an explained match score so the board is ranked.

**Architecture:** Same shape as Plan 1. The worker gains a second storage module for the two document folders (read, write, delete — the only code that touches them) and pure check functions. n8n gains three workflows: **Base documents sync** (scan → upsert → Claude analysis → code checks → cross-CV conflict check), **Job match scoring** (scores jobs against all ready base CVs whenever the CV set or the job changes) and **Documents API** (list / upload / relabel / delete). The jobs API and the web app grow to show scores with their explanation and a My documents page.

**Tech Stack:** as Plan 1, plus `react-router-dom` (pinned) for two pages; the worker adds `@fastify/multipart` (pinned) for uploads.

**Spec:** `docs/superpowers/specs/2026-11-06-jobhunter-design.md` — implements §6.1.4 (match score), §6.3 (source of truth: conflicts, work rights, degree status), §6.7 base-document findings, §7.1 score display, §7.3 My documents. Prerequisite: Plan 1 merged, including its final-review fixes and the retry backoff + API-key check Prayush asked for on 2026-11-07.

## Global Constraints

- Everything in Plan 1's Global Constraints still holds (personal data never committed; owner id `00000000-0000-0000-0000-000000000001` on every user-owned row; all UI→backend calls through `apps/web/src/api/client.ts`; all n8n API webhooks under `api/` with Allowed Origins `http://localhost:8080,http://localhost:5173`; readable n8n workflows with sticky notes; parameterised SQL only; only the shipped workflow ids are published by the bootstrap).
- Document folders come from env `CV_DIR` (default `./PersonalDetailsCV`) and `COVER_LETTER_DIR` (default `./PersonalDetailsCoverLetter`), bind-mounted **read-write** into the worker at `/data/cv` and `/data/cover-letter` with the long syntax and `create_host_path: false`. All reads/writes/deletes of these folders go through `services/worker/src/storage/documentFolder.ts`.
- Accepted files: `.pdf` and `.docx` only (case-insensitive), ≤ 5 MB, names starting `~$` or `.` ignored. Uploaded names are sanitised to `[A-Za-z0-9 ._()-]`, must keep their extension, and may never contain path separators or `..`.
- Document contents (text, base64, structured facts) are never written to logs.
- Claude calls follow Plan 1's rules (headers, `output_config.format` JSON schema, first `text` block, `refusal`/`max_tokens` = failure, price looked up before the call, cost row whenever usage returns, retry backoff and 3-attempt cap). For `claude-opus-5-5` and `claude-sonnet-5-5` requests also send header `anthropic-beta: server-side-fallback-2026-07-01` and body `"fallbacks": "default"`.
- PDFs go to Claude as a document block before the instruction text: `{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":<base64>}}`. DOCX files go as extracted text inside `<document>…</document>`.
- Models (env, priced in the n8n price table): `ANALYSE_MODEL` default `claude-opus-5-5` ($4 / $20 per 1M), `output_config.effort: "medium"`, `max_tokens: 16000`; `SCORE_MODEL` default `claude-sonnet-5-5` ($2 / $10 per 1M), `effort: "low"`, `max_tokens: 4000`. Never send `thinking: {type: "disabled"}`, `budget_tokens`, `temperature`, `top_p`, `top_k` or prefill.
- Base-document kinds: `cv`, `cover_letter`. Analysis statuses: `pending`, `in_progress`, `done`, `failed`, `skipped`.
- Warning codes for base documents: `missing_work_rights`, `degree_status_unclear`, `banned_phrase` (informational), `unreadable_file`. Display text is fixed in Task 7.
- The match score measures **Prayush's fit for the job from all ready base CVs vs the job ad**; it is 0–100 with a one-sentence explanation starting with the score (e.g. "82%: …"). It never changes because of generation. It is recomputed only when the set of ready base CVs changes (their content hashes) or the job's content changes.
- UI copy in Australian English.

## Review Focus

1. A base CV changes while scoring runs → no job keeps a score computed from the old CV set; next run rescores with the new basis (Task 5 e2e `basis change during scoring rescores`).
2. Upload with the name of an existing file → refused with 409 unless it is an explicit Replace (Task 2 test `upload refuses to overwrite`, Task 6 e2e `upload same name without replace is 409`).
3. Hostile filenames (`../x.pdf`, `a/b.pdf`, `x.exe`, `x.pdf` that isn't a PDF) → rejected or stored safely, never outside the folder (Task 2 tests `rejects traversal and bad extensions`, `rejects non-pdf bytes`).
4. No ready base CVs → no scoring calls; cards say "Add a base CV to get match scores" (Task 5 e2e `no base CVs means no scoring calls`, Task 7 test `shows add-a-CV hint`).
5. A document whose analysis fails (unreadable, refusal) → marked failed with a visible reason; other documents and scoring carry on using the remaining ready CVs (Task 4 e2e `one failed document doesn't block others`).

---

### Task 1: Schema for base documents and scoring

**Files:**
- Create: `db/migrations/002_base_documents.sql`
- Test: `services/worker/test/migrate.test.ts` (extend)

**Interfaces:**
- Produces tables/columns:
  - `base_documents(id uuid pk default gen_random_uuid(), created_at, updated_at, owner_id uuid not null references users, kind text not null check in ('cv','cover_letter'), source_ref text not null, content_hash text not null, media_type text not null check in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'), label text, label_suggested text, structured jsonb, warnings jsonb not null default '[]', analysis_status text not null default 'pending' check in ('pending','in_progress','done','failed','skipped'), analysis_attempts int not null default 0, analysis_claimed_at timestamptz, analysis_error text, source_removed boolean not null default false, unique(owner_id, kind, source_ref))`
  - `base_document_checks(id, created_at, owner_id uuid not null references users, basis_hash text not null, conflicts jsonb not null, unique(owner_id, basis_hash))` — `conflicts` is `[{ fact: string, values: [{ sourceRef: string, text: string }], suggestion: string }]`.
  - `jobs` gains: `score_status text not null default 'pending' check in ('pending','in_progress','done','failed','skipped')`, `score_attempts int not null default 0`, `score_claimed_at timestamptz`, `match_basis_hash text`, `match_breakdown jsonb` (`{ matched: string[], missing: string[], notes: string[] }`).
  - `cost_log` gains `base_document_id uuid references base_documents on delete set null`.

- [ ] **Step 1: Write failing tests** — `applies 002 after 001` (`runMigrations` returns `['002_base_documents.sql']` on a DB already at 001); `base_documents unique per owner/kind/source_ref`; `jobs.score_status defaults to pending`.
- [ ] **Step 2: Run** `npm test -w services/worker -- migrate` — Expected: FAIL.
- [ ] **Step 3: Implement** the migration.
- [ ] **Step 4: Run** `npm test -w services/worker` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(db): base documents and scoring columns`

---

### Task 2: Document folder storage, scan, upload, delete

**Files:**
- Create: `services/worker/src/storage/documentFolder.ts`, `services/worker/src/documents/scan.ts`, `services/worker/src/documents/types.ts`, `services/worker/src/documents/routes.ts`
- Modify: `services/worker/src/server.ts`, `docker-compose.yml`, `docker-compose.test.yml` (rw mounts, env `CV_DIR`/`COVER_LETTER_DIR`; test stack binds `./.tmp/e2e-cv`, `./.tmp/e2e-cover-letter`), `.env.example`, `README.md`
- Test: `services/worker/test/documentFolder.test.ts`, `services/worker/test/documentRoutes.test.ts`

**Interfaces:**
- Consumes: `parseJobDocx`'s mammoth approach for DOCX text (reuse the block-text helper rather than duplicating it).
- Produces: `type DocumentKind = 'cv' | 'cover_letter'`; `interface ScannedDocument { kind: DocumentKind; sourceRef: string; contentHash: string; mediaType: 'application/pdf' | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; pdfBase64: string | null; text: string | null; warnings: ('unreadable_file')[] }` (PDF → `pdfBase64`, DOCX → `text`).
- Produces storage: `listDocuments(kind): Promise<{ name; bytes }[]>` (same rules as `listJobFiles`, including `DocumentFolderMissingError` for a missing folder), `writeDocument(kind, name, bytes, { replace: boolean }): Promise<void>` (throws `DocumentExistsError` when the file exists and `replace` is false; writes to a temp file in the same folder then renames), `deleteDocument(kind, name): Promise<void>` (ENOENT → `DocumentNotFoundError`).
- Produces routes: `POST /documents/scan → { documents: ScannedDocument[] }` (503 `{error:"document_folder_missing", kind}` when a folder is missing); `POST /documents/:kind` multipart field `file`, query `replace=true|false` → `201 { sourceRef }`, `409 {error:"document_exists"}`, `400 {error:"bad_file"}` (bad extension, empty, > 5 MB, PDF without `%PDF-` magic, DOCX not a zip); `DELETE /documents/:kind/:name → 204 | 404`.

- [ ] **Step 1: Write failing tests**

```ts
test('scan returns PDFs as base64 and DOCX as text for both kinds', ...)          // kinds, mediaType, hash = sha256 of bytes
test('missing cv folder → 503 document_folder_missing', ...)
test('upload refuses to overwrite', async () => { /* first 201, second same name 409, with replace=true 201 and bytes replaced */ });
test('rejects traversal and bad extensions', async () => {
  for (const name of ['../x.pdf', 'a/b.pdf', 'a\\b.pdf', 'x.exe', '.hidden.pdf', '~$x.docx']) expect((await upload(name)).statusCode).toBe(400);
});
test('rejects non-pdf bytes', async () => { /* 'hello' named x.pdf → 400 bad_file */ });
test('delete removes the file; unknown name → 404', ...)
test('sanitises odd characters but keeps the extension', async () => { /* 'CV – Sep*2026.pdf' → sourceRef 'CV  Sep2026.pdf' or similar; file exists inside the folder */ });
```

- [ ] **Step 2: Run** `npm test -w services/worker -- document` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w services/worker` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): document folders, scan, upload and delete`

---

### Task 3: Base-document code checks

**Files:**
- Create: `services/worker/src/documents/checks.ts`, `config/banned-phrases.txt`
- Modify: `services/worker/src/documents/routes.ts` (route), compose files (mount `./config:/app/config:ro` into the worker)
- Test: `services/worker/test/documentChecks.test.ts`

**Interfaces:**
- Consumes: the analysis output shape `BaseCvFacts` (defined here, used by Task 4's JSON schema): `{ headline: string|null; summary: string|null; workRights: string|null; education: { qualification: string; institution: string; dates: string; statusText: string }[]; roles: { title: string; employer: string; dates: string; bullets: string[] }[]; projects: { name: string; bullets: string[] }[]; skills: string[]; metrics: string[]; contact: { location: string|null; email: string|null; phone: string|null; links: string[] } }`; cover letters: `BaseCoverLetterFacts = { previousTarget: { company: string|null; addressee: string|null; role: string|null }; reusableParagraphs: string[]; toneNotes: string }`.
- Produces: `checkBaseCv(facts: BaseCvFacts, bannedPhrases: string[]): DocWarning[]`, `checkBaseCoverLetter(facts, bannedPhrases): DocWarning[]` where `DocWarning = { code: 'missing_work_rights' | 'degree_status_unclear' | 'banned_phrase'; detail: string }`; route `POST /documents/checks` body `{ kind, facts }` → `{ warnings: DocWarning[] }`. `banned-phrases.txt`: one phrase per line, `#` comments; seed with the spec §2 list (spearheaded, leveraged, leveraging, results-driven, passionate, dynamic, proven track record, thrilled, fast-paced, synergies, express my interest).

Rules: `missing_work_rights` when `workRights` is null/blank. `degree_status_unclear` for any education entry whose `dates` or `statusText` says "Present"/"current"/has no end, unless it contains "conferral" or "conferred". `banned_phrase` (case-insensitive, word-boundary) for each phrase found anywhere in the facts' text fields; `detail` names the phrase.

- [ ] **Step 1: Write failing tests** — `flags missing work rights`; `accepts "Full working rights (485 visa)"`; `flags "2025 – Present" degree`; `accepts "(conferral Nov 2026)"`; `finds "Proven track record" case-insensitively but not "proven" alone`; `cover letter: finds "leveraging" and "fast-paced"`; route test returns the warnings.
- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `feat(worker): base document checks`

---

### Task 4: n8n workflow "Base documents sync"

**Files:**
- Create: `n8n/workflows/base-documents-sync.json`, `n8n/prompts/analyse-cv.md`, `n8n/prompts/analyse-cover-letter.md`, `n8n/prompts/check-cv-conflicts.md`
- Modify: `tests/e2e/lib.ts` (`writeDocument(kind, name, bytes)`, `removeDocument`, `triggerDocumentsSync()`, extend `resetState`), `tests/stubs/anthropic-stub/server.mjs` (respond by request purpose — see below), `scripts/n8n-bootstrap.sh` only if needed to publish the new id
- Test: `tests/e2e/documents.e2e.test.ts`

**Interfaces:**
- Consumes: worker `POST /documents/scan`, `POST /documents/checks` (Tasks 2–3), schema (Task 1).
- Produces: workflow id `jh-base-documents-sync`, triggers Schedule (60 s, gated by `JOBHUNTER_SCHEDULE_ENABLED`) and Webhook `POST api/documents/sync` → `{ ok, scanned, analysed, conflictsChecked: boolean }`.

Stages (sticky note each): scan (non-2xx stops the run, nothing changed) → upsert `base_documents` (same rules as job upsert: hash change resets analysis + clears `structured`/`warnings`/`label_suggested`, never touches `label`) → mark removed → look up `ANALYSE_MODEL` price → claim pending analyses (backoff + cap, claim token) → Claude analysis per document (CV prompt vs cover-letter prompt, JSON schema = `BaseCvFacts` / `BaseCoverLetterFacts` + `labelSuggestion: string`) → save `structured`, `label_suggested`, and `label` **only if `label` is null** → worker checks → save warnings → cost row (with `base_document_id`) → **conflict check**: compute `basis_hash` = sha256 of the sorted `content_hash`es of `kind='cv' and analysis_status='done' and not source_removed`; if ≥ 2 ready CVs and no `base_document_checks` row for that basis, one Claude call (`check-cv-conflicts.md`, schema `{ conflicts: [...] }`) over all ready CVs' `structured`, insert the row (with ≤ 1 ready CV, insert `conflicts: []` without calling Claude).

Prompts must say: extract only what the document states, verbatim where possible; never infer or improve; `workRights` null unless an explicit right-to-work line exists; `metrics` = every number/percentage claim as written; label suggestion = 2–5 words naming the kind of role (e.g. "LLM / QA", "Software engineering / cybersecurity"). Conflict prompt: report only genuine disagreements about the same fact (scope verbs like "Led" vs "for", counts, dates, titles, years of experience), name each source file, suggest the more conservative wording; never report differences of emphasis or omission.

Stub changes: route by a marker in the system prompt (`purpose: analyse_cv | analyse_cover_letter | check_cv_conflicts | score_job | extract_job`) and return a canned valid JSON for each; keep `STUB_FAIL`/`STUB_REFUSE`. Each prompt's first line is `purpose: <name>` so the stub can route.

- [ ] **Step 1: Write failing e2e tests** — `new PDF CV is analysed, labelled and checked` (label = stub suggestion, warnings include `missing_work_rights` from the canned facts, one cost row with base_document_id); `relabel survives re-analysis` (set label, change file, sync → `label` unchanged, `label_suggested` updated); `cover letter uses cover-letter prompt` (stub saw purpose `analyse_cover_letter`); `two CVs trigger one conflict check, unchanged basis doesn't repeat it`; `one CV → conflicts [] with no Claude call`; `one failed document doesn't block others` (STUB_FAIL in one → failed with `analysis_error`, other done, conflict check runs over the done ones); `missing cv folder stops the run, nothing changed`; `request is a PDF document block` (stub saw `content[0].type === 'document'` with `media_type` application/pdf) and `sends fallbacks for opus`.
- [ ] **Step 2: Run** `npm run e2e -- documents` — Expected: FAIL.
- [ ] **Step 3: Build** the workflow JSON, prompts, stub routing, lib helpers.
- [ ] **Step 4: Run** `npm run e2e` — Expected: all PASS.
- [ ] **Step 5: Commit** `feat(n8n): base documents sync`

---

### Task 4b: Simplify to one base CV and one base cover letter (Prayush's change, 2026-11-07)

Prayush changed the design: **exactly one base CV and one base cover letter** (spec §4, §6.2, §6.3, §7.3 updated). This task removes what Task 4 built for several CVs and adds the "one active document per kind" rule. It also applies Prayush's decision to stop n8n saving successful runs.

**Files:**
- Create: `db/migrations/003_single_base_document.sql`
- Modify: `services/worker/src/storage/documentFolder.ts`, `services/worker/src/documents/scan.ts`, `services/worker/src/documents/types.ts` (scan reports each file's `modifiedAt`), `n8n/workflows/base-documents-sync.json`, `n8n/workflows/job-intake-sync.json`, `n8n/workflows/jobs-api.json` (settings only), `tests/stubs/anthropic-stub/server.mjs`, `tests/e2e/documents.e2e.test.ts`, `services/worker/test/*` as needed, `README.md`
- Delete: `n8n/prompts/check-cv-conflicts.md`

**Interfaces:**
- `ScannedDocument` gains `modifiedAt: string` (ISO, from the file's mtime).
- Migration 003: drop table `base_document_checks`; drop columns `base_documents.label`, `base_documents.label_suggested`; add `base_documents.active boolean not null default false` with a partial unique index so at most one row per `(owner_id, kind)` is `active`.
- **Active document rule:** per kind, the active document is the non-removed, readable file with the newest `modifiedAt` (ties → `sourceRef` ascending). Every other present file of that kind gets warning `{ code: 'extra_file_ignored', detail: 'Only one <CV|cover letter> is used; this file is ignored.' }` and is **never sent to Claude** (`analysis_status='skipped'`). Only the active document is analysed. When the active document changes, the new one is analysed and the old one becomes ignored.
- **Basis hash** (used by Task 5) = the `content_hash` of the active CV whose `analysis_status='done'`, or null when there is none.
- Remove from the workflow: the conflict-check stages, the label suggestion and label saving, and `labelSuggestion` in the analysis schemas. Keep everything else from Task 4 (claim, backoff, cap, price check, 403 gate, cost rows, checks).
- All shipped workflows set `settings.saveDataSuccessExecution: "none"` and `saveManualExecutions: false` (Prayush's decision); failed runs are still saved. README: one line explaining it and how to switch it on per workflow while learning.

- [ ] **Step 1: Write failing tests** — migrate test applies 003; scan returns `modifiedAt`; e2e `two CVs: only the newest is analysed, the other is ignored` (stub sees one analyse_cv request; the older row has `extra_file_ignored` and `skipped`); `newer CV takes over` (touch the older file to make it newest → it is analysed, the other becomes ignored); `no conflict check is ever called`; `analysis schema has no labelSuggestion`; `shipped workflows don't save successful runs` (workflow-definition test over all JSON files). Remove or rewrite the Task 4 tests about labels and conflicts.
- [ ] **Step 2–4:** run (FAIL) → implement → worker suite + `npm run e2e` (PASS).
- [ ] **Step 5: Commit** `refactor: one base CV and one cover letter`

---

### Task 5: n8n workflow "Job match scoring"

**Files:**
- Create: `n8n/workflows/job-match-scoring.json`, `n8n/prompts/score-job.md`
- Modify: `n8n/workflows/job-intake-sync.json` (upsert resets scoring on content change — see note at the end of this task), `tests/e2e/intake.e2e.test.ts`
- Test: `tests/e2e/scoring.e2e.test.ts`

**Interfaces:**
- Consumes: `jobs` (extraction done), `base_documents` ready CVs and their `structured`.
- Produces: workflow id `jh-job-match-scoring`, Schedule (30 s, gated) and Webhook `POST api/jobs/score` → `{ ok, scored, basisHash }`. Writes `match_score`, `match_explanation`, `match_breakdown`, `match_basis_hash`, `score_status`.

Stages: compute current basis (the Task 4b definition: the active, analysed CV's content hash; none → mark nothing, respond `{ok:true, scored:0, basisHash:null}`, stop) → reset jobs whose `match_basis_hash` differs from the current basis (and `score_status` not `in_progress` with a live claim) to `pending`, attempts 0 → look up `SCORE_MODEL` price → claim (`extraction_status='done' and not source_removed and score_status='pending'` or failed with backoff/cap; claim token) → Claude score (input: job `raw_text` in `<job_ad>`, the active CV's `structured` in `<base_cv>`; schema `{ score: integer 0–100, explanation: string, matched: string[], missing: string[], notes: string[] }`) → save with `match_basis_hash = <basis used for this call>` only if the job's claim token still matches **and** the basis is still current (otherwise leave `pending`) → cost row.

Prompt must say: judge only from the base CVs (never assume skills not stated); treat US/AU spellings as the same keyword; ignore job-site clutter; weigh required over nice-to-have; count years from the CV dates; explanation is one sentence starting with "<score>%:" naming required skills matched/total, any experience gap, and domain fit.

Also include the 403 gate (`X-JobHunter: 1`) on `POST api/jobs/score` and `saveDataSuccessExecution: "none"`.

**Amended 2026-11-07 (Prayush approved after the Task 5 review):** the reset stage tags each job with the new basis and clears its old score (`match_basis_hash` means "the basis this job's score state belongs to", not only "the basis of the saved score"), so a job resets once per new CV and the 3-attempt cap holds. Claims take at most **10 jobs per run** (ordered oldest first); the same limit applies to Plan 1's extraction claim in `job-intake-sync.json`.

- [ ] **Step 1: Write failing e2e tests** — `scores a job against the base CV` (score, explanation starts with "%:" pattern from stub, breakdown saved, basis hash = current, cost row purpose `score_job`); `no base CVs means no scoring calls`; `unchanged basis doesn't rescore`; `CV change rescores all jobs` (change a CV file → documents sync → scoring sync → stub saw a new score call per job, basis updated); `basis change during scoring rescores` (force a job `in_progress` with an old basis claim, change basis, sync → job ends scored with the new basis, never saved with the old one); `job file edit rescores that job` (extraction resets → after re-extraction the job is scored again); `scoring failure is retried with backoff then gives up`; `sends fallbacks for sonnet`.
- [ ] **Step 2–4:** run (FAIL) → build → `npm run e2e` (PASS).
- [ ] **Step 5: Commit** `feat(n8n): job match scoring`

Note: when a job's content hash changes, Plan 1's upsert must also reset `score_status='pending'`, `score_attempts=0`, `match_score/explanation/breakdown/basis = null` — modify `job-intake-sync.json`'s upsert in this task and extend the `edited file updates the same job` e2e assertions accordingly.

---

### Task 6: n8n workflow "Documents API" + jobs API fields

**Files:**
- Create: `n8n/workflows/documents-api.json`
- Modify: `n8n/workflows/jobs-api.json` (add `matchExplanation`, `matchBreakdown`, `scoreStatus` to `JobSummary`; keep ordering), `tests/e2e/jobsApi.e2e.test.ts`
- Test: `tests/e2e/documentsApi.e2e.test.ts`

**Interfaces:**
- Produces (all webhooks Allowed Origins as Global Constraints):
  - `GET api/documents` → `{ cv: BaseDocumentSummary | null, coverLetter: BaseDocumentSummary | null, ignored: BaseDocumentSummary[] }` where `BaseDocumentSummary = { id; kind: 'cv'|'cover_letter'; sourceRef; analysisStatus; analysisError: string|null; warnings: { code; detail }[]; updatedAt: string }`; `cv`/`coverLetter` are the active documents (Task 4b), `ignored` the other present files.
  - `POST api/documents/upload?kind=cv|cover_letter` multipart `file` → writes the new file via the worker (`replace=false`; a name clash → 409), then deletes the previous active document of that kind via the worker, then triggers `api/documents/sync` → `201 { sourceRef }` / 400 / 409. (Upload = replace the current one; the UI confirms first.)
  - `DELETE api/documents?id=<uuid>` → looks up kind/sourceRef, calls worker delete, marks the row removed, triggers sync (so the basis changes and jobs rescore) → `204` / `404`.
  - `JobSummary` gains `matchExplanation: string|null`, `matchBreakdown: { matched: string[]; missing: string[]; notes: string[] } | null`, `scoreStatus: 'pending'|'in_progress'|'done'|'failed'|'skipped'`.

All state-changing webhooks require `X-JobHunter: 1` (403 otherwise) and every workflow sets `saveDataSuccessExecution: "none"`.

- [ ] **Step 1: Write failing e2e tests** — list shape (exact keys) with an active CV, an active cover letter and one ignored file; `upload same name as an existing file is 409`; upload replaces the current CV (old file gone from the e2e folder, new one active and analysed after sync); upload then list shows the new document pending→done after sync; requests without `X-JobHunter` → 403; delete → file gone from the e2e folder, row `sourceRemoved: true`, jobs reset to pending scoring; jobs API new keys present; foreign `Origin` gets no CORS allow header on the new endpoints.
- [ ] **Step 2–4:** run (FAIL) → build → `npm run e2e` (PASS).
- [ ] **Step 5: Commit** `feat(n8n): documents API and score fields`

---

### Task 7: Web — My documents page and scores on cards

**Files:**
- Create: `apps/web/src/documents/DocumentsPage.tsx`, `apps/web/src/documents/DocumentSlot.tsx`, `apps/web/src/documents/labels.ts`, `apps/web/src/Nav.tsx`
- Modify: `apps/web/src/App.tsx` (routes `/` Jobs, `/documents` My documents), `apps/web/src/api/types.ts`, `apps/web/src/api/client.ts` (`fetchDocuments()`, `uploadDocument(kind, file)`, `deleteDocument(id)`), `apps/web/src/jobs/JobCard.tsx`, `apps/web/nginx.conf` (allow uploads: `client_max_body_size 6m` on `/api/`; SPA fallback covers `/documents`)
- Test: `apps/web/src/documents/DocumentsPage.test.tsx`, `apps/web/src/jobs/JobCard.test.tsx` (extend), `tests/e2e/web.e2e.test.ts` (extend: `/documents` serves the app)

**Interfaces:**
- Consumes: Task 6 shapes, copied verbatim into `api/types.ts`.
- Produces copy (verbatim): nav "Jobs", "My documents"; page heading "My documents"; two slots "Your CV" and "Your cover letter", each showing the file name, status and warnings, or "No CV yet" / "No cover letter yet"; buttons "Upload CV" / "Upload cover letter" (empty slot) or "Replace" (filled slot); replace confirm (in-page dialog, not `window.confirm`) "Replace {sourceRef}? The old file is removed from your folder."; statuses "Analysing…", "Ready", "Couldn't read this document: {analysisError}"; warning texts `missing_work_rights` "No work-rights line (e.g. "Full working rights (485 visa)")", `degree_status_unclear` "Degree status unclear — say e.g. "(conferral Nov 2026)"", `banned_phrase` "Phrase that reads as AI or cliché: {detail}"; ignored files section "Other files in your folders (not used)" listing each `sourceRef` with "Delete" (in-page confirm "Delete {sourceRef}? This removes the file from your folder."); 409 on upload → "A file with that name is already in the folder. Rename your file and try again."; 400 → "That file can't be used. Upload a PDF or Word file under 5 MB."
- Card changes: score badge "{n}% match"; "Why this score?" toggle revealing `matchExplanation` and the matched/missing lists ("Matched:", "Missing:"); `scoreStatus` `pending`/`in_progress` → "Scoring…" (only when extraction is done), `failed` → "Couldn't score this job"; when the documents API reports no ready CVs, cards with no score show "Add a base CV to get match scores" linking to `/documents`.

- [ ] **Step 1: Write failing tests** — page shows the CV and cover-letter slots with status/warnings and the empty-slot text; replace asks in-page then calls `uploadDocument`; upload 409 shows the name-clash message; ignored files list with in-page delete calling `deleteDocument`; card shows "82% match" and toggles the explanation; `shows add-a-CV hint`; nav switches pages.
- [ ] **Step 2–4:** run (FAIL) → implement → `npm test -w apps/web && npm run e2e` (PASS).
- [ ] **Step 5: Commit** `feat(web): my documents page and match scores`

---

### Task 8: Real-run verification with Prayush's documents

**Files:**
- Modify: `README.md` (My documents, how scores work, costs: about $0.02 per base document analysed with Opus 5.5 and about $0.01 per job scored with Sonnet 5.5 — confirm against the real `cost_log` and correct the numbers)

- [ ] **Step 1:** Rebuild the real stack and bootstrap (`docker compose up -d --build`, `bash scripts/n8n-bootstrap.sh`).
- [ ] **Step 2: Verify documents** at `http://localhost:8080/documents`. Prayush's CV folder currently has 2 files: expected the newer CV file (September) is the active CV and `Ready`, the April one is listed under "Other files in your folders (not used)" and was never sent to Claude; the CV warns `missing_work_rights` and `degree_status_unclear`; the cover letter is `Ready` and warns about "leveraging" / "fast-paced"; its `structured.previousTarget` names the company and addressee of the letter's original target.
- [ ] **Step 3: Verify scores** on the board: all 3 jobs scored with explanations; the Salesforce Developer role (job1) ranks above the senior 5+ years role (job2), which ranks above the Tableau pre-sales role (job3); no explanation claims a skill absent from the CV. Total cost in `cost_log` for this run < $0.15.
- [ ] **Step 4: Verify rescoring** — replace the CV with a copy under a new name through the page (basis changes → all jobs rescore once, then stop); confirm the old file is gone from the folder. Then restore Prayush's original CV the same way and delete the copy, so the folder ends exactly as it started.
- [ ] **Step 5:** All suites green (`npm test`, `npm run e2e`); commit `docs: README for plan 2`.
