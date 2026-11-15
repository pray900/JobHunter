# Plan 5: Australian Government template — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second template, `au-government` (up to 2 pages, competency statements, Responsibilities + Key Achievements per role, selection-criteria coverage, Referees line, "Page N of M" footer). The app suggests the template when it reads the job, and the user can override it on the job page.

**Architecture:**
- Job extraction also returns a suggested template and a one-sentence reason, stored on the job. The user's choice, also stored on the job, wins over the suggestion.
- Generate resolves the template before writing and tells the writer in a `<template>` tag. A Regenerate keeps the version's template.
- The worker gains a second docx template, per-template page limits for fit and checks, checks over the new CV fields, and a coverage-path check.
- The web job page gets a template choice, a "Selection criteria" list in the reasons panel, and government preview and editor fields.

**Tech Stack:**
- Node 24 / Fastify worker (TypeScript, `docx`, Gotenberg);
- n8n 2.46.6 workflow JSON;
- Postgres 17 migrations;
- React 19 web;
- Vitest;
- the e2e stack with the Anthropic stub.

**Spec:** `docs/superpowers/specs/2026-11-15-government-template-design.md` (read its "Settled after the builder check" section: it overrides the earlier sections where they differ).

**Branch:** `plan-5-government-template`, from `main` (Plans 10 and 9 are merged).

## Global Constraints

- **Template ids** are exactly `standard-ats` and `au-government`. Display names: `Standard ATS` and `Australian Government`.
- **Page limits:** `standard-ats` 1, `au-government` 2. The letter limit stays 2 for both. The fit ladder, floor (9.5 pt, 720 twips) and project-drop rules are unchanged; only the page target varies.
- **Government CV headings,** printed exactly and in this order:
  - `PROFESSIONAL SUMMARY` (only when the summary is not empty);
  - `KEY SKILLS & COMPETENCIES`;
  - `PROFESSIONAL EXPERIENCE`;
  - `PROJECTS` (only when there are projects);
  - `QUALIFICATIONS`;
  - `REFEREES`.
- **Role labels:** `Responsibilities` and `Key Achievements`. The fixed referee text is `Referees available on request`. The footer is `Page N of M`, using Word PAGE/NUMPAGES fields, on the CV only.
- **Look A:**
  - name and section headings in navy text, with a thin rule under each heading;
  - one column, no tables, text boxes, icons or filled bars;
  - Arial, like Standard ATS.
- **New data fields:**
  - `cv.competencies: { capability: string; evidence: string }[]`;
  - `cv.experience[].achievements: string[]`;
  - top-level writer output `criteriaCoverage: { criterion: string; answeredIn: string; why: string }[]`, where `""` means not applicable.
  - They are empty for `standard-ats`, and the writer schema has no nullable types.
  - In stored CVs, `competencies` and `achievements` are optional: absent in old versions, and kept absent when absent.
- **Standard ATS must not change.** A `standard-ats` CV renders, checks and fits exactly as on `main` today.
- **Fit never removes** responsibilities, achievements or competencies. Only projects are dropped, as today.
- **Honesty rules:**
  - never claim citizenship, a security clearance, a police check or a framework capability level unless the base CV states it;
  - Plan 7's realistic result figures are allowed in Key Achievements and competency `evidence`, as in bullets, and each one is listed as a stretch.
- **Wording sent to Claude:** prompts, guidance and every string sent to Claude say "the candidate" / they / their / them, never the user's name or he / his / him (enforced by the e2e name test).
- **Prompt and schema copies** in the `Writer and reviewer prompts` node, and the extraction prompt in `job-intake-sync.json`, must equal the repo files (existing e2e tests).
- **Safety:** parameterised SQL; a cost row for every Claude call; the API key is never printed, logged or put on a command line; no personal data committed.

## Review Focus

