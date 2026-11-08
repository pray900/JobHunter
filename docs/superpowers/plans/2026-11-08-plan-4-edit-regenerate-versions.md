# JobHunter Plan 4: Edit, Regenerate with instructions, Versions, Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the job page Prayush can edit the generated CV and cover letter, see every version and restore an old one, regenerate with his own instruction while Claude keeps his manual edits, and see exactly what changed against his base CV.

**Architecture:** Versions stay append-only: an edit, a restore and a regenerate each add a new `document_versions` row, so nothing is ever lost. Edits are saved through a new n8n **Versions API** workflow that re-runs the worker's code checks (no Claude call). Regenerate reuses the Plan 3 **Generate documents** workflow: the run carries the instruction and the version it starts from, and the writer gets that version, the list of manually edited fields and the instruction. The diff against the base CV is computed in the browser from data the detail API returns.

**Tech Stack:** as Plan 3. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-06-jobhunter-design.md` — implements §6.5 (regenerate with instructions), §6.6 (in-app editing), §7.2 (Diff vs base CV tab, editable preview, instruction box + Regenerate, version history). Prerequisite: Plan 3 merged (main 6ec9156).

## Global Constraints

- Everything in Plans 1–3's Global Constraints and Amendments still holds (personal data never committed, invented names in fixtures; owner id on every row; all UI→backend calls through `apps/web/src/api/client.ts`; n8n `api/` webhooks with Allowed Origins `http://localhost:8080,http://localhost:5173`; `X-JobHunter: 1` gate as the first node of every state-changing webhook; `saveDataSuccessExecution: "none"`; risky nodes `onError: continueRegularOutput` so failures answer cleanly; parameterised SQL; no dollar-digit in SQL comments; answers within 30 s; migrations 001–004 never edited).
- **Versions are append-only.** No endpoint updates or deletes a `document_versions` row. "Current version" = highest `version_no` for the job.
- **Paid calls only after a click**: editing, restoring, viewing and diffing never call Claude. Only Generate / Regenerate do, through the existing queue, cap and backoff.
- Regenerate instruction: trimmed, 1–1000 characters, no NUL; stored on the run and the version. Version label for a regenerate = the instruction, cut to 80 characters with "…".
- The instruction is Prayush's request, but it never overrides the honesty rules: the writer may not invent facts because an instruction asks, and the code checks and reviewer apply unchanged.
- Version origins: `generated` (first Generate or "Generate again" from nothing), `regenerated` (with an instruction), `edited`, `restored`. Labels: `Generated`, the instruction, `Edited`, `Restored version N`.
- An edited version keeps the source version's review, marked as not covering the edits (`review.reviewedVersionNo = N`); the reviewer is not re-run on edits (spec §6.6, builder's call).
- Keyboard shortcuts on the job page (CLAUDE.md): **E** edit, **A** mark applied, **S** skip (status closed), **G** generate/regenerate focus; never while typing in a field. *(Claude's call: CLAUDE.md's Approve/Skip mapped to the existing statuses Applied/Closed.)*
- UI follows CLAUDE.md UI rules (dark default, neutral greys, blue-green accent, status colours with labels, visible focus, no heavy animation). Australian English.

## Review Focus

1. **Edit saved while a generation is running** → both kept; whichever finishes later is the current version; nothing lost; the history shows both (Task 2 e2e `edit during a run keeps both`).
2. **Edit adds a fact not in the base CV** (e.g. "5 years Kubernetes") → saved, but the hard `unknown_fact` shows in amber on the page and in the version; download still works (Task 2 e2e `edit with an unknown fact is saved with a hard check`).
3. **Instruction asks for something dishonest** ("say I led a team of 10") → the writer gets the honesty rules above the instruction; the checks still fail an invented number; the version is not marked passed (Task 3 e2e `instruction cannot bypass the checks`).
4. **Two edits saved at once / edit + restore at once** → distinct version numbers, no 500 (Task 2 e2e `concurrent saves get distinct versions`).
5. **Base CV replaced after a version was made** → the diff tab says "Your base CV has changed since this version" and diffs against the version's own base CV if it still exists, else shows the notice only; regenerate uses the current base CV (Task 2 detail test `base cv replaced`, Task 5 test `diff notice when base changed`).

---

