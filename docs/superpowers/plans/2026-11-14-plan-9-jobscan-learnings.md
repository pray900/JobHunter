# JobHunter Plan 9: What the Jobscan reports taught us Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the things Jobscan marked down on the app's CV that can be fixed honestly: the experience heading, bold styling, long paragraphs, the missing job title, and keywords written in different words from the ad. Also teach the writer (prompt and cv-writing skill) how keyword-matching scanners count.

**Architecture:** Three layers:
1. The template renders differently: heading name and less bold.
2. A new deterministic code check limits paragraph length.
3. The writer and reviewer prompts and the cv-writing skill (Plan 8) get the keyword-matching lessons.

No change to the honesty rules, scoring, the workflow shape or the schema.

**Tech Stack:** as Plans 3–8. No new dependencies.

**Prerequisite:** Plans 8 and 10 are merged (main at 9f3cc0f). This plan edits `skills/cv-writing/SKILL.md`, `n8n/prompts/write-documents.md` and the workflow prompt copies, which both touched. Since Plan 10, all prompt text says "the candidate" / they, and the e2e test `nothing sent to Claude names the user` fails on the user's name or he/his/him. New prompt text must follow that. The SKILL.md body is inlined into the writer prompt copy in the workflow JSON (Plan 8); there is no separate skill upload.

**Spec:** `docs/superpowers/specs/2026-11-06-jobhunter-design.md` (§6.2 Generate, §6.4 Checks) and `docs/superpowers/specs/2026-11-14-cv-fit-and-projects-design.md` (fit and header, Plan 10).

## Evidence (the user's Jobscan reports, job "Early Start Australia – Salesforce Consultant", 2026-11-14)

| | Base CV | App's CV | Jobscan's rewrite |
|---|---|---|---|
| Match rate | 39 | 42 | 47 |
| Hard skills missing | 15 | 14 | 12 |
| Soft skills missing | 10 | 10 | 10 |
| Searchability issues | 1 | 2 | 2 |
| Formatting issues | 4 | 2 | 1 |
| Words | 607 | 349 | 368 |

What each finding means for the app:
1. **The experience heading isn't recognised.** The app's "EXPERIENCE" heading got "Name your experience section 'Work History' or 'Professional Experience'". The base CV passed this check. **Template fix.**
2. **Too much bold** on the app's CV (Jobscan's rewrite passed). The template bolds every section heading, the whole role line (title, employer, location), project names and education lines. Jobscan's rule is bold only for the name, job titles and company names. **Template fix.**
3. **Paragraphs over 40 words** (all three CVs). In the app's CV that is the summary (about 55 words) and probably long skill-group lines. **New code check + prompt rule.**
4. **The job title isn't in the CV.** Jobscan: "If you haven't held this position before, include it as part of your summary statement." **Prompt rule, honest framing only.**
5. **Exact wording counts.** Jobscan matches literal phrases and counts how often they appear:
   - "Troubleshoot" and "Troubleshooting" are separate skills.
   - "Salesforce experience" is a phrase of its own.
   - The ad repeats "Collaboration" 3 times and "Supportive" 4 times.
   - Jobscan's rewrite gained "Data integrity" (2) and "CI/CD" (3) by reusing the ad's words for facts the CV already had.

   **Prompt + skill.**
6. **Not fixable honestly:** Healthcare technology, HIPAA, Health services, Data migration, Industry regulations, Change management and similar terms are absent from the base CV. They stay in `keywordCoverage.missing`. The real gap is the base CV, not the writing.
7. **File type:** Jobscan prefers PDF over .docx. The app already offers PDF downloads, so upload those. README note only.

## Decisions (Claude's calls, for the user to check)