1. **A Standard ATS version from before this plan.** It has no `competencies` or `achievements` keys. It must render, download, edit and regenerate exactly as before, and validation must not add empty keys to it. (Task 2 test, Task 3 test.)
2. **A Regenerate after the user changed the job's template choice.** It keeps the version's template, and the new choice applies only to the next plain Generate. (Task 5 e2e test.)
3. **An edit that deletes the bullet or achievement a criterion points at.** The edit saves without a coverage failure, and the reasons panel shows `Not answered (removed by your edit)`. (Task 4 edit-check test, Task 6 web test.)
4. **A criterion answered in a project.** Fit may drop projects, so `answeredIn` may never point into `cv.projects`, and the coverage check fails it. (Task 2 test.)
5. **Extraction returns a template value outside the two ids,** or none (the old stub or an older model answer). The job is still extracted, and its suggestion is stored as null. (Task 4 e2e test.)

---

### Task 1: Probe the grown writer schema on the real API (controller runs this; spends money)

**Files:**
- Modify: `n8n/prompts/write-documents.schema.json`
- Maybe create: `n8n/prompts/write-documents.au-government.schema.json` (fallback only)
- Scratch (not committed): `<scratchpad>/probe-schema.mjs`

**Interfaces:**
- Produces one of two outcomes. Record which in the ledger and in "As built".
  - **Shared:** `write-documents.schema.json` has `templateId` enum `["standard-ats","au-government"]`, `cv.competencies`, `cv.experience[].achievements` and top-level `criteriaCoverage` (all required, arrays of the shapes in Global Constraints). There is no second file.
  - **Per-template:** `write-documents.schema.json` stays as on `main`. `write-documents.au-government.schema.json` is the grown schema with `templateId` enum `["au-government"]`. If that alone is still rejected, cut in this order and re-probe after each cut:
    1. drop `criteriaCoverage[].why`;
    2. replace `competencies` items with plain strings ("Capability: proof").

    Record which cuts were needed. Later tasks then treat the missing field as absent.

- [ ] **Step 1:** Write the grown schema as the shared version of `write-documents.schema.json` (same style as the file: `additionalProperties: false`, every property required, no `null` types).
- [ ] **Step 2:** Write the probe script in the scratchpad.
  - It reads `ANTHROPIC_API_KEY` from the repo `.env` with `fs`; it never prints the key or puts it in argv.
  - It POSTs to `https://api.anthropic.com/v1/messages` with:
    - model `claude-opus-5-5`, headers `anthropic-version: 2026-10-21` and `anthropic-beta: server-side-fallback-2026-07-01`, `fallbacks: 'default'`;
    - `max_tokens: 3000`;
    - `output_config: { effort: 'low', format: { type: 'json_schema', schema } }`;
    - system `"Return one small example object that matches the schema. Use short invented text."`, user `"Example please."`.
  - It prints only the HTTP status, `stop_reason`, `usage`, and `error.message` when there is one.
- [ ] **Step 3:** Run it once for the shared schema. Expected: `200` with `end_turn` (accepted; it costs a few cents), or `400` "compiled grammar is too large" (rejected; free).
- [ ] **Step 4:** If it was rejected, restore `write-documents.schema.json` from `main` and write the per-template file. Probe the per-template file, applying the cuts above one at a time until it is accepted. Also probe the unchanged Standard ATS schema once, to confirm it still passes.
- [ ] **Step 5:** In the shared outcome, paste the new schema into the `writer_schema` field of the `Writer and reviewer prompts` node in `n8n/workflows/generate-documents.json`, so the copy test stays green. In the per-template outcome, the node waits for Task 5. Then run `npm test -w services/worker` (the schema guard test: no nullable types). Expected: PASS.
- [ ] **Step 6:** Commit `feat(schema): writer schema for the government template (probed on the real API)`. Write the outcome to the ledger: `Ruling: schema outcome = shared|per-template(+cuts)`.

### Task 2: Worker data model, checks and page limits

**Files:**
- Modify:
  - `services/worker/src/generation/types.ts`
  - `services/worker/src/generation/validate.ts`
  - `services/worker/src/generation/textOf.ts`
  - `services/worker/src/generation/checks.ts`
  - `services/worker/src/generation/routes.ts`
  - `services/worker/src/render/fit.ts`
