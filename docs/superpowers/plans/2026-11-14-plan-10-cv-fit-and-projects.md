# Plan 10: CV fit, compact header, all projects, neutral prompts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put every base-CV project on a one-page CV by compacting the header, shrinking the layout in code down to a floor, and dropping the least relevant projects only when that is not enough; and remove the user's name from everything sent to Claude.

**Architecture:** The `standard-ats` template takes a `CvLayout` (body size, margins, spacing scale). A new fit module tries a fixed ladder of layouts against the real PDF page count, then drops projects from the end of the list. `runChecks` fits first and checks the fitted CV; the check response carries the fitted CV and the dropped names, and the n8n workflow uses that CV from then on and stores the drop note in the version's reasons. Downloads re-run only the layout ladder (never drop).

**Tech Stack:** Node 24 / Fastify worker (TypeScript, `docx`, Gotenberg), n8n 2.46.6 workflow JSON, React 19 web, Vitest, e2e test stack with the Anthropic stub.

**Spec:** `docs/superpowers/specs/2026-11-14-cv-fit-and-projects-design.md`

**Branch:** `plan-10-cv-fit-and-projects`, from `main` after Plan 8 is merged.

## Global Constraints

- Floor: body text never below **9.5 pt**; margins never below **720 twips (1.27 cm)**. Start: **10.5 pt**, **1020 twips**, today's spacing.
- A CV that fits at the start layout renders exactly as before apart from the header (Task 1).
- Header: at most 3 logical lines (name; headline; contact + work rights joined by ` | `), at most 4 printed lines.
- Links render as `shortLink(url)` text; stored URLs are never changed.
- Projects are dropped only in the check step, from the end of the list, never a project that holds a locked manual edit, and never a project before one that does.
- The download/preview render (`/generation/render`) fits the layout but never drops.
- Prompts, guidance and every string sent to Claude say "the candidate" / they / their / them, never "Prayush" / he / his / him.
- Prompt and guidance copies in `n8n/workflows/generate-documents.json` must equal the repo files (existing e2e tests).
- API key never printed or logged; no personal data committed.

## Review Focus

1. **Check-route time.** The fit makes up to about 17 Gotenberg renders on a long CV; the workflow's 60 s check timeout must not cut it off (Task 3 raises it, Task 2 caps the renders).
2. **Locked edit in a project.** A regenerate whose locked edit sits in the last project must keep that project and drop an earlier-ending one only if it comes after every locked project; otherwise `cv_pages` goes back to the writer (Task 2 test).
3. **Old versions download.** A saved CV that overflows even at the floor downloads as 2 pages with nothing removed (Task 2 render-route test).
4. **Empty contact parts.** No email, no phone, no links or no work rights: the contact line has no stray ` | ` and no empty line (Task 1 test).
5. **Check messages reach Claude.** `manual_edit_changed` details and other workflow strings sent to the writer must not name the user (Task 4 test).

---

### Task 1: Template layout and compact header

**Files:**
- Create: `services/worker/src/templates/layout.ts`
- Modify: `services/worker/src/templates/standardAts.ts`, `services/worker/src/templates/index.ts`
- Test: `services/worker/test/standardAts.test.ts`

**Interfaces:**
- Produces:
  - `export interface CvLayout { bodyPt: number; marginTwips: number; spacing: number }` (`spacing` multiplies every paragraph spacing value in the CV).
  - `export const LAYOUT_STEPS: readonly CvLayout[]` — exactly, in order:
    `{10.5,1020,1}`, `{10.5,1020,0.6}`, `{10.5,850,0.6}`, `{10.5,720,0.6}`, `{10,720,0.6}`, `{9.5,720,0.6}`. Index 0 is today's layout; the last is the floor.
  - `export const shortLink = (url: string): string` — strips a leading `http://` / `https://`, then a leading `www.`, then one trailing `/` (case-insensitive scheme).
  - `renderDocx(templateId, kind, cv, letter?, layout: CvLayout = LAYOUT_STEPS[0]): Promise<Buffer>` and `renderStandardAts(kind, cv, letter?, layout?)`.

