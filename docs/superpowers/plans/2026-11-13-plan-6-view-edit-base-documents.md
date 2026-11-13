# JobHunter Plan 6: View and edit the base CV and cover letter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On My documents Prayush can open his base CV or base cover letter, see the original file next to the facts Claude read from it, and correct those facts in the app (e.g. drop "Sub-major in Cybersecurity" from a qualification), so every later score, Generate and Regenerate uses the corrected facts.

**Architecture:** The facts Claude extracted stay in `base_documents.structured`; Prayush's corrections go in a new `edited_facts` column (null = not edited). Everything that reads base facts reads `coalesce(edited_facts, structured)` ("effective facts"), and everything that compared `content_hash` as "the CV in use" compares a new generated `facts_hash` instead, so an edit re-scores jobs and is recorded on new versions exactly like a new upload would be. Once the CV is edited, the original file is no longer sent to the writer or the reviewer, because it would contradict the edited facts. Saving an edit never calls Claude.

**Tech Stack:** as Plans 2–4 (Postgres 17, Node 24 worker with Fastify, n8n 2.46.6 workflows, React 19 + Vite web, Vitest). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-06-jobhunter-design.md`. This plan changes §6.3 (source of truth), §7.3 (My documents) and §8 (data). Prayush skipped the design questions ("yes. start", 2026-11-13), so the decisions below are Claude's calls unless marked otherwise. Prerequisite: Plan 4 merged (main d9a1b37).

## Decisions (Claude's calls, for Prayush to check)

- **What "edit" means:** you edit the **facts** (the structured fields the writer copies from), not the PDF or Word file. The original file is kept unchanged and shown for reference.
- **Edited facts win:** once a document is edited, its edited facts are the base CV / cover letter everywhere: scoring, Generate, Regenerate, edit checks, the Diff vs base CV tab. The original CV file is then **not** sent to Claude, so the writer and the reviewer never see two versions of the facts.
- **No history for base edits:** one current set of edits per document. **Undo all edits** goes back to what Claude read from the file. Tailored versions already record which base CV they came from (`base_cv_hash`), so nothing about past versions is lost.
- **Replacing the file drops the edits:** a new file is read fresh. If the slot holds edits, the Replace dialog says so first. Uploading the same file again keeps the edits (it changes nothing, as today).
- **Cost:** saving is free. Saving a CV edit re-scores every job once (about US$0.016 each), the same as uploading a new CV. The edit form shows this before you save. Saving facts identical to what was read from the file stores no edit and re-scores nothing. Cover-letter edits re-score nothing.
- **Viewing the original:** a PDF is shown inside the page. A Word file can't be shown by the browser, so it gets a **Download original** button.

## Global Constraints

- Everything in Plans 1–4's Global Constraints and Amendments still holds: personal data never committed, invented names in fixtures; owner id on every row and query; all UI→backend calls through `apps/web/src/api/client.ts`; n8n `api/` webhooks with Allowed Origins `http://localhost:8080,http://localhost:5173`; the `X-JobHunter: 1` header check is the first node of every state-changing webhook; `saveDataSuccessExecution: "none"`; risky nodes `onError: continueRegularOutput` so failures answer cleanly; parameterised SQL; no dollar-digit in SQL comments; answers within 30 s; migrations 001–005 never edited; workflow prompt copies stay identical to `n8n/prompts/*.md`.
- **Saving, undoing and viewing never call Claude.**
- Effective facts = `coalesce(edited_facts, structured)`. The basis of a base document = `facts_hash` (equals `content_hash` while unedited, so existing scores and versions stay valid on migration).
- Facts limits (checked by the worker, `400 invalid_facts` with the first bad `path`): the exact shape of the analysis schema (CV: `name, headline, summary, workRights, education[], roles[], projects[], skills[], metrics[], contact{location,email,phone,links[]}`; letter: `previousTarget{company,addressee,role}, reusableParagraphs[], toneNotes`); no extra keys; each string at most 4000 characters with no NUL; each list at most 100 items; whole body at most 200 KB. Strings are trimmed. A blank nullable field becomes `null`. Blank entries in string lists (bullets, skills, metrics, links, paragraphs) are dropped.
- UI follows CLAUDE.md UI rules (frontend-design skill; dark default; neutral greys with a blue-green accent; amber for warnings, always with a label; visible focus; no heavy animation). Original file and facts sit side by side. **E** edits, never while typing in a field. Australian English.