- Test:
  - `services/worker/test/generationChecks.test.ts`
  - `services/worker/test/fit.test.ts`
  - `services/worker/test/validate.test.ts` (or the file that tests `validateTailoredCv` today)
  - `services/worker/test/checkRoute.test.ts`

**Interfaces:**
- Consumes the Task 1 outcome (only for whether `criteriaCoverage[].why` and object competencies exist).
- Produces:
  - `TemplateId = 'standard-ats' | 'au-government'`; `TEMPLATE_IDS` lists both; `export const PAGE_LIMITS: Record<TemplateId, number> = { 'standard-ats': 1, 'au-government': 2 }`.
  - `TailoredCv` gains `competencies?: { capability: string; evidence: string }[]`, and each experience item gains `achievements?: string[]`.
  - `export interface CriterionCoverage { criterion: string; answeredIn: string; why: string }`.
  - `CheckInput.criteriaCoverage?: CriterionCoverage[]` (absent means skip the coverage check).
  - `validateTailoredCv`:
    - validates `competencies` items (`capability` and `evidence` non-empty) at paths `cv.competencies[i].capability` / `.evidence`, and `achievements` items (non-empty) at `cv.experience[i].achievements[j]`;
    - **includes a key in its result only if it was present in the input.**
  - `fitLayout(cv, measure, maxPages = 1)` and `fitCv(cv, manualEdits, measure, maxPages = 1)`: every `pages <= 1` becomes `pages <= maxPages`.
  - New `CheckCode` `'criteria_coverage'` (hard, doc `cv`; `where` is `criteriaCoverage[i]`).
  - Segments:
    - `cvSegments` adds `cv.competencies[i].capability` and `cv.competencies[i].evidence` (kind `body`) after the skills, and `cv.experience[i].achievements[j]` after that role's bullets;
    - `BULLET_WHERE` (the new-figure allowance) also matches `cv.experience[i].achievements[j]` and `cv.competencies[i].evidence`;
    - `longParagraphChecks` adds `cv.competencies[i]` (text `"<capability>: <evidence>"`) and every achievement.

- [ ] **Step 1: Write failing tests:**
  - `validateTailoredCv` on a CV with no `competencies` and no `achievements` returns an object with neither key (`'competencies' in out === false`, `'achievements' in out.experience[0] === false`). With them present, they are kept, and an empty `capability` throws `InvalidDocumentError` with path `cv.competencies[0].capability`.
  - `fitLayout` with a fake measure that gives 2 pages at every step: with `maxPages` 2 → step 0; with the default → floor step. `fitCv(..., 2)` drops nothing when 2 pages fit.
  - `runChecks` with `templateId: 'au-government'` and a fake render of 2 pages → no `cv_pages`; 3 pages → `cv_pages` with detail ending `the limit is 2.`. A `standard-ats` CV with 2 pages still fails, with `the limit is 1.`.
  - Coverage check, which applies only when `criteriaCoverage` is given:
    - `answeredIn` `coverLetter`, `cv.summary`, `cv.competencies[0].evidence` and `cv.experience[0].achievements[0]` (all present and non-empty) pass;
    - `cv.experience[0].achievements[5]` (missing) fails;
    - `cv.projects[0].bullets[0]` fails, with detail `Answer selection criteria in the summary, competencies, experience or the cover letter, not in a project.`;
    - `answeredIn ""` with a non-empty `why` passes;
    - `answeredIn ""` with an empty `why` fails.
  - A new figure (`"cut processing time by 30%"`) in an achievement or a competency `evidence` raises no `unknown_fact`. The same figure in `cv.summary` still does.
  - `long_paragraph` flags a 41-word achievement at `cv.experience[0].achievements[0]`.
  - A `keyword_not_found` keyword that appears only in an achievement is found (covered via `cvSegments`).
  - Check route: `templateId: 'au-government'` is accepted, and `criteriaCoverage` with a bad shape gives `400` `{ path: 'criteriaCoverage' }`.