- [ ] **Step 1: Write failing tests** in `standardAts.test.ts`:
  - `shortLink`: `'https://www.linkedin.com/in/x/'` → `'linkedin.com/in/x'`; `'HTTP://github.com/pray900'` → `'github.com/pray900'`; `'pray900.github.io/P'` unchanged.
  - CV header paragraphs, in order: name; headline; one contact paragraph equal to `Sydney, NSW | a@b.com | 0400 000 000 | linkedin.com/in/x | github.com/y | Full work rights in Australia`. No separate work-rights paragraph. No `LinkedIn:` label or `https://` anywhere in the document XML.
  - With email, phone, links and workRights all empty: the contact paragraph is just the location; with everything empty, no contact paragraph.
  - The letter contact paragraph uses short links and does not contain the work rights.
  - Layout: rendering with `LAYOUT_STEPS[5]` gives body runs of size `19` (half-points), page margins `720`, and a heading `w:before` smaller than with `LAYOUT_STEPS[0]`; rendering with no layout gives size `21` and margins `1020` (today's values).
- [ ] **Step 2:** Run `npm test -w services/worker -- standardAts` — Expected: FAIL.
- [ ] **Step 3: Implement.** `cvParagraphs(cv, layout)`: body size `layout.bodyPt`; name `18 × bodyPt / 10.5` and heading `11.5 × bodyPt / 10.5` (rounded to 0.5 pt); every `spacing` value × `layout.spacing`, rounded; margins `layout.marginTwips` and `TEXT_WIDTH` computed from them. Contact line: `[location, email, phone, ...links.map(l => shortLink(l.url)), workRights]` (work rights only in the CV), empties removed, joined by ` | `. The letter keeps its own size (11 pt), spacing and margins (1020).
- [ ] **Step 4:** Run `npm test -w services/worker -- standardAts` — Expected: PASS. Then `npm test -w services/worker` — fix any older assertion that expected `Label: url` or a separate work-rights line.
- [ ] **Step 5:** Commit `feat(template): compact header with short links; layout parameter for fitting`.

### Task 2: Fit the CV in the check and the render

**Files:**
- Create: `services/worker/src/render/fit.ts`
- Modify: `services/worker/src/generation/checks.ts`, `services/worker/src/generation/routes.ts`, `services/worker/src/generation/types.ts` (if `CheckInput` lives there)
- Test: `services/worker/test/fit.test.ts` (new), `services/worker/test/generationChecks.test.ts`, `services/worker/test/checkRoute.test.ts`, `services/worker/test/renderRoute.test.ts`

**Interfaces:**
- Consumes: `CvLayout`, `LAYOUT_STEPS`, `renderDocx(..., layout)` from Task 1.
- Produces:
  - `export type Measure = (cv: TailoredCv, layout: CvLayout) => Promise<{ pages: number; text: string }>`
  - `export async function fitLayout(cv: TailoredCv, measure: Measure): Promise<{ layout: CvLayout; step: number; pages: number; text: string }>` — first step whose `pages <= 1`; if none, the floor's result.
  - `export async function fitCv(cv: TailoredCv, manualEdits: { path: string; text: string | null }[], measure: Measure): Promise<{ cv: TailoredCv; layout: CvLayout; step: number; pages: number; text: string; droppedProjects: string[] }>`
  - `CheckInput.manualEdits?: { path: string; text: string | null }[]` (default `[]`).
  - `runChecks` returns `{ checks, cvPages, letterPages, cv: TailoredCv, fit: { step: number; droppedProjects: string[] } }`; `/generation/check` returns the same body.

- [ ] **Step 1: Write failing tests** in `fit.test.ts` with a fake `measure` (pages from a rule on the layout and the project count; counts its calls):
  - Fits at step 0 → `step 0`, one call, nothing dropped, CV unchanged (same object contents).
  - Fits only at step 3 → `step 3`, nothing dropped.
  - Fits at the floor only after removing 2 projects → `droppedProjects` = the names of the last two, in drop order; the returned CV lacks them; `step` is the largest-layout (lowest index) step that fits the trimmed CV.
  - Project 4 (last) holds a locked edit (by path `cv.projects[4].bullets[0]`, and separately by text equal to one of its bullets): nothing after it to drop, so nothing is dropped and `pages > 1` is returned.
  - Locked edit in project 2 of 5: only projects 4 then 3 may go; project 2 and earlier never.
  - Still 2 pages at the floor after every droppable project is removed → returns the **original** CV (nothing dropped) at the floor with `pages 2`, so the writer gets `cv_pages` and the whole CV back.
  - Call budget: at most `LAYOUT_STEPS.length` (search) + one floor measure per dropped project + `LAYOUT_STEPS.length` (final search) measures.
- [ ] **Step 2: Write failing tests** in `generationChecks.test.ts` / `checkRoute.test.ts` (using the existing `opts.render` hook, which now receives the layout-specific DOCX):
  - A CV the hook says overflows until a project is removed: response `cv` lacks the last project, `fit.droppedProjects` names it, no `cv_pages` check, and other checks ran on the fitted CV (e.g. a misspelling planted only in the dropped project is **not** reported).
  - Overflow that cannot be fixed: `cv_pages` hard check, `cv` equals the input, `fit.droppedProjects` empty; detail `The CV is 2 pages even at the smallest layout; the limit is 1.`
  - `manualEdits` in the body protects a project as in Step 1.
- [ ] **Step 3: Write a failing test** in `renderRoute.test.ts`: `/generation/render` with a CV that only fits at step 4 returns a document rendered with `LAYOUT_STEPS[4]` (DOCX: body size `20`); a CV that overflows at the floor renders at the floor with every project still present. The render route never drops.
- [ ] **Step 4:** Run `npm test -w services/worker -- fit generationChecks checkRoute renderRoute` — Expected: FAIL.
- [ ] **Step 5: Implement.**
  - `fitCv` algorithm: `fitLayout`; if it fits, return. Otherwise, while the last project is droppable (no locked edit in it or after it), remove it and measure at the floor only; stop as soon as it fits, then `fitLayout` the trimmed CV for the best step. If no drop made it fit, return the original CV at the floor.
  - A project is locked when any manual edit path equals or starts with `cv.projects[i].` / `cv.projects[i][`, or any non-empty edit text equals the project's name or one of its bullets.
  - `runChecks`: build `measure` from the existing render path (`renderDocx` with the layout, then `opts.render` hook or Gotenberg + `readPdf`); call `fitCv` first; run every other check on the fitted CV (the letter render is unchanged); the `cv_pages` detail adds "even at the smallest layout" when `step` is the floor.
  - `/generation/render` for `doc: 'cv'`: `fitLayout` with Gotenberg, then render the DOCX (or PDF) at that layout. Letters unchanged.
- [ ] **Step 6:** Run `npm test -w services/worker` — Expected: all PASS.
- [ ] **Step 7:** Commit `feat(worker): fit the CV to one page (layout ladder, then drop least relevant projects)`.

### Task 3: Workflow uses the fitted CV; reasons panel shows dropped projects

**Files:**
- Modify: `n8n/workflows/generate-documents.json` (nodes "Build check request", "Run code checks", "Read check results", "Choose the version to save")
- Modify: `apps/web/src/api/types.ts`, `apps/web/src/api/parseJobDetail.ts`, `apps/web/src/job/ReasonsPanel.tsx`
- Test: `tests/e2e/generate.e2e.test.ts`, `apps/web/src/job/JobPage.test.tsx` (or the reasons panel's existing test file)

**Interfaces:**
- Consumes: the check response from Task 2 (`cv`, `fit`).
- Produces:
  - Check request body gains `manualEdits` = the run's regenerate `manual_edits` (`[]` on a plain Generate).
  - From "Read check results" on, the round's `writer` is `{ ...writer, cv: b.cv, fit: b.fit }` when the check is valid (the reviewer, the round record and the saved version all see the fitted CV).
  - `reasons.fit = { droppedProjects: string[] }` on the saved version, only when the list is non-empty.
  - Web: `VersionReasons.fit?: { droppedProjects: string[] }`; the parser accepts it absent, or an object whose `droppedProjects` is a string array.

- [ ] **Step 1: Write failing tests** (e2e, workflow-definition style used by the existing "reading the reviewer's answer" tests, and one stub-backed run):
  - "Run code checks" timeout is `180000`.
  - A check response with a fitted CV and `fit.droppedProjects: ['P5']`: the review request's documents contain the fitted CV, the recorded round's writer CV equals it, and the saved version's `cv` lacks P5 and `reasons.fit.droppedProjects` is `['P5']`.
  - No drop: `reasons` has no `fit` key.
  - A regenerate's check request carries `manualEdits` equal to the run's manual edits.
- [ ] **Step 2: Write a failing web test:** a version with `reasons.fit.droppedProjects: ['Handwritten Math Symbol Classification']` shows a line `Left out to fit one page: Handwritten Math Symbol Classification` in the reasons panel, in muted text with an info label (not a status colour alone); a version without `fit` shows no such line and still parses.
- [ ] **Step 3:** Run `npm run e2e -- generate -t "fit|dropped|manualEdits|timeout"` and `npm test -w apps/web` — Expected: FAIL.
- [ ] **Step 4: Implement** the node changes and the panel section (a small section after "What changed and why", titled "Left out to fit one page", one list item per project).
- [ ] **Step 5:** Run the same commands — Expected: PASS.
- [ ] **Step 6:** Commit `feat(n8n,web): use the fitted CV and show projects left out to fit one page`.

### Task 4: Neutral prompts and the all-projects rule

**Files:**
- Modify: `n8n/prompts/write-documents.md`, `n8n/prompts/review-documents.md`, `skills/cv-writing/SKILL.md`, `n8n/workflows/generate-documents.json` (prompt and guidance copies; any workflow string sent to Claude, e.g. the `manual_edit_changed` details in "Read check results")
- Test: `tests/e2e/generate.e2e.test.ts`

**Interfaces:**
- Consumes: Task 3's workflow (edit the same JSON after it).

- [ ] **Step 1: Write a failing e2e test** "nothing sent to Claude names the user": the writer prompt, review prompt, guidance, and the source of every Code node that builds Claude-bound text contain no `Prayush` and no standalone `he`, `his`, `him` (word-boundary, case-insensitive) — the test lists the node names it scans. Update the existing `manual_edit_changed` detail assertions to the new wording: `The candidate emptied "<path>" by hand. Leave it empty.` and `The candidate's own edit at "<path>" was changed or left out. Put it back exactly: "<text>"`.
- [ ] **Step 2:** Run `npm run e2e -- generate -t "names the user|manual_edit_changed"` — Expected: FAIL.
- [ ] **Step 3: Edit the prompts.**
  - Every "Prayush" → "the candidate" (sentence start: "The candidate"); he/his/him → they/their/them, with verbs agreeing ("they have", not "they has").
  - Writer page-limit line becomes: `- Page limit: ONE A4 page, single column. Include every project from the base CV, most relevant to this job first, one bullet each. The code shrinks the layout to fit, and if the page still overflows it leaves out projects from the end of your list, so order matters. Keep about 3 to 4 bullets for each of the two most recent roles, 1 to 2 for older ones, 2 to 4 short skill groups, and a summary of up to 3 lines. If you are unsure, write less. No tables, columns, text boxes or special characters that ATS systems scramble.`
  - Writer line "Leave out padding and generic projects that do not help." → "Order projects by relevance to this job; do not leave any out."
  - Reviewer: add to the checklist's notes: "Do not object to the number of projects, or to a project being absent when the reasons say it was left out to fit one page."
  - `SKILL.md` "One page comes first": replace the first bullet with "Every project goes in, most relevant first, one bullet each. The code leaves out the last projects if the page overflows, so put the strongest first."
  - Copy prompts and guidance into the workflow JSON (README one-liner for the guidance; same for the prompts).
- [ ] **Step 4:** Run `npm run e2e -- generate -t "match n8n/prompts|guidance|names the user|manual_edit_changed"` — Expected: PASS.
- [ ] **Step 5:** Commit `feat(prompts): neutral wording; include every project, most relevant first`.

### Task 5: Docs, full tests, real run

**Files:**
- Modify: `README.md` (generation section: layout ladder, floor, dropped projects note), `GLOSSARY.md` (add **Fit**: shrinking the CV layout to one page, then leaving out the least relevant projects), `docs/superpowers/specs/2026-11-06-jobhunter-design.md` (a "Changed 2026-11-14" note: all projects, layout fit, compact header)

- [ ] **Step 1:** Edit the docs; commit `docs: CV fit, compact header, all projects`.
- [ ] **Step 2:** `npm test` and the full `npm run e2e` — Expected: all PASS.
- [ ] **Step 3:** `docker compose up -d --build` then `bash scripts/n8n-bootstrap.sh`.
- [ ] **Step 4:** Generate on job `ebeb5db7-be68-4af5-8869-22b7f1623387` (about US$0.30–0.90). Check: one page; header is 3 logical lines with short links; projects present (all 5, or a reasons-panel note naming the ones left out); the version passes review or fails only for an ordinary review reason. Record the cost, the layout step and any dropped projects.
- [ ] **Step 5:** Add a short "As built" to this plan and commit `docs: plan 10 as built`.
