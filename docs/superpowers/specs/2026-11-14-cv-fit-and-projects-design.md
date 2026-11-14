# CV fit, compact header, all projects, neutral prompts — design

Date: 2026-11-14. Decided with Prayush in chat; my calls are marked **(Claude's call)**.

## Why

The generated CV wastes the top of the page on a 4–5 line header with long labelled URLs, and it shows only 1–2 of the 5 projects in the base CV. Prayush wants more of his work on the one page. The app will also be used by other people soon, so the prompts must not name him.

## Goals

1. **Compact header.** At most 3 logical lines, at most 4 printed lines on the page:
   - Line 1: name.
   - Line 2: headline.
   - Line 3: location | email | phone | links | work rights, joined by ` | `. Links are shown as plain text without the scheme or `www.` and without labels (`linkedin.com/in/prayushshrestha`, not `LinkedIn: https://linkedin.com/in/prayushshrestha`). This line may wrap once.
   - Applies to the CV header in the `standard-ats` template. The cover letter header gets the same contact line format **(Claude's call: one format everywhere)**.
2. **Shrink to fit (code, no Claude call).** When the CV renders at more than one page, the worker re-renders with progressively tighter layout until it fits or reaches the floor:
   - Start: today's layout (10.5 pt body, about 1.8 cm margins, today's spacing).
   - Floor: **9.5 pt** body text, **1.27 cm** margins. Never smaller.
   - Order of steps **(Claude's call)**: tighten paragraph spacing first, then margins, then font size in 0.5 pt steps. Name and heading sizes shrink in proportion. Exact step values are the builder's call within the start and floor.
   - Every CV that fits at the start layout looks exactly as today (no change to CVs that already fit).
3. **All projects.** The writer includes every project in the base CV, most relevant to the job first, one bullet each (the guidance already allows a second bullet only when there is room).
4. **Drop the least relevant project when the floor is not enough (code).** If the CV is still over one page at the floor, the worker removes projects from the end of the list (the least relevant, since the writer orders them) one at a time and re-fits, until it fits or no projects are left. If it still does not fit with no projects, `cv_pages` stays a hard failure as today and goes back to the writer.
   - A project holding one of the user's locked manual edits is never dropped; the next one up is dropped instead.
   - Each dropped project is reported so the user can see it: it appears in the job's reasons panel (as a note such as "Left out to fit one page: <project name>").
   - The saved version holds the CV **after** dropping, so what the reviewer reads, what is saved and what is downloaded are the same document.
5. **Same output on download.** Rendering a saved version (PDF or DOCX download, preview) produces the same layout the check found. **(Claude's call)** The fit is computed again at render time with the same deterministic steps rather than stored, so old versions also get the new header and fit.
6. **Neutral prompts.** In `n8n/prompts/write-documents.md`, `n8n/prompts/review-documents.md` and `skills/cv-writing/SKILL.md` (and their copies in `n8n/workflows/generate-documents.json`), "Prayush" becomes "the candidate" and he/his/him becomes they/their/them. Wording only.
7. **Prompt rules match.** The writer prompt's page-limit line changes from "at most 1 or 2 projects" to "every project from the base CV, most relevant first, one bullet each; the code shrinks the layout and drops the least relevant projects if the page overflows". The reviewer must not object that projects are many or that one was dropped.

## Non-goals

- No multi-user accounts, logins or per-user data. One account, as today.
- No change to the cover letter's page limit (2) or its layout beyond the contact line.
- No new templates. Plan 9 (Jobscan learnings) stays a separate plan; its heading rename and 40-word paragraph check are not part of this.

## Anti-goals

- Text smaller than 9.5 pt or margins under 1.27 cm, ever.
- A dropped project that the user cannot see was dropped.
- The reviewer and the download seeing different documents.
- Losing a locked manual edit to the drop step.

## Constraints

- The page count comes from the real PDF (Gotenberg), as `cv_pages` does today. Each fit step costs one DOCX→PDF render (about a second); keep the number of steps small (about 6 or fewer before dropping projects).
- ATS: text stays selectable, single column; the `render_text` check must still pass (name and contact present in the PDF text).
- Prompt copies in the workflow JSON must match the repo files (existing e2e tests).
- Existing checks keep working: links in the contact line are still checked by `linkChecks`.

## Where it lives (current code)

- Template: `services/worker/src/templates/standardAts.ts` (fixed `MARGIN`, `size = 10.5`, `contactLine`, `nameLine`).
- Render entry: `services/worker/src/templates/index.ts` `renderDocx`.
- Check and page count: `services/worker/src/generation/checks.ts` `runChecks` (`cv_pages`).
- Download/preview render: `/generation/render` in `services/worker/src/generation/routes.ts`.
- Workflow: "Build check request" / "Read check results" in `n8n/workflows/generate-documents.json` (the worker's answer must carry the fitted CV and the dropped project names; the workflow uses the fitted CV from then on and records the drop note).

## Settled after the builder check (Claude's calls)

1. **Locked edits reach the worker.** "Build check request" adds the locked manual-edit paths to the `/generation/check` body (e.g. `lockedPaths: ["cv.projects[2].bullets[0]", ...]`, from the run's manual edits; empty on a plain Generate). A project with any locked path under `cv.projects[i]` is never dropped.
2. **Only locked projects left and still too long:** stop dropping; `cv_pages` is a hard failure and goes back to the writer, as today, with the detail saying it does not fit even at the smallest layout.
3. **Download/preview render fits but never drops.** `/generation/render` runs only the shrink steps on the saved CV. If a saved CV (for example after a later edit) still overflows at the floor, it renders at the floor and runs onto a second page, rather than silently removing content. Dropping happens only in the check step, where it is recorded.
4. **The drop note is not a check.** It travels as a separate field in the check response (for example `fit: { step, droppedProjects: [names] }`) and is stored with the version's reasons, shown in the reasons panel as an information line. It never blocks approval or needs acknowledging.
5. **Links: display only.** The stored CV keeps the full URLs; only the rendered text is shortened. Fact, copy and link checks work on the CV data, so they are unchanged. Plain text in the document (no hyperlink needed); if the template already writes hyperlinks, keeping the full URL as the hidden target is fine.
6. **Cover letter:** its contact line uses the same short link format. Nothing else about the letter header changes (no headline or work-rights line is added).
7. **Fit runs first inside the check.** `runChecks` fits the CV (shrink, then drop) before every other check, and all other checks run on the fitted CV. If any check flags a project from the base CV as missing, a project dropped by the fit is exempt from it.

## Left to the builder

- Exact spacing/margin/size step values between start and floor.
- How the fitted CV and dropped names travel back from `/generation/check` (response shape) and how the drop note is stored for the reasons panel.
- Test design (unit tests with a fake page counter; e2e with the stub).