- [ ] **Step 2:** Run `npm test -w services/worker`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
  - `runChecks` passes `PAGE_LIMITS[templateId]` to the fit and to the `cv_pages` test and detail (`; the limit is ${limit}.`).
  - The render route passes `PAGE_LIMITS[templateId]` to `fitLayout`.
  - Add the `HEADINGS['au-government']` entry from Global Constraints. `render_text` also requires `Referees available on request` in the government CV text.
  - Accepted `answeredIn` paths: `coverLetter`; `cv.summary`; `cv.competencies[i].capability|evidence`; `cv.experience[i].bullets[j]`; `cv.experience[i].achievements[j]`. The path must exist in the **fitted** CV and be non-empty.
  - Use one helper to read a value at a path (there is one in the workflow; the worker needs its own small one in `checks.ts`).
- [ ] **Step 4:** Run `npm test -w services/worker`. Expected: all PASS, including every existing Standard ATS test, unchanged.
- [ ] **Step 5:** Commit `feat(worker): government template data, per-template page limit, criteria coverage check`.

### Task 3: The `au-government` docx template

**Files:**
- Create: `services/worker/src/templates/auGovernment.ts`
- Modify: `services/worker/src/templates/index.ts`, `services/worker/src/templates/standardAts.ts` (export the letter renderer and shared helpers only; no behaviour change)
- Test: `services/worker/test/auGovernment.test.ts` (new), `services/worker/test/standardAts.test.ts`