### Task 1: Schema and worker helpers

**Files:**
- Create: `db/migrations/005_versions.sql`, `services/worker/src/generation/changedPaths.ts`
- Modify: `services/worker/src/generation/routes.ts`
- Test: `services/worker/test/migrate.test.ts`, `services/worker/test/changedPaths.test.ts`, `services/worker/test/checkRoute.test.ts`

**Interfaces:**
- Migration 005: `document_versions` gains `origin text not null default 'generated' check in ('generated','regenerated','edited','restored')`, `parent_version_id uuid references document_versions on delete set null`; `generation_runs` gains `from_version_id uuid references document_versions on delete set null`. Existing rows: origin `generated`.
- `changedPaths(before: { cv: TailoredCv; coverLetter: TailoredLetter }, after: same): string[]` — dotted paths of every leaf that differs (`cv.summary`, `cv.experience[1].bullets[2]`, `coverLetter.paragraphs[0]`; added/removed array items appear as their index path), sorted.
- Route `POST /generation/changed-paths` `{ before, after }` → `{ paths: string[] }`; `400 invalid_document` (same validation as `/generation/check`).

- [ ] **Step 1: Failing tests** — `applies 005 after 004`; `origin defaults to generated`; `changedPaths finds an edited bullet, a removed bullet and an edited letter paragraph`; `changedPaths of identical documents is empty`; `route validates both documents`.
- [ ] **Step 2: Run** `npm test -w services/worker -- migrate changedPaths checkRoute` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w services/worker` — Expected: PASS.
- [ ] **Step 5: Commit** `feat: version origins and changed-path helper`

---

### Task 2: n8n "Versions API" + detail/download by version (security: per-task review)

**Files:**
- Create: `n8n/workflows/versions-api.json` (id `jh-versions-api`)
- Modify: `n8n/workflows/job-page-api.json` (detail and download accept optional `versionId`; detail adds `versions` summary count and `baseCv`), `tests/e2e/infra.e2e.test.ts` (shipped ids)
- Test: `tests/e2e/versionsApi.e2e.test.ts`, `tests/e2e/jobPageApi.e2e.test.ts`

**Interfaces:**
- `GET api/jobs/versions?id=` → `{ versions: { id, versionNo, label, origin, createdAt, instruction, passed: boolean|null, hardChecks: number, manualEdit: boolean }[] }` newest first.
- `POST api/jobs/versions/edit?id=` (gate) body `{ fromVersionId, cv, coverLetter }` (≤ 200 KB) → runs worker `/generation/check` with the same `CheckInput` the Generate workflow builds (job, base CV structured of the **current** active base CV, base cover letter, other jobs) and `/generation/changed-paths` against the source version; inserts `origin 'edited'`, `label 'Edited'`, `manual_edit true`, `parent_version_id = fromVersionId`, `checks` = new results, `review` = source review + `reviewedVersionNo`, `reasons` = source reasons + `manualEdits` (union of the source's `manualEdits` and the new paths), `keyword_coverage` copied, `run_id null` → `201 { versionId, versionNo, checks }`; `400 invalid_document {path}` / `bad_request`; `404 version_not_found` (not this job's); `413` over 200 KB. Version number allocated safely (retry on unique violation, as Plan 3).
- `POST api/jobs/versions/restore?id=` (gate) body `{ versionId }` → copies that version's documents, reasons, checks, review, keyword coverage into a new row `origin 'restored'`, `label 'Restored version N'`, `parent_version_id` → `201 { versionId, versionNo }`; `404`.
- `GET api/jobs/detail?id=&versionId=` → as Plan 3 but for that version (default: current), plus `version.origin`, `version.parentVersionId`, `version.manualEdits`, `version.isCurrent`, and `baseCv: { structured, sourceRef, isCurrentBase: boolean } | null` (the version's base CV row, `null` if deleted).
- `GET api/jobs/download?...&versionId=` → that version (default current).

- [ ] **Step 1: Failing e2e tests** — `versions list newest first with origin and label`; `edit saves a new version with checks and manual edits`; `edit with an unknown fact is saved with a hard check`; `edit during a run keeps both`; `concurrent saves get distinct versions`; `restore copies the old version as a new one`; `edit/restore need the header`; `edit of another job's version is 404`; `invalid document is 400 with the path`; `over 200 KB is 413`; `detail and download by versionId`; `base cv replaced` (detail `baseCv.isCurrentBase=false`); `no Claude request during edit or restore` (stub request count unchanged).
- [ ] **Step 2: Run** `npm run e2e -- versionsApi jobPageApi` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** full `npm run e2e` — Expected: PASS, exit 0.
- [ ] **Step 5: Commit** `feat(n8n): versions API with edit and restore`