## Review Focus

1. **File replaced after editing** → the new file is analysed fresh and its row has no edits. Re-uploading the *same* file keeps the edits (Task 2 e2e `replacing the file drops the edits`, `same file again keeps the edits`).
2. **Save against a stale document** (CV replaced in another tab, or still being analysed) → `409 document_changed`, nothing saved; the page says "Your CV changed since you opened it. Reload to edit the new one." (Task 2 e2e `save on a replaced document is 409`, Task 5 test `409 shows reload message`).
3. **Hostile or broken facts** (extra keys, a 10 000-item list, NUL, a number where text belongs, a missing field, a non-object body) → `400 invalid_facts` with the path; nothing saved (Task 1 tests `rejects …`, Task 2 e2e `bad facts are 400`).
4. **Edits identical to the file's facts** (opened Edit, saved without changing anything) → stored as no edit; no re-score (Task 2 e2e `saving unchanged facts stores no edit`).
5. **Generation already running when the CV is edited** → its recorded rounds carry the old `facts_hash`; a retry stops with "Your base documents changed while this was being written. Choose Generate again." (existing rule, now on `facts_hash`); a completed version records the hash it was written from (Task 3 e2e `edit during a run does not mix facts`).

---

### Task 1: Schema and worker (facts validation, file read)

**Files:**
- Create: `db/migrations/006_base_document_edits.sql`, `services/worker/src/documents/validateFacts.ts`
- Modify: `services/worker/src/documents/types.ts` (add `name: string | null` to `BaseCvFacts`), `services/worker/src/documents/routes.ts`
- Test: `services/worker/test/migrate.test.ts`, `services/worker/test/validateFacts.test.ts`, `services/worker/test/documentRoutes.test.ts`

**Interfaces:**
- Migration 006: `base_documents` gains `edited_facts jsonb`, `edited_at timestamptz`, and `facts_hash text generated always as (case when edited_facts is null then content_hash else content_hash || ':' || md5(edited_facts::text) end) stored`.
- `validateFacts(kind: DocumentKind, input: unknown): { ok: true; facts: BaseCvFacts | BaseCoverLetterFacts } | { ok: false; path: string }`. Path style `facts.roles[2].bullets[0]`, `facts` for the whole body. Applies the normalising rules in Global Constraints.
- Route `POST /documents/facts/check` `{ kind, facts }` → `200 { facts, warnings }` (the normalised facts and `checkBaseCv` / `checkBaseCoverLetter` on them) | `400 { error: 'invalid_facts', path }` | `400 bad_request` (unknown kind).
- Route `GET /documents/:kind/file` → the current stored file's bytes with `Content-Type` = its media type and header `X-Source-Ref` = its stored name | `404 no_document` | `404 unknown_kind`.