**Interfaces:**
- Consumes `TailoredCv` with the optional fields, `CvLayout`, `LAYOUT_STEPS` and `shortLink` (Task 2, Plan 10).
- Produces `renderAuGovernment(kind: DocKind, cv: TailoredCv, letter?: TailoredLetter, layout?: CvLayout): Promise<Buffer>`. `renderDocx` switches on `'au-government'`.
- The government **letter** is the Standard ATS letter, rendered by the same function (Claude's call: the spec says it keeps the same layout).

- [ ] **Step 1: Write failing tests,** reading `word/document.xml` and `word/footer*.xml` the way `standardAts.test.ts` does:
  - The headings appear in the Global Constraints order, as upper-case text. `PROFESSIONAL SUMMARY` is absent when the summary is `''`, and `PROJECTS` is absent with no projects.
  - The name run and the heading runs carry a navy colour (one constant, `1F3864`, unless the builder picks another navy and records it), and headings have a bottom border.
  - Under `KEY SKILLS & COMPETENCIES`:
    - each competency is one paragraph with the capability in bold, then `: `, then the evidence;
    - then each skill group line, as in Standard ATS.
  - For a role with bullets and achievements, the order is: title line, `Responsibilities` label, the bullets, `Key Achievements` label, the achievements. A role with no achievements has no `Key Achievements` label. An old CV with no `achievements` key renders without error.
  - The last paragraph text is `Referees available on request`.
  - The footer XML contains `PAGE` and `NUMPAGES` field codes and the text `Page`/`of`. The letter has no footer.
  - The contact line equals Standard ATS's compact line for the same CV.
  - `LAYOUT_STEPS[5]` gives body size 19 and margins 720, like Standard ATS.
  - **Standard ATS unchanged:** a fixed CV rendered with `renderStandardAts` before and after this task gives identical `document.xml` (store the expected XML hash, or compare to a render through the old export path).
- [ ] **Step 2:** Run `npm test -w services/worker -- auGovernment standardAts`. Expected: FAIL.
- [ ] **Step 3:** Implement `auGovernment.ts` with the same building blocks as `standardAts.ts` (A4, Word bullet numbering, right tab for dates, layout scaling of name, heading and spacing by `bodyPt / 10.5`). The footer is `new Footer({ children: [Paragraph('Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES)] })`, small (8 pt) and grey.
- [ ] **Step 4:** Run `npm test -w services/worker`. Expected: all PASS.
- [ ] **Step 5:** One manual render through Gotenberg. Run `docker compose up -d --build worker gotenberg`, POST a long fixture CV to `/generation/render` (`templateId: 'au-government'`, `format: 'pdf'`), and confirm with `pdftotext` that it is 2 pages with the footer `Page 1 of 2`.
- [ ] **Step 6:** Commit `feat(template): Australian Government CV template`.

### Task 4: Store the suggestion and the choice; extraction; job page API; edit check

**Files:**
- Create: `db/migrations/007_job_template.sql`
- Modify:
  - `n8n/prompts/extract-job.md`
  - `n8n/workflows/job-intake-sync.json` (nodes `Extraction prompt and schema`, `Read Claude's answer`, `Save extracted details`)
  - `n8n/workflows/job-page-api.json` (`Read job page`; a new `POST api/jobs/template` route like `POST api/jobs/notes`)
  - `n8n/workflows/versions-api.json` (`Build edit check request`: unchanged body, confirm no `criteriaCoverage`)
  - `tests/stubs/anthropic-stub/server.mjs` (canned `extract_job` gains the two fields)
- Test: `tests/e2e/intake.e2e.test.ts`, `tests/e2e/jobPageApi.e2e.test.ts`, `tests/e2e/versionsApi.e2e.test.ts`

**Interfaces:**
- **Migration:** `jobs` gains three columns:
  - `suggested_template text check (suggested_template in ('standard-ats','au-government'))`;
  - `template_reason text`;
  - `template_choice text check (template_choice in ('standard-ats','au-government'))`.
  - All are nullable.
- **Extraction output** gains `suggested_template` (enum of the two ids) and `template_reason` (string). The rule to add to `extract-job.md`:
  - `au-government` when the hiring organisation is an Australian federal, state, territory or local government body or statutory body, including when a recruiter advertises for one;
  - otherwise `standard-ats`;
  - the reason is one neutral sentence that names no person.
- **`Read Claude's answer`:** a missing or unknown `suggested_template` stores null, with a null reason, and does not fail the extraction.
- **Job detail** `job` gains `suggestedTemplate`, `templateReason` and `templateChoice` (each `string | null`).
- **`POST api/jobs/template?id=<job>`:**
  - requires the `X-JobHunter: 1` header;
  - body `{ templateId: 'standard-ats' | 'au-government' | null }` (null clears the choice);
  - answers `200 { templateChoice }`, `400 { error: 'bad_request' }` for anything else, or `404 { error: 'job_not_found' }`.

- [ ] **Step 1: Write failing e2e tests:**
  - Intake: the stub's canned extraction stores `suggested_template` and `template_reason`. A scripted answer with `suggested_template: 'fancy'` stores null and the job's `extraction_status` is still `done`. The prompt-copy test (existing) passes against the new `extract-job.md`.
  - Job page:
    - detail returns the three fields (null for a job extracted before the migration);
    - POST template sets `au-government`, then null clears it;
    - a missing header gives the existing missing-header answer; a bad body gives 400; another owner's or an unknown job gives 404.
  - Versions: an edit check request body has no `criteriaCoverage` key.
- [ ] **Step 2:** Run `E2E_KEEP_STACK=1 npm run e2e -- intake jobPageApi versionsApi`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. Copy the new `extract-job.md` text into the workflow node exactly. Write the SQL like `Save notes`: parameterised, owner-scoped, UUID-checked in SQL, and no dollar-digit in comments.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat: suggest a template at extraction; store the user's template choice`.

### Task 5: Writer, reviewer and Generate workflow

**Files:**
- Modify:
  - `n8n/prompts/write-documents.md`, `n8n/prompts/review-documents.md`, `n8n/prompts/review-documents.schema.json`
  - `skills/cv-writing/SKILL.md`
  - `n8n/workflows/generate-documents.json`: nodes `Writer and reviewer prompts`, `Load inputs`, `Prepare inputs`, `Build writer request`, `Read the writer's answer`, `Build check request`, `Read check results` (only if coverage results need passing on), `Build review request`, `Read the reviewer's answer`, `Choose the version to save`, `Save version`
  - `tests/stubs/anthropic-stub/server.mjs` (canned `write_documents` and `review_documents`)
- Test: `tests/e2e/generate.e2e.test.ts`

**Interfaces:**
- Consumes the Task 1 schema outcome, the Task 2 check body (`criteriaCoverage`) and `PAGE_LIMITS`, and the Task 4 job columns.
- **Resolving the template:**
  - `Load inputs` selects `coalesce(j.template_choice, j.suggested_template, 'standard-ats') as template_id` and `j.template_reason`, plus `template_id` inside `from_version`.
  - `Prepare inputs` sets `inputs.template_id`: the from-version's `template_id` on a regenerate, otherwise the job's. It sets `inputs.template_reason` to the job's reason when the suggestion is used, or `"You chose this template on the job page."` when the user's choice is used.
- **Writer request:**
  - It adds `tagged('template', inputs.template_id)` right after `<job_facts>`.
  - Schema: `inputs.template_id === 'au-government' && prompts.writer_schema_au_government ? prompts.writer_schema_au_government : prompts.writer_schema`. The second field exists only in the per-template outcome, and the node's field then equals the new schema file.
- **`Read the writer's answer`:**
  - `answer.templateId === inputs.template_id` is required, otherwise the existing "not in the expected format" path;
  - `criteriaCoverage` must be a list of `{criterion, answeredIn, why}` strings; with `why` cut (Task 1), its absence is accepted;
  - under `au-government` only, competencies and achievements arrays are required.
- **Check request** adds `criteriaCoverage: w.criteriaCoverage ?? []`.
- **Version save:**
  - `template_id` = `inputs.template_id`;
  - `reasons.templateReason` = the writer's `templateReason`;
  - `reasons.criteriaCoverage` = the coverage list from the saved round, saved only when the template is `au-government`.
- **Reviewer:**
  - it gets `tagged('template', …)`;
  - the review schema's item enum gains `selection_criteria`. "Judge each of these 14 items" becomes 15;
  - for `standard-ats`, or an ad with no explicit criteria, the reviewer passes it with the note "Not applicable".
  - Its rule: every criterion, capability or targeted question the ad names is in `criteriaCoverage`, each answered one really answers it in STAR form with the candidate's own action, and the capability names match the ad.
  - Item 10 `tidiness` uses "one page (Standard ATS) or up to two pages (Australian Government)".
- **Writer prompt:**
  - Replace the line `templateId is "standard-ats" (the only template)` with: the template is given in `<template>`; echo it as `templateId`; give a one-sentence `templateReason`.
  - Add a section `## The Australian Government template`, applied only when `<template>` is `au-government`, carrying the spec's section table, counts, STAR rule, honesty rules, coverage rules (no projects as `answeredIn`; no invented criteria; empty when the ad has none) and letter length (the ad's limit, or about 300 words).
  - Under `standard-ats`, `competencies`, every `achievements` and `criteriaCoverage` are empty lists.
  - The page-limit paragraph says one page for Standard ATS and up to 2 for Australian Government.