---

### Task 3: Regenerate with an instruction (money: per-task review)

**Files:**
- Modify: `n8n/workflows/job-page-api.json` (generate accepts a JSON body `{ instruction?, fromVersionId? }`), `n8n/workflows/generate-documents.json`, `n8n/prompts/write-documents.md`, `n8n/prompts/review-documents.md`, `tests/stubs/anthropic-stub/server.mjs` (if needed)
- Test: `tests/e2e/generate.e2e.test.ts`, `tests/e2e/jobPageApi.e2e.test.ts`

**Interfaces:**
- `POST api/jobs/generate?id=` body optional `{ instruction: string, fromVersionId: uuid }`: both or neither. With them → run `instruction`, `from_version_id`; `400 bad_instruction` (empty after trim, > 1000, NUL), `404 version_not_found`. Without → as Plan 3.
- Writer request on a regenerate, round 1: adds `<current_version>` (the from-version's cv + coverLetter, with the Plan 3 empty-value mapping), `<manual_edits>` (its `reasons.manualEdits`, may be empty) and `<instruction>`. Writer prompt: apply the instruction; keep every manual edit and everything else in the current version unless the instruction asks to change it; the honesty rules and copy-exactly rules outrank the instruction — if the instruction asks for something the base CV can't support, don't do it and say so in `changes`. Rounds 2+ work as in Plan 3 (`<previous_round>`), still carrying `<instruction>` and `<manual_edits>`.
- Reviewer request on a regenerate adds `<instruction>` and `<manual_edits>`: requested changes and Prayush's edits are not objections in themselves, but every rule still applies to them.
- Save: `origin 'regenerated'`, `label` = instruction cut to 80 chars, `instruction`, `parent_version_id = from_version_id`; `reasons.manualEdits` carried over (paths still present).

- [ ] **Step 1: Failing e2e tests** — `regenerate passes instruction, current version and manual edits to the writer`; `reviewer gets the instruction but not the writer prompt`; `regenerate saves origin regenerated with the instruction as label`; `instruction cannot bypass the checks` (stub writer adds an invented number → hard `unknown_fact`, version not passed); `bad instruction 400`; `instruction without fromVersionId 400`; `prompt files match the workflow`.
- [ ] **Step 2: Run** `npm run e2e -- generate jobPageApi` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** full `npm run e2e` — Expected: PASS, exit 0.
- [ ] **Step 5: Commit** `feat(n8n): regenerate with instructions keeps manual edits`

---

### Task 4: Web — editing, version history, shortcuts

**Files:**
- Create: `apps/web/src/job/DocumentEditor.tsx` (form editor for CV + letter: text fields for headline/summary/contact/work rights, list editors for bullets, skills groups and letter paragraphs with add / remove / move up / move down; copied fields (titles, employers, dates, education) read-only with a note "Copied from your base CV"), `apps/web/src/job/VersionHistory.tsx`, `apps/web/src/job/useShortcuts.ts`
- Modify: `apps/web/src/job/JobPage.tsx`, `apps/web/src/api/client.ts`, `apps/web/src/api/types.ts`, `apps/web/src/job/labels.ts`, `apps/web/src/styles.css`
- Test: `apps/web/src/job/DocumentEditor.test.tsx`, `apps/web/src/job/VersionHistory.test.tsx`, `apps/web/src/job/useShortcuts.test.tsx`, `apps/web/src/job/JobPage.test.tsx`, `apps/web/src/api/client.test.ts`

**Interfaces:**
- Client: `fetchVersions(jobId)`, `fetchJobDetail(jobId, versionId?)`, `saveEdit(jobId, fromVersionId, cv, coverLetter)`, `restoreVersion(jobId, versionId)`, `downloadUrl(jobId, doc, format, versionId?)`.
- Page: **Edit** (E) switches the preview to the editor; **Save** creates the version and shows its checks ("Your edit broke 1 rule" in amber, listed); **Cancel** discards (confirm if changed). An edited version shows "Reviewer verdict is from version N, before your edits." History panel: label, origin icon + text, time, instruction, passed / not passed / not reviewed; selecting a version shows it read-only with **Restore this version** and its own downloads. Shortcuts per Global Constraints, with a "?" hint listing them.

- [ ] **Step 1: Failing tests** — `editor edits a bullet and saves a new version`; `copied fields are read-only`; `save shows broken rules in amber with labels`; `cancel with changes asks first`; `history lists versions with origin labels`; `restore asks then creates a version`; `viewing an old version shows its downloads`; `E opens the editor, A marks applied, S closes, not while typing`; `client validates versions response`.
- [ ] **Step 2: Run** `npm test -w apps/web` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w apps/web`, `npm run build -w apps/web` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): edit documents, version history and shortcuts`

---

### Task 5: Web — Regenerate box and Diff vs base CV

**Files:**
- Create: `apps/web/src/job/RegeneratePanel.tsx`, `apps/web/src/job/diffAgainstBase.ts`, `apps/web/src/job/BaseDiff.tsx`
- Modify: `apps/web/src/job/JobPage.tsx` (tabs **CV · Cover letter · Diff vs base CV**), `apps/web/src/api/client.ts` (`generate(jobId, { instruction, fromVersionId }?)`)
- Test: `apps/web/src/job/RegeneratePanel.test.tsx`, `apps/web/src/job/diffAgainstBase.test.ts`, `apps/web/src/job/BaseDiff.test.tsx`

**Interfaces:**
- Regenerate panel under the preview: instruction box (1–1000 chars, counter) + **Regenerate** (sends the shown version as `fromVersionId`); hint "Claude keeps your edits unless you ask otherwise"; while a run is active the box is disabled and progress shows as in Plan 3; 400/409 messages shown.
- `diffAgainstBase(base: BaseCvStructured, cv: TailoredCv): BaseDiff` where `BaseDiff = { headline: Change; summary: Change; roles: { employer: string; title: string; bullets: ({ kind: 'kept' | 'reworded' | 'added'; text: string; baseText?: string })[]; dropped: string[] }[]; rolesDropped: string[]; skills: { added: string[]; dropped: string[] }; projects: { kept: string[]; dropped: string[] } }`, `Change = { before: string | null; after: string }`. Roles matched by employer (case/space-insensitive); a bullet is `kept` if equal after whitespace normalisation, `reworded` if it shares ≥ 50 % of its words with an unused base bullet of that role (best match), else `added`; unmatched base bullets are `dropped`.
- `BaseDiff` view: reworded bullets show base text struck through above the new text with changed words highlighted; added bullets get an "Added" label (amber if the reasons list it as a stretch); dropped ones listed under "Left out"; notice "Your base CV has changed since this version" when `baseCv.isCurrentBase` is false; "Base CV no longer available" when `baseCv` is null.

- [ ] **Step 1: Failing tests** — `kept, reworded and added bullets`; `dropped bullets and roles are listed`; `skills added and dropped`; `us/au and case differences count as kept`; `regenerate sends instruction and the shown version`; `instruction over 1000 chars is blocked`; `regenerate disabled while running`; `diff notice when base changed`; `labels, not colour alone`.
- [ ] **Step 2: Run** `npm test -w apps/web` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w apps/web`, `npm run build -w apps/web`, full `npm run e2e` (web e2e included) — Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): regenerate with instructions and diff against base CV`

---

### Task 6: Real-run verification (controller, on Prayush's stack)

- [ ] **Step 1:** `docker compose up -d --build`, `bash scripts/n8n-bootstrap.sh`.
- [ ] **Step 2:** On the Salesforce Developer job: edit one bullet and save (no cost); check the checks and the history.
- [ ] **Step 3:** Regenerate from that edited version with one instruction (e.g. "Make the summary shorter") (≈ US$0.30–0.90); confirm the manual edit is kept, the instruction applied, version labelled with it, cost logged.
- [ ] **Step 4:** Restore the first version; download its PDF; check the Diff vs base CV tab reads correctly.
- [ ] **Step 5:** Record results and cost in the ledger; report anything that reads wrong to Prayush before merging.