- [ ] **Step 1: Failing tests:** `applies 006 after 005`; `facts_hash equals content_hash without edits and changes with them`; `validateFacts accepts analysed CV facts unchanged`; `validateFacts accepts letter facts`; `trims, nulls blank nullable fields, drops blank list entries`; `rejects extra keys`, `rejects a list over 100 items`, `rejects a string over 4000 characters`, `rejects NUL`, `rejects a number where text belongs` (each asserting the exact `path`); `rejects a missing field`; `facts/check returns normalised facts and warnings` (edited CV without work rights → `missing_work_rights`); `facts/check 400 invalid_facts`; `file route returns the stored PDF bytes and type`; `file route 404 when empty`.
- [ ] **Step 2: Run** `npm test -w services/worker -- migrate validateFacts documentRoutes`. Expected: FAIL.
- [ ] **Step 3: Implement.** Read the bytes through the existing `DocumentStore` (the same module `scanDocuments` uses); never log contents. The 200 KB cap is the route's `bodyLimit`.
- [ ] **Step 4: Run** `npm test -w services/worker`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: base document edits schema and facts validation`

---

### Task 2: n8n Documents API: read facts, save edits, view file (security: per-task review)

**Files:**
- Modify: `n8n/workflows/documents-api.json`, `n8n/workflows/base-documents-sync.json` ("Upsert base document": a content change also sets `edited_facts = null, edited_at = null`)
- Test: `tests/e2e/documentsApi.e2e.test.ts`, `tests/e2e/lib.ts` (helper `saveFacts(kind, id, facts)`)

**Interfaces** (all webhooks in the Documents API workflow, same CORS as today):
- `GET api/documents`: each slot also has `edited: boolean`, `editedAt: string | null`.
- `GET api/documents/facts?kind=cv|cover_letter` → `200 BaseDocumentFacts` | `404 no_document` (no active, analysed row) | `400 bad_request`.
  `BaseDocumentFacts = { id, kind, sourceRef, mediaType, facts, edited, editedAt, warnings, rescoreJobs }`. `facts` = effective facts. `rescoreJobs` = for a CV, the number of jobs with `extraction_status = 'done'` and not `source_removed`; 0 for a letter.
- `POST api/documents/facts` (header check first) body `{ kind, id, facts }` (`facts: null` = undo all edits) → `200 BaseDocumentFacts` | `400 bad_request` | `400 invalid_facts { path }` | `409 document_changed` (`id` is not the active, analysed, not-removed row of that kind).
  Flow: load the row → worker `/documents/facts/check` with `facts` (or the row's `structured` when `facts` is null) → one `update … set edited_facts = nullif($facts::jsonb, structured), edited_at = (case: now() when an edit remains, else null), warnings = $warnings … where id = $id and owner and kind and active and analysis_status = 'done' and not source_removed returning …`. No row → 409.
- `GET api/documents/file?kind=` → the original bytes from the worker. PDF: `Content-Disposition: inline`. Word: `attachment`. Filename = source ref (same RFC 5987 encoding as the job download). `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`. `404 no_document`.

- [ ] **Step 1: Failing e2e tests:** `facts of the analysed CV`; `save an edit: 200, edited, scores reset`; `saving unchanged facts stores no edit` (scores untouched); `undo all edits goes back to the file's facts`; `bad facts are 400` (extra key, non-object); `save without X-JobHunter is 403`; `save on a replaced document is 409`; `replacing the file drops the edits`; `same file again keeps the edits`; `warnings follow the edited facts`; `cover letter edit leaves scores alone`; `file endpoint serves the PDF inline and Word as attachment`; `foreign Origin gets no CORS allow header on the new endpoints`.
- [ ] **Step 2: Run** `npm run e2e -- documentsApi`. Expected: FAIL.
- [ ] **Step 3: Implement** in the workflow, with sticky notes in the existing style.
- [ ] **Step 4: Run** `npm run e2e -- documentsApi documents`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: documents API reads and saves base document edits`

---

### Task 3: Effective facts everywhere (money: per-task review)

**Files:**
- Modify: `n8n/workflows/job-match-scoring.json`, `jobs-api.json`, `job-page-api.json`, `versions-api.json`, `generate-documents.json`; `n8n/prompts/write-documents.md`, `n8n/prompts/review-documents.md` (and their copies in "Writer and reviewer prompts")
- Test: `tests/e2e/scoring.e2e.test.ts`, `tests/e2e/generate.e2e.test.ts`, `tests/e2e/jobPageApi.e2e.test.ts`, `tests/e2e/versionsApi.e2e.test.ts`

**Interfaces:**
- Wherever `structured` of a base document is read as its facts → `coalesce(edited_facts, structured)`. Wherever `content_hash` is "the CV in use" or a version's base → `facts_hash`. That covers scoring "Find the current basis" and "Save score"; jobs-api and job-page-api `cur`; job-page-api `baseCv` (join on `b.facts_hash = v.base_cv_hash`, return effective facts); versions-api "Load edit inputs"; generate "Load inputs" `cv_hash` / `cl_hash`.
- generate "Load inputs" also returns `cv_content_hash` (the file's own hash) and `cv_edited boolean`. "Prepare inputs": when `cv_edited`, `cv_block = null` and the stored-file checks are skipped. Otherwise it is unchanged and compares the stored file with `cv_content_hash`. Writer and reviewer requests send `content` without a null block.
- Prompts, one sentence each in the `<base_cv_facts>` line: "His base CV file may be attached before these tags; when no file is attached, he has corrected these facts in the app and they alone are his base CV."

- [ ] **Step 1: Failing e2e tests:** `editing the CV re-scores every job once`; `generate after a CV edit sends no file and the edited facts` (stub `/_requests`: no `document` block; `<base_cv_facts>` holds the edited qualification); `generate without edits still sends the file`; `checks accept the edited qualification` (a version copying the edited qualification has no `unknown_fact` for it); `edit during a run does not mix facts`; `job page baseCv is the edited facts and isCurrentBase`; `saved edit uses the edited base facts for its checks`.
- [ ] **Step 2: Run** `npm run e2e -- scoring generate jobPageApi versionsApi`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command plus `npm test -w services/worker -- promptSchemas`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: scoring and generation use edited base facts`