- **SKILL.md:** a short "Government applications" craft section (STAR with "I" actions, capability names as the ad words them, Responsibilities short, Achievements as action, then result). Invented examples only. Re-copy it into `writer_guidance`.

- [ ] **Step 1: Write failing e2e tests** in `generate.e2e.test.ts`:
  - **The template reaches the writer:**
    - a job with `suggested_template 'au-government'` → the writer request text contains `<template>\nau-government\n</template>`;
    - with `template_choice 'standard-ats'` on the same job → `standard-ats`;
    - with neither → `standard-ats`.
  - **Regenerate keeps the version's template:** a version saved with `au-government`, then the job's choice set to `standard-ats`, then Regenerate → `<template>` is `au-government`, and the new version's `template_id` is `au-government`.
  - **Writer answer validation:** a `templateId` that differs from the given template → run fails with "The writer's answer was not in the expected format.". A government answer without `criteriaCoverage` → the same.
  - **Government version saved:** a scripted government answer with coverage → the check request body has `criteriaCoverage`; the saved version has `template_id 'au-government'` and `reasons.criteriaCoverage` equal to the list; `cv_pages` is not raised for a 2-page fake.
  - **Standard ATS unchanged:** the canned Standard ATS answer saves a version whose `reasons` has no `criteriaCoverage` key, and whose CV has no `competencies` key and no `achievements` keys.
  - **Prompt copies:** the existing prompt and schema copy tests pass (including `writer_schema_au_government` against its file when that file exists). The existing "nothing sent to Claude names the user" test passes.
  - **Reviewer:** the request contains `<template>`. A scripted review missing `selection_criteria` is handled exactly as a review missing any other item is handled today.