- **Don't over-fit to Jobscan.** It is one scanner with its own literal matching. The changes are the ones that also make sense to a recruiter and a real ATS. There is no fake score, and no keyword stuffing.
- **Heading:** "Professional Experience", one of Jobscan's two suggestions. It's the more common phrase in Australia.
- **Bold:** only the name, job titles and employer names. Section headings stay distinct through capitals, a larger size and the bottom rule, with no bold. Location, dates, project names and education lines are not bold.
- **Paragraph limit:** a **hard** check, `long_paragraph`, for any CV paragraph over **40 words**: the summary, each bullet, the headline, and each skill-group line ("Group: a, b, c"). It's easy for the writer to fix, and Jobscan flagged it on all three CVs. Cover letter paragraphs are exempt, since letters are prose.
- **Job title, honestly** (changed after review, user's decision 2026-11-15): the ad's exact job title may appear once in the **summary**, framed as the role the candidate is applying for ("…, applying for the Salesforce Consultant role"). It is never presented as a title they held, unless the base CV shows they held it. The headline may use it only in that case, and it never appears in an experience title the base CV does not give. Writer and reviewer say the same. The reviewer fails a version that implies the candidate held it. Plan 4 (stretch-listing of `cv.headline` titles) is unchanged.
- **Exact terms:**
  - When a base-CV fact supports an ad keyword, write the ad's **exact form** at least once (its word form and phrase), rather than a synonym. For example, the ad says "troubleshoot" and the fact says "debugged" → "troubleshoot".
  - Frequency (changed after review, user's decision 2026-11-15) is an anti-stuffing guide, not a hard count, and counts only the writer's own text: headline, summary, skill groups and bullets. Text copied exactly from the base CV (job titles, employer names, project names, qualifications and certifications) does not count. **Any** keyword may appear at most 2 times in the writer's own text; aim for 2 when the ad uses it **2 or more times** (for example skills and one bullet; the headline and summary count toward the two). Never repeat a keyword just to raise its count, never as a keyword list in prose, and never delete or weaken an honest fact to meet the limit. The reviewer does not object to a repeat from copied text or from a genuinely different fact (the same tool in two roles' bullets).
  - `keywordCoverage.covered` uses the ad's exact form, so the existing `keyword_not_found` check proves it's really in the CV text.
- **Model settings unchanged.** Writer and reviewer stay on Opus 5.5 at `medium` effort with 3 rounds. Changing them adds cost without evidence it helps. Measure after this plan, using Jobscan on the same job.

## Global Constraints

- Everything in Plans 1–8 still holds. In particular:
  - the facts rules, copy-exactly rules and figure rules (Plan 7) are unchanged;
  - the prompt copies in `generate-documents.json` equal `n8n/prompts/*.md`;
  - Australian English.
- New check: code `long_paragraph`, severity `hard`, doc `cv`, `where` = the field path (`cv.summary`, `cv.headline`, `cv.experience[i].bullets[j]`, `cv.projects[i].bullets[j]`, `cv.skills[i]`). Detail: `"<n> words; keep it to 40 or fewer."` Words are counted as runs of non-space characters. Fields the user locked by a manual edit follow the existing locked-edit rule ("Your edit — kept as you asked").
- The web label for `long_paragraph`: "Paragraph over 40 words". Amber, with the label, like the other hard checks.
- Template id stays `standard-ats`. Old versions re-render with the new styling on download (rendering is on demand). That's acceptable and noted in "As built".

## Review Focus

1. **Locked manual edit over 40 words:** reported as "Your edit — kept as you asked" and not sent back to the writer (Task 2 test `long locked bullet is kept`).
2. **The target title in a role title or headline** ("Salesforce Consultant, ComplianceQuest"): the existing `unknown_fact` for role titles still fires. The reviewer fails the headline case (Task 3: the reviewer prompt; e2e prompt-copy match).
3. **The render check after the heading change:** `render_text` looks for "PROFESSIONAL EXPERIENCE" in order. The old "EXPERIENCE" alone must not pass by accident (Task 1 test `heading order uses Professional Experience`).
4. **A skill group of 20 short items:** counted as one paragraph, so a hard `long_paragraph` asks the writer to split or trim the group (Task 2 test).
5. **Keyword repetition:** a keyword the ad uses once still appears at most once. The reviewer's `keyword_stuffing` item still applies (Task 3 reviewer prompt).

---

### Task 1: Template heading and bold

**Files:**
- Modify: `services/worker/src/templates/standardAts.ts` (heading text, bold rules), `services/worker/src/generation/checks.ts` (`HEADINGS`: `'PROFESSIONAL EXPERIENCE'`)
- Test: `services/worker/test/standardAts.test.ts`, `services/worker/test/generationChecks.test.ts`, plus any e2e render test that asserts heading text (grep for `EXPERIENCE`)

**Interfaces:**
- `heading(text)`: upper-case, size unchanged (Plan 10 scales it with the fit layout), bottom border, `keepNext`, **not bold**.
- `titleLine` for roles: bold runs for the title and the employer; location and dates are plain. For education: the whole line is plain.
- Project names are plain. The name stays bold, 18 pt.

- [ ] **Step 1: Failing tests:**
  - `experience heading reads Professional Experience`
  - `only the name, titles and employers are bold` (inspect the docx XML runs: `<w:b/>` only on those runs)
  - `heading order uses Professional Experience` (a PDF text with "EXPERIENCE" but not "PROFESSIONAL EXPERIENCE" fails `render_text`)
- [ ] **Step 2: Run** `npm test -w services/worker -- standardAts generationChecks`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w services/worker`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): Professional Experience heading and sparse bold`

---

### Task 2: `long_paragraph` check

**Files:**
- Modify: `services/worker/src/generation/checks.ts` (new code in `CheckCode`, the check, wired into `runChecks`), `apps/web/src/job/labels.ts` (label)
- Test: `services/worker/test/generationChecks.test.ts`, `apps/web/src/job/labels.test.ts`

**Interfaces:**
- `longParagraphChecks(cv: TailoredCv): CheckResult[]` per Global Constraints. It uses the same `where` paths as `cvSegments` in `textOf.ts`. The locked-edit handling is the existing mechanism; reuse it, don't re-implement it.

- [ ] **Step 1: Failing tests:**
  - `41-word summary is long_paragraph`
  - `40-word bullet passes`
  - `long skill group line is long_paragraph at cv.skills[i]`
  - `cover letter paragraphs are not checked`
  - `long locked bullet is kept`
  - web: `long_paragraph has a label`
- [ ] **Step 2: Run** `npm test -w services/worker -- generationChecks` and `npm test -w apps/web -- labels`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): CV paragraphs over 40 words are a hard check`

---

### Task 3: Prompts and skill (money: per-task review on Opus)

**Files:**
- Modify: `n8n/prompts/write-documents.md`, `n8n/prompts/review-documents.md`, their copies in `n8n/workflows/generate-documents.json` (via a small Node script, exact escaping), `skills/cv-writing/SKILL.md`, `README.md` (one line: upload the PDF download to job sites)
- Test: `tests/e2e/generate.e2e.test.ts` (existing prompt-copy test), plus the worker prompt test if it covers the files

**Interfaces (content, in the writer prompt's "The CV" section):**
- Summary: at most 40 words. It may name the ad's exact job title once, only as the role they are applying for, never as a title they held unless the base CV gives them that title. The headline may use the ad's title only in that case (changed after review, user's decision 2026-11-15).
- Every bullet and skill-group line: at most 40 words.
- Exact terms: when a base-CV fact supports an ad keyword, use the ad's exact word form and phrase at least once instead of a synonym. Any keyword may appear at most twice in the writer's own text (headline, summary, skill groups, bullets), aiming for twice when the ad uses it 2 or more times; text copied exactly from the base CV does not count; never repeat just to raise a count or weaken a fact to meet it (changed after review, user's decision 2026-11-15). List covered keywords in the ad's exact form.
- Soft skills: use the ad's soft-skill words ("collaboration", "communication", "problem-solving") where a base-CV fact shows them. Never list them bare in skills.

**Reviewer:**
- Item 6 or 11 also checks that the target title appears only as the role applied for.
- Item 7 `keyword_stuffing` names the "at most twice" limit for the writer's own text only, and does not object to repeats from copied base-CV text or genuinely different facts (changed after review, user's decision 2026-11-15).
- Item 11 checks that covered keywords use the ad's exact form.

**SKILL.md:** a new section, "How keyword scanners count" (literal phrases, word forms, frequency, title match, 40-word paragraphs, sparse bold is the template's job, PDF upload). Keep the closing line.

- [ ] **Step 1:** Edit the files and sync the workflow copies.
- [ ] **Step 2: Run** `E2E_KEEP_STACK=1 npm run e2e -- generate`, then tear down. Expected: PASS, including the prompt-copy test.
- [ ] **Step 3:** The SKILL.md body copy inside the writer prompt in `generate-documents.json` matches the edited file (the existing e2e copy test enforces it). The name test `nothing sent to Claude names the user` passes.
- [ ] **Step 4: Commit** `feat: writer, reviewer and skill learn how keyword scanners count`

---

### Task 4: Full tests and real run (controller + the user)

- [ ] **Step 1:** `npm test` and the full `npm run e2e`. Expected: all PASS.
- [ ] **Step 2:** Rebuild the stack (`docker compose up -d --build`, `bash scripts/n8n-bootstrap.sh`). Then click Generate again on "Salesforce Consultant – Early Start Australia" (about US$0.30–1.00). Record the cost.
- [ ] **Step 3 (the user):** Download the **PDF**, run it through Jobscan against the same ad, and compare with 42. The bar is: the experience heading, bold and paragraph issues are gone; the job title is found; and the match rate is above 42. Hard-skill gaps that the base CV can't support will remain.
- [ ] **Step 4:** Write "As built" with the Jobscan result and commit `docs: plan 9 as built`.
