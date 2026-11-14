# Australian Government template — design

Date: 2026-11-15. Decided with the user in chat. My own calls are marked **(Claude's call)**. Build order: after Plan 9 (Jobscan learnings).

## Why

Australian government jobs are assessed differently from private ones. A panel scores the applicant against the capabilities or selection criteria the ad names. The ad often asks targeted questions, and panels expect STAR examples (Situation, Task, Action, Result). The weight is on the action the applicant personally took and the result it produced. The panel also accepts a CV of up to 2 pages. The one-page Standard ATS CV leaves this out. The user wants government applications in the form assessors expect, without writing a separate selection-criteria document.

## Goals

1. **A second template, `au-government`, for any Australian government job:** federal, state, territory or local, including statutory bodies. It follows the framework the ad names, such as the NSW Public Sector Capability Framework, the APS Integrated Leadership System or Queensland's framework. When the ad names no framework, it uses the ad's own criteria wording.
2. **Up to 2 pages.** The Plan 10 fit system applies with a 2-page limit instead of 1. It shrinks the layout first, then leaves out the least relevant projects, with the same floor (9.5 pt, 1.27 cm margins) and the same drop note.
3. **The CV and the cover letter only.** There is no third document. The ad's targeted questions and selection criteria are answered inside the CV (in the role achievements and competency statements) and the cover letter.
4. **STAR, with the candidate's own action and its result.** Achievements and letter examples say what the candidate did ("I rebuilt…", "Built…"), not what "we" or "the team" did, and end with the result.
5. **Look A (ATS-safe).** The structure and headings follow the example government CVs. The name and section headings are in navy text, with thin rules under the headings. Single column, a plain text contact line, selectable text. No icons, colour bands, filled heading bars, tables or text boxes.
6. **The app suggests the template, and the user can override it.** The app suggests `au-government` when the employer is an Australian government body, including when a recruiter advertises for one, and gives a one-sentence reason. The suggestion is made when the job is read, before writing (see "Settled", point 1). The job page gets a template choice. Picking a template there applies it to the next Generate.

## The CV, top to bottom

| Section (printed heading) | Content |
|---|---|
| (header) | Name in navy, then the headline, then the compact contact line from Plan 10 (location, email, phone, short links, work rights). |
| PROFESSIONAL SUMMARY | 3 to 5 lines aimed at this role and agency. It is written from base-CV facts only. |
| KEY SKILLS & COMPETENCIES | First, 3 to 6 **competency statements**. Each one is a capability or criterion named as the ad words it, plus one line of proof from the candidate's history. Then up to 2 short technical skill groups, as today. |
| PROFESSIONAL EXPERIENCE | Each role has a title line, an employer and location line, and dates, as today. Under them come **Responsibilities** (2 to 4 short bullets) and **Key Achievements** (1 to 3 STAR bullets: action, then result). Older or less relevant roles may have Responsibilities only. |
| PROJECTS | Only when relevant, most relevant first, one bullet each. They are dropped first when the CV overflows (Plan 10 rules). |
| QUALIFICATIONS | Education and certifications. This is today's education data under the government heading. |
| REFEREES | The fixed text "Referees available on request". The template writes it, not Claude. |

- **Footer (Claude's call):** small muted "Page N of M" text on each page, so a printed copy stays in order. It holds no content an ATS needs.
- **Headings (Claude's call):** use the exact headings above. The `headings` check gets a list per template.

## The cover letter

- It keeps the same layout as the Standard ATS letter (the Plan 10 contact line, 2-page cap).
- **Length (Claude's call):** if the ad states a length or word limit for the letter, follow it. Otherwise aim for about 300 words, on one page, as the NSW guide advises.
- It opens with the role and agency. It answers the ad's targeted questions directly, with one or two short STAR examples, using the ad's capability or criterion names. It closes briefly.
- No "Referees" line in the letter.

## Selection criteria coverage

- **Where the criteria come from (Claude's call):** the job ad text as stored. If a role description or the targeted questions are in a separate document, the user pastes that text into the job file below the ad. There is no new input field.
- The writer returns a **criteria coverage** list. Each entry gives the criterion or question as the ad words it, where it is answered (for example `cv.experience[0].achievements[1]` or `coverLetter`), and, if it is not answered, why. An example of "why" is that the base CV has nothing honest to offer for it.
- The reasons panel shows the list under a "Selection criteria" heading. Unanswered ones carry the amber "needs attention" style, with an icon and the word "Not answered", not colour alone.
- The reviewer checks that every criterion the ad asks about is in the list, that each "answered" entry really answers it in STAR form with the candidate's own action, and that the capability names match the ad.

## Honesty rules (unchanged, restated because government ads invite overclaiming)

- All facts come from the base CV, as today. Plan 7's rule for realistic result figures in experience and project bullets also applies to Key Achievements and competency proof lines. Each new figure is listed as a stretch.
- **Never claim** Australian citizenship, a security clearance (Baseline, NV1 and so on), a police check or a framework capability level unless the base CV states it. If the ad requires one and the base CV does not show it, it goes in `keywordCoverage.missing` with the reason, and the writer does not hint at it.
- Competency statements and achievements must not reuse the ad's wording as if it were the candidate's history (the existing "no paraphrasing the ad as fact" rule).

## Data shape

- `templateId` enum: `standard-ats`, `au-government`.
- Writer CV schema additions **(Claude's call: the smallest growth that keeps one shared schema)**:
  - `cv.competencies: [{ capability, evidence }]`. It is empty for `standard-ats`.
  - `cv.experience[].achievements: string[]`. It is empty for `standard-ats`. Existing `bullets` hold the Responsibilities.
  - top-level `criteriaCoverage: [{ criterion, answeredIn, why }]`, with `""` meaning not applicable. It is empty for `standard-ats`.
  - No nullable types (the Plan 3 grammar rule).
  - **Risk:** the API rejects schemas whose compiled grammar is too large (Plan 3, Plan 8). The builder must confirm the grown schema is accepted with a real call before building on it. If it is rejected, fall back to the smallest change that works and record it.
- Saved versions keep their `templateId`. Old versions with no `achievements` or `competencies` render as today.
- The in-app CV editor can edit `competencies` and `achievements`. Manual-edit locking works on their paths as on any other path.

## Checks and fit

- `cv_pages` limit is per template: 1 for `standard-ats`, 2 for `au-government`. The fit ladder, floor and drop rules are the same.
- `headings` and `render_text` checks get the government heading list.
- Fact, number, link, leakage, spelling and manual-edit checks cover the new fields, the same as they cover bullets.
- The letter's page limit stays at 2. *(Claude's call)* A letter that is over an ad-stated word limit is a reviewer objection, not a code check.

## Non-goals

- A separate selection-criteria or "statement of claims" document.
- Look B (colour bands, icons, filled heading bars) and per-state visual variants.
- Fetching role-description PDFs or attachments from job sites.
- Referee names or contact details.
- Changes to match scoring.

## Anti-goals

- Claiming citizenship, a clearance, a check or a capability level the base CV does not show.
- A targeted question that is silently left unanswered.
- A Standard ATS CV that looks or behaves any differently after this change.
- STAR examples that hide the candidate's own action behind "we" or "the team".

## Where it lives (current code)

- **Template:** a new `services/worker/src/templates/auGovernment.ts`, beside `standardAts.ts`. `renderDocx` in `templates/index.ts` switches on the id.
- **Types and ids:**
  - `TemplateId` and `TEMPLATE_IDS` in `services/worker/src/generation/types.ts`;
  - the `HEADINGS` map and `cv_pages` in `services/worker/src/generation/checks.ts`;
  - the fit system in `services/worker/src/render/fit.ts`, which needs a page limit parameter.
- **Prompts:**
  - `n8n/prompts/write-documents.md` and `write-documents.schema.json`, and `review-documents.md`, with their copies in `n8n/workflows/generate-documents.json`;
  - `skills/cv-writing/SKILL.md` (government section).
- **Web:**
  - the template name map in `apps/web/src/job/JobPage.tsx`;
  - the template choice on the job page;
  - the reasons panel ("Selection criteria");
  - the CV editor fields;
  - `apps/web/src/api/types.ts` and `parseJobDetail.ts`.
- **Test job for the real run:** job2 in the design spec. It is a Queensland Government role advertised by a recruiter, with Key Selection Criteria.

## Settled after the builder check (Claude's calls)

1. **The template is decided before the writer runs, not by the writer.**
   - Job extraction (`n8n/prompts/extract-job.md`) already reads the employer and the advertiser. It also returns `suggestedTemplate` and a one-sentence `templateReason`, which are stored on the job.
   - The job page shows the suggestion with its reason and a template choice. The user's choice is stored on the job and wins over the suggestion until they change it.
   - Generate uses the user's choice if there is one, otherwise the suggestion. Jobs extracted before this change have no suggestion and default to `standard-ats` until the user picks.
   - The writer is told the template in a `<template>` tag. It no longer chooses one. The version still records the `templateId` it used and the reason.
2. **Schema first, with a fallback.** The plan's first task is a real API probe of the grown writer schema. If the shared schema is rejected, use **one schema per template**: the writer gets the schema for the template already chosen (point 1 makes this possible). The Standard ATS schema then stays exactly as today. Only if the government schema alone is still too large, cut from it in this order: `criteriaCoverage[].why`, then the `competencies` proof becomes part of the statement string. Record what happened in the plan's "As built".
3. **Count limits are prompt and reviewer rules only.** Responsibilities 2–4, achievements 1–3, competencies 3–6, summary 3–5 lines and up to 2 skill groups are not code checks. Code checks that already exist apply unchanged to both templates. The only per-template code limit is `cv_pages` (1 or 2).
4. **Fit is the same as Plan 10.** It shrinks the layout, then drops projects from the end. It never removes responsibilities, achievements or competencies. If the CV is still over 2 pages, `cv_pages` fails and goes back to the writer, who removes whole bullets (the existing rule). A government CV shorter than 2 pages is fine and is never padded.
5. **Footer is on the CV only.** It uses Word page fields (PAGE, NUMPAGES), which Gotenberg renders. `render_text` only checks that required text is present, so the extra footer text does not affect it.
6. **Coverage paths are checked by code.**
   - Each `answeredIn` must be `coverLetter` or a path that exists in the CV and is not empty. If not, a hard check sends it back to the writer.
   - Coverage is saved with the version's reasons.
   - When the user's own edit empties or removes a path that coverage points at, that entry is shown as "Not answered (removed by your edit)". It is not a failure.
7. **No invented criteria.** If the ad has no explicit selection criteria, capabilities or targeted questions, `criteriaCoverage` is empty. The reviewer objects only when the ad has criteria that are missing from the list.
8. **Switching template means a fresh Generate.** Regenerate keeps the current version's template and its locked edits. A different template needs a plain Generate, which starts fresh, as Generate does today. The job page says so next to the choice.
9. **Done means one real run on the government job (job2) that passes review.** That costs about US$0.30–1.50, as for a normal Generate, plus the schema probe (a rejected probe is free).

## Left to the builder

- Exact navy shade, rule weight, heading sizes and footer style within look A.
- The DB and API shape for the stored suggestion and the user's choice.
- Test design (unit tests for the template and checks, e2e with the stub, one real run on the government job).