- [ ] **Step 2:** Run `E2E_KEEP_STACK=1 npm run e2e -- generate`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. Update the canned stub answers so every existing test still passes:
  - the Standard ATS writer answer gains empty `competencies`, `achievements: []` per role and `criteriaCoverage: []`;
  - the canned review gains a passing `selection_criteria` item.
  - `Read the writer's answer` strips empty `competencies` and `achievements` from a `standard-ats` answer before checks and save, so Standard ATS versions keep today's stored shape (Review Focus 1).
- [ ] **Step 4:** Run `E2E_KEEP_STACK=1 npm run e2e -- generate`. Expected: PASS. Then run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(generate): template given to the writer; government writing and review rules`.

### Task 6: Web — template choice, selection criteria, government preview and editor

**Files:**
- Modify:
  - `apps/web/src/api/types.ts`, `apps/web/src/api/parseJobDetail.ts`, `apps/web/src/api/client.ts`
  - `apps/web/src/job/JobPage.tsx`, `apps/web/src/job/ReasonsPanel.tsx`, `apps/web/src/job/DocumentPreview.tsx`, `apps/web/src/job/DocumentEditor.tsx`, `apps/web/src/job/labels.ts`
- Test:
  - `apps/web/src/api/client.test.ts`
  - `apps/web/src/job/JobPage.test.tsx`
  - `apps/web/src/job/DocumentEditor.test.tsx`
  - `apps/web/src/job/labels.test.ts`
  - a new `apps/web/src/job/ReasonsPanel.test.tsx`
  - `apps/web/src/job/detailFixtures.ts`

**Interfaces:**
- Consumes the Task 4 detail fields and route, and the Task 5 `reasons.criteriaCoverage`.
- **Types:**
  - `JobDetailJob` gains `suggestedTemplate`, `templateReason` and `templateChoice` (`string | null`; parse missing as null);
  - `TailoredCv` gains the optional fields;
  - `VersionReasons.criteriaCoverage?: { criterion: string; answeredIn: string; why: string }[]`;
  - `CheckCode` gains `'criteria_coverage'`, and so does `CHECK_CODES`;
  - `ReviewItemId` gains `'selection_criteria'`.
- **Client:** `setTemplate(jobId: string, templateId: 'standard-ats' | 'au-government' | null): Promise<{ templateChoice: string | null }>`, sending the `X-JobHunter` header like `saveNotes`.
- **Labels:**
  - `criteria_coverage` → `Selection criteria answer not found`;
  - `selection_criteria` → `Selection criteria`;
  - `TEMPLATE_NAMES` gains `'au-government': 'Australian Government'`.

- [ ] **Step 1: Write failing tests:**
  - **Job page template choice:**
    - a select labelled `Template` with both names;
    - when there is a suggestion and no choice, the text `Suggested: Australian Government — <reason>` is shown and the select shows the suggestion;
    - changing the select calls `setTemplate` with the id;
    - a `Use suggestion` button (shown only when a choice differs from the suggestion) calls it with `null`;
    - the note `Applies to the next Generate. Regenerate keeps the current version's template.` is shown;
    - with no suggestion and no choice, the select shows Standard ATS.
  - **Reasons panel:**
    - with `criteriaCoverage` it shows a `Selection criteria` heading, then each criterion with where it is answered (e.g. `Key Achievements — role 1` for `cv.experience[0].achievements[0]`; `Cover letter` for `coverLetter`);
    - an entry with `answeredIn ""` shows an amber warning icon, the words `Not answered` and its `why`;
    - an entry whose path is missing or empty in the version's CV shows `Not answered (removed by your edit)` with the same warning style;
    - no section when the list is absent or empty.
  - **Preview:** for an `au-government` version, the government headings, the `Responsibilities` / `Key Achievements` labels, the competency lines and `Referees available on request`. A Standard ATS preview is unchanged (existing tests).
  - **Editor:** for a CV with competencies and achievements, fields to edit each capability, evidence and achievement, with add and remove, as bullets have. The saved CV keeps absent keys absent for a Standard ATS CV.
  - **Parse:** a detail with an unknown template id still parses (template ids are strings).