---

### Task 4: Web: API client and My documents slots

**Files:**
- Modify: `apps/web/src/api/types.ts`, `apps/web/src/api/client.ts`, `apps/web/src/documents/DocumentSlot.tsx`, `apps/web/src/App.tsx`
- Test: `apps/web/src/api/client.test.ts`, `apps/web/src/documents/DocumentsPage.test.tsx`

**Interfaces:**
- Types: `BaseDocumentSummary` gains `edited: boolean; editedAt: string | null`. New `BaseCvFacts`, `BaseCoverLetterFacts` (mirroring the worker's), and `BaseDocumentFacts` as in Task 2.
- Client: `fetchBaseFacts(kind: DocumentKind): Promise<BaseDocumentFacts>`; `saveBaseFacts(kind, id: string, facts: BaseCvFacts | BaseCoverLetterFacts | null): Promise<BaseDocumentFacts>` (sends `X-JobHunter: 1`; `ApiError` carries `path` on `invalid_facts`, like the version save); `baseFileUrl(kind): string` = `/api/documents/file?kind=…`.
- Routes: `/documents/cv` and `/documents/cover-letter` → `BaseDocumentPage` (Task 5; a placeholder export until then).
- Slot: a ready slot shows **View and edit** (a link to its route) and, when `edited`, an "Edited in the app" label with the date. When `edited`, the Replace dialog reads "Replace {name}? Your edits in the app will be lost; the new file is read fresh."

- [ ] **Step 1: Failing tests:** `client fetchBaseFacts / saveBaseFacts send the right request and header`; `saveBaseFacts surfaces invalid_facts path`; `ready slot links to view and edit`; `edited slot shows the label`; `replace warns when edited`.
- [ ] **Step 2: Run** `npm test -w apps/web -- client DocumentsPage`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w apps/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): base document facts client and slot links`

---

### Task 5: Web: base document page (view and edit)

**Files:**
- Create: `apps/web/src/documents/BaseDocumentPage.tsx`, `BaseCvForm.tsx`, `BaseLetterForm.tsx`, `FactsView.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/documents/BaseDocumentPage.test.tsx`

**Interfaces:**
- `BaseDocumentPage({ kind })`: two columns. **Left:** the original: for a PDF, `<iframe title="Original file" src={baseFileUrl(kind)}>`; for Word, a **Download original** button. **Right:** `FactsView`, the facts read-only in CV order (name, headline, summary, work rights, contact, education, roles with bullets, projects, skills, metrics; letter: previous target, paragraphs, tone notes), with the warnings above it in amber with their labels (`documentWarningText`). Header: the file name, "Edited in the app · {date}" when edited, **Edit** (E), and **Undo all edits** when edited (confirm: "Undo all your edits? Your CV goes back to what was read from the file.").
- Edit mode swaps `FactsView` for `BaseCvForm` / `BaseLetterForm`: every field editable. Lists (education, roles, projects, bullets, skills, metrics, links, paragraphs) can add, remove and move up/down. **Save** / **Cancel**. Above Save, for a CV with `rescoreJobs > 0`: "Saving re-scores your {n} jobs (about US${(n × 0.016).toFixed(2)})."
- After save, the page shows the returned facts and warnings. `invalid_facts` highlights the field at `path`. `409` shows "Your {CV|cover letter} changed since you opened it. Reload to edit the new one." with a Reload button. Leaving with unsaved edits asks first, reusing the job page's leave guard and `ConfirmDialog`.

- [ ] **Step 1: Failing tests:** `shows the PDF original beside the facts`; `Word original offers download`; `E opens the editor, not while typing`; `edit a qualification and save sends the edited facts`; `shows the re-score cost for a CV`; `undo all edits confirms then saves null`; `409 shows reload message`; `invalid_facts marks the field`; `unsaved edits ask before leaving`; `add, remove and move a bullet`.
- [ ] **Step 2: Run** `npm test -w apps/web -- BaseDocumentPage`. Expected: FAIL.
- [ ] **Step 3: Implement**, using the frontend-design skill.
- [ ] **Step 4: Run** `npm test -w apps/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): view and edit base CV and cover letter`

---

### Task 6: Docs, full e2e, real run (controller, on Prayush's stack)

**Files:**
- Modify: `README.md` (My documents: view, edit, undo, what replacing does, cost row "Save a base document edit: free; a CV edit re-scores jobs"), `GLOSSARY.md` (**Base CV**: "as uploaded, with any corrections he made in the app"; new **Base edit**: "a correction Prayush makes to the facts read from his base CV or cover letter; it replaces those facts everywhere until he undoes it"), spec §6.3 / §7.3 / §8 "Changed 2026-11-13" notes, this plan's "As built".

- [ ] **Step 1:** `npm test` and the full `npm run e2e`. Expected: all PASS.
- [ ] **Step 2:** Rebuild Prayush's stack (`docker compose up -d --build`, `bash scripts/n8n-bootstrap.sh`). Open My documents → CV → check the PDF and facts show.
- [ ] **Step 3:** Edit the qualification to "Master of Information Technology (Extension)", save, and confirm the jobs re-score.
- [ ] **Step 4:** On the job from 2026-11-13, click Generate again and confirm the new version's education line has no sub-major and the version passes. Record the cost.
- [ ] **Step 5: Commit** `docs: base document editing`

### Amendment (Prayush, 2026-11-13, after the Task 2 review)

- **Version check on save:** `BaseDocumentFacts` gains `contentHash` (the file's `content_hash`). The save body becomes `{ kind, id, contentHash, facts }`, and the save lands only while the row still has that `content_hash` (both the load and the update `where` clauses). A file replaced under the same name answers `409 document_changed`. A missing or malformed `contentHash` is `400 bad_request`. Web: `saveBaseFacts(kind, id, contentHash, facts)`.
- **Cleaned vs cleaned:** "unchanged save stores no edit" compares the normalised edited facts with Claude's `structured` normalised by the same rules (trim, blank nullable → null, blank list entries dropped), using a lenient normaliser that applies no size limits. The worker's `/documents/facts/check` takes an optional `base` and answers `sameAsBase: boolean`. **Undo** (`facts: null`) never runs the strict validator: it clears the edit and recomputes the warnings from `structured` through `/documents/checks`.
- *(Claude's call, follows the Decision "replacing the file drops the edits")* "Retire replaced documents" also clears `edited_facts` / `edited_at`, so an earlier file uploaded again later never brings old edits back.

### As built (added 2026-11-14)

- **Inline PDF via a blob URL** (final review, Prayush's choice): n8n 2.46.6 adds `Content-Security-Policy: sandbox …` to every webhook response, and Chrome's PDF viewer will not render under it. The page fetches the file through `fetchBaseFile(kind)` and shows it from `URL.createObjectURL` (revoked on unmount, kind change and reload), with "Couldn't load the original file." and an "Open the original" link as the fallback. (506a53c)
- **Undo shows its cost:** undoing a CV edit re-scores every job like a save, so the confirm adds "This re-scores your {n} jobs (about US$…)". (506a53c)
- **Wording and invalid fields:** once edited, the facts panel reads "Your facts (edited in the app)" and empty values read "None". An `invalid_facts` path marks its field or list with a visible "Not valid" and names it in the alert. A path with odd characters answers `400 invalid_facts` with `path: "facts"`. (506a53c, 0b51e61)
- **Refactors:** the job page's leave guard moved unchanged to `apps/web/src/useLeaveGuard.ts`. The list-editing helpers shared by the job page editor and the base document forms live in `apps/web/src/forms/listEditing.tsx`. (fb7c7c7, bc93a5a)
- **Edits are cleared** both by the sync upsert (on a content change) and by "Retire replaced documents", so an earlier file uploaded again never brings old edits back. (f7a033e)
- **Known, accepted:** versions made before a CV edit show "made from an earlier base CV" on their Diff tab until the edit is undone. An edited or restored version keeps its source version's `base_cv_hash`.
- **Real run (Task 6, 2026-11-14):** the PDF showed beside the facts in Chrome. The qualification was edited to "Master of Information Technology (Extension)" and saved free. The 3 jobs re-scored for US$0.051 (72→68, 42→40, 35→40). Generate again on "Salesforce Developer / Software Engineer" passed in 1 round for US$0.286 and its version 5 education line has no sub-major. Total real-run spend: US$0.337. Tests on the final code: worker 172, web 197, full e2e 369 (dd521e4), plus documentsApi 35 after the final fix.