- [ ] **Step 2:** Run `npm test -w apps/web`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement with the existing components and styles. Status styling follows CLAUDE.md: amber is "needs attention", and colour is always paired with an icon and words. Use the frontend-design skill for the template control's placement (beside the Generate button).
- [ ] **Step 4:** Run `npm test -w apps/web`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): template choice, selection criteria, government preview and editor`.

### Task 7: Full verification, real run, docs

**Files:**
- Modify: `docs/superpowers/plans/2026-11-15-plan-5-government-template.md` ("As built"), `GLOSSARY.md` (Template, Selection criteria coverage), `README.md` (one line on the template choice)

- [ ] **Step 1:** Run `npm test` and `npm run e2e` (full, once). Expected: all PASS.
- [ ] **Step 2:** Rebuild: `docker compose up -d --build`, then `bash scripts/n8n-bootstrap.sh`.
- [ ] **Step 3: Real run on job2** (the Queensland Government role advertised by a recruiter, with Key Selection Criteria; find it with a SQL query on `raw_text ilike '%Queensland Government%'`).
  - POST `api/jobs/template` with `au-government`, then Generate. This costs about US$0.30–1.50.
  - Poll `generation_runs`. Download the CV PDF and check that:
    - the version passes review;
    - the CV is at most 2 pages, with `Page 1 of 2` (or `of 1`);
    - the headings are in order;
    - every Key Selection Criterion in the ad is in the coverage list and answered, or honestly "Not answered" with a reason;
    - there are no claims of citizenship, clearance or capability level unless the base CV states them;
    - the letter is about 300 words, or within the ad's limit.
- [ ] **Step 4:** Spot-check that one Standard ATS job still generates as before. Re-download an existing version and compare it with its earlier PDF text.
- [ ] **Step 5:** Write "As built": the schema outcome, the cost of the real run, its rounds, and any rulings. Commit `docs: plan 5 as built`.

## As built (2026-11-15)

**Writer schema (Task 1, real API probes).**
- The shared grown schema was rejected ("compiled grammar is too large"). So were the per-template government schema and both of the spec's cuts. Rejected probes are free.
- The Standard ATS schema is already at the limit: adding only `achievements` to it is rejected.
- What fits is a separate `write-documents.au-government.schema.json`:
  - `templateId` is `au-government` only;
  - it has **no `cv.name`, `cv.contact` or `cv.workRights`**. The Generate workflow fills them from the base CV facts before the checks, and on a regenerate from the version it starts from;
  - `cv.competencies` is `string[]` (each "Capability: proof"; the template and preview bold the part before the first ": ");
  - it has `experience[].achievements` and `criteriaCoverage {criterion, answeredIn, why}`.
- Object competencies and `why` each fit alone, but not together; `why` was kept.
- The Standard ATS schema is unchanged.

**Real run.**
- The job is the Queensland Government Salesforce Developer role via Redwolf + Rosch (job ebeb5db7, version 10).
- It passed review in 2 rounds, for US$0.9493.
- The CV is 2 pages, with footers "Page 1 of 2" and "Page 2 of 2" and the headings in order. Responsibilities and Key Achievements appear per role, and the last line is "Referees available on request".
- All 12 key criteria are in the coverage list: 4 are answered (all in competencies), and 8 are "Not answered", each with an honest reason ("3+ years, not 5+", no certifications, no Experience Cloud, Sydney not Brisbane, and so on).
- The CV makes no citizenship, clearance or police-check claims. The letter is 266 words.

**Tests.** Unit: worker 245, web 217. Full e2e: 418/418.

**Other changes beyond the plan.**
- A new run error, "The template changed while this was being written. Choose Generate again.", is shown when a retry finds rounds written for a different template. It is on the job page's list of allowed messages.
- The template choice is hidden on the job page while a run is in progress.
