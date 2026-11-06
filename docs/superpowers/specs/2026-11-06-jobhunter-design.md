# JobHunter: Tailored CV & Cover Letter Generator — Design

Date: 2026-11-06
Status: Draft for approval

## 1. Intent

Prayush applies for jobs in Australia (Master of IT, UTS, conferral Nov 2026; 485 visa; 2.5 years Salesforce developer experience). The slowest, most annoying part of applying is producing a custom, ATS-friendly CV and cover letter for every job, and keeping track of where each application stands.

JobHunter is a local web app that:

- picks up job listings from a folder of Word files,
- shows them as cards ranked by how well Prayush matches them,
- on request, uses Claude to write a tailored 1-page CV and cover letter from Prayush's base CVs,
- has an **independent** Claude reviewer (acting as a senior recruiter / HR / ATS specialist) check the writer's work and push back until it is good,
- explains **every** decision (base CV chosen, template chosen, match score, keyword coverage, each rewrite) in plain language,
- lets Prayush edit the result in-app, give Claude extra instructions to regenerate, download Word + PDF, open the job posting, and track the application's status.

Prayush is also using this project to **learn n8n**, so n8n is the backend/automation layer by choice, not just by convenience.

### Success looks like

Prayush drops a job file in the folder, clicks Generate, and gets a CV and cover letter they would send without having to fix anything embarrassing. They understand *why* every choice was made and trust that nothing in it would get them caught out in an interview.

## 2. Goals, non-goals, anti-goals

### Goals (this version)

- Folder-based job intake, Word files.
- Job cards ranked by match score, with status tracking.
- Job page: full JD, CV + cover letter preview, in-app editing, reasons panel, diff vs base CV, instruction box + regenerate, version history, downloads (DOCX + PDF), open-posting button, status dropdown.
- My documents page: multiple base CVs and base cover letters (Word or PDF), each for a kind of role.
- Writer/reviewer loop with independent reviewer and automated code checks.
- Template system with one shipped template (Standard ATS).
- Code shaped so the future changes in §9 are cheap.

### Non-goals (this version)

- RSS / automatic job discovery.
- Online hosting, logins, multiple users.
- Automatically submitting applications to job sites.
- Additional CV templates beyond Standard ATS (system supports them; none built).
- A master fact file (considered and explicitly rejected by Prayush; see §6.3).

### Anti-goals (failure even if it "works")

These are hard fails. A CV/cover letter that has any of them must not be presented as passing.

**Gets you caught in an interview**
- Invented skills or experience not supported by the base CVs (e.g. claiming Kubernetes or "5 years of Python").
- Made-up metrics ("improved efficiency by 40%") not present in the base CVs.
- Inflated titles or scope ("led", "architected" for contributed work).
- Inconsistent facts between versions (years of experience, dates, titles shifting between generated CVs).

**Reads as careless**
- Template leakage: any company name or role title other than the target job's, carried from another run.
- Leftover placeholders: `[LinkedIn URL]`, `{{company}}`, `XX%`, `Lorem`, etc.
- Degree status wrong: must read as "Master of IT, UTS (conferral Nov 2026)" — not implied as conferred, not years away.
- Missing work rights line (e.g. "Full working rights (485 visa)").
- US spelling ("optimize", "analyze") — must be Australian English.
- Miscased tech names (Javascript, Github, SalesForce, Nodejs).
- Spelling or grammar mistakes.

**Reads as AI-generated**
- Buzzwords: "spearheaded", "leveraged", "results-driven", "passionate", "dynamic", "proven track record", "thrilled", "fast-paced world", "synergies" (list is configurable).
- Summary that paraphrases the job ad back.
- Keyword stuffing that makes bullets unreadable.
- Every bullet in the same "Verb + X, resulting in Y%" rhythm.

**Hurts tailoring**
- Irrelevant details that don't earn their place for this job.
- Over-tailoring that hides a major part of history (e.g. hiding Salesforce entirely on a cyber role leaves an unexplained gap).
- Strongest match not in the top third of page 1.
- Padding (generic projects section etc.).

**Length & formatting**
- CV longer than 1 page. Cover letter longer than 2 pages (target 1 page — builder's call; 2 is the hard limit).
- Tables or columns that ATS systems scramble.
- Fonts/spacing inconsistent between sections.
- Orphaned headings at page breaks, overflowing text, broken bullets, inconsistent date formats.
- Broken or untested links.

**Honesty stance (Claude's, stated to Prayush and accepted by default):** the writer may select, reorder and rephrase what is in the base CVs, and frame real work in the job's language as strongly as is honest. It must not inflate. Where a bullet is close to the line, the reasons panel flags it as a stretch so Prayush decides.

## 3. Constraints

- Runs locally on Prayush's Windows 11 PC via **Docker Desktop** (installed), started with one command.
- **n8n** is the backend / automation layer (Prayush's choice, learning goal).
- Claude is called via the **Anthropic API** using Prayush's own key; pay-per-use is accepted.
- Claude calls that cost real money (writer/reviewer) only happen when Prayush clicks Generate or Regenerate — never automatically on file arrival.
- Output: CV and cover letter downloadable as both **DOCX and PDF**.
- Australian English throughout generated documents.
- The job listing folder location must be configurable (default: `Joblisting/` in the project root — note capital J as it exists today).
- **Personal data stays out of git** *(Claude's call)*: `Joblisting/`, `PersonalDetailsCV/`, `PersonalDetailsCoverLetter/`, generated output, and `.superpowers/` are git-ignored. Test fixtures derived from the real files are redacted (no phone, email, third-party names) before being committed.

## 4. What Prayush decided (as decided)

- Main screen is a set of **cards**, one per job: title, company, short description, status, match score. **Sorted by match score, highest first.**
- Statuses track the application (e.g. New, CV ready, Applied, Interviewing, Closed).
- Clicking a card opens a job page with: full JD, CV and cover letter, reasons for the changes, a box for extra instructions + regenerate, a link to the job posting.
- **Every decision gets a reason**, including the match score ("why 82%").
- Multiple base CVs for different kinds of roles, provided as Word and PDF.
- Claude **picks the base CV** for each job, says why, and Prayush can switch it.
- Generated CV and cover letter are **editable in-app** for small changes.
- On Regenerate, Claude **sees Prayush's manual edits and keeps them** unless the new instruction says otherwise.
- Generation **waits for a Generate click**; nothing expensive runs on file arrival.
- The reviewer is an **independent agent** (separate call, separate instructions, no access to the writer's private reasoning), acting as a CV / HR / ATS expert. Same-agent self-review is rejected as a conflict of interest.
- Templates: style lives in templates, separate from content. Template is chosen per job on the job page (dropdown next to base CV), Claude suggests one with a reason. Ship **only Standard ATS** now.
- Job files: **URL on the first line**, rest is the job ad copy-pasted as-is.
- Prepare for the future changes in §9 now, without building them.
- **CV is strictly 1 page.**
- **No master fact file.** Base CVs are the source of truth.

## 5. Architecture (Claude's calls unless noted)

```
 Joblisting/*.docx ──► [n8n: intake flow] ──┐
                                            ▼
 React UI  ◄──HTTP (webhooks)──►  n8n flows  ◄──►  PostgreSQL
                                     │
                                     ├──► Anthropic API (Haiku for extraction; Sonnet/Opus for writer & reviewer)
                                     ├──► Document renderer (DOCX + PDF)
                                     └──► File storage (local folder)
```

All services run under one `docker compose up`.

- **Who builds the n8n workflows** (Prayush's decision): **Claude writes them** as workflow JSON files kept in the repo, imported into n8n by script, and tested automatically (e.g. by calling their webhooks). Prayush learns n8n by opening, reading and tweaking them in the n8n editor. So: keep workflows readable — clear node names, sticky notes explaining each step, logic in visible nodes rather than hidden in large Code nodes or sidecars where a reasonable n8n-native option exists.
- **n8n** (Prayush's decision): all backend logic as n8n workflows — folder watching, Word parsing, Claude calls, the writer/reviewer loop, code checks, document rendering orchestration, and HTTP endpoints (webhooks) the UI calls. Where n8n's built-in nodes fall short (DOCX parsing, DOCX generation, spell check), use Code nodes with npm packages or a small sidecar service — builder's call, but keep the *orchestration* in n8n so Prayush learns it.
- **UI** — Claude's call: **React + TypeScript** (Vite). Rationale: most common, good for an editable live preview, easy to host later, and close to the JavaScript Prayush knows from Salesforce Lightning Web Components.
- **Database** — Claude's call: **PostgreSQL**. n8n connects natively; it is what a hosted multi-user version would use, so nothing gets swapped later.
- **CV representation** — Claude's call: the generated CV and cover letter are stored as **structured data** (contact, summary, roles → bullets, skills, education, work rights, etc.), not as Word files. The in-app preview, in-app editing, reviewer checks, diff view and both downloads all come from this one source. A template turns the structured data into DOCX/PDF.
- **Model choice** — Claude's call: a small model (Haiku) for cheap extraction at intake; a strong model (Sonnet or Opus, latest) for writer and reviewer. Model IDs configurable.

## 6. Behaviour

### 6.1 Job intake

1. n8n watches the configured job-listing folder.
2. On a new `.docx`: line 1 is the URL; everything after it is the job description, stored verbatim.
3. A cheap Haiku call extracts **job title, company, short description** for the card (~a tenth of a cent per job). Claude's call, as pulling these reliably from pasted ads of varying layouts needs it.
4. **Match score** (Prayush's decision): a second cheap call scores **how well Prayush fits the job** — base CVs vs. the job ad — with a plain-language explanation ("82%: 11 of 14 required skills, one year short of the 3+ asked, domain near match"). Roughly 1 cent per job. It is computed at intake so every card is scored and the main screen can be sorted immediately. It does **not** change when a CV is generated or regenerated. It is recomputed only when base CVs change or the job file changes. (Separately, each generated version reports its own keyword coverage in the reasons panel; that is not the match score.)

These two intake calls are the only Claude calls that run without a click (besides the base-document check in §6.3, which runs on upload — itself a click).
5. If line 1 is not a URL, the card is still created and shows a visible warning (no silent failure).
6. A file removed from the folder → its card follows (builder decides: hide vs. mark "source file removed"; don't lose generated work or status history). A file modified → re-import its description; existing generated versions are kept.
7. New jobs have status **New** and a match score. If scoring failed, the card shows that and sorts last.

### 6.2 Generate

Triggered by the Generate button on a card or job page.

1. **Base CV selection.** Claude picks the best-fitting base CV (and base cover letter) and gives a reason ("used Frontend CV because the role is mostly React work"). Prayush can switch it on the job page, which regenerates.
2. **Template selection.** Claude picks a template with a reason (only Standard ATS exists today). Switchable on the job page.
3. **Writer** produces structured CV + cover letter + reasons + keyword coverage of this version. (The match score is not produced here; it comes from intake, §6.1.)
4. **Automated code checks** (§6.4) run on the rendered output.
5. **Reviewer** (independent) reviews against the checklist (§6.4) with the code-check results attached, returns pass/fail per item and specific objections.
6. Writer revises in response to objections; steps 4–5 repeat, up to **3 rounds** (Claude's guess, configurable).
7. If still failing after the limit, Prayush gets the best version, clearly marked with what is unresolved.
8. Result saved as a new **version**; status becomes **CV ready**.

The reviewer also checks the honesty of each reason and the keyword-coverage claim.

### 6.3 Source of truth (no master fact file)

- Base CVs are the only source of facts.
- Every skill, number/metric, job title, employer, and date in a generated CV must be traceable to at least one base CV. Anything that isn't is flagged (code check where possible, reviewer otherwise).
- If base CVs disagree with each other on a fact (e.g. 2.5 vs 3 years experience, different dates), the app surfaces a warning on My documents so Prayush fixes the base CVs. Generation should not silently pick one. *(Claude's call:)* generation still runs, with a warning banner on the job page naming the conflict; the writer uses the more conservative version of the fact. Conflicts are detected by a Claude call when a base document is added or changed (an action Prayush takes), not on every generation.
- **How strict the fact check is** *(Claude's call)*: a skill, number/metric, job title, employer or date that does not appear in any base CV is a **hard fail** the writer must fix. Rephrasing real work in the job's language (e.g. "Lightning Web Components" → "modern JavaScript component frameworks") is allowed; the code check flags it as unmatched and the **reviewer** rules whether the rephrasing is honest. Rulings show in the reasons panel.
- Facts must be consistent across all generated versions for the same person.
- Degree status and work-rights line must appear as in the base CVs; if a base CV lacks the work-rights line, flag it.

### 6.3a Cover letter sources *(Claude's call)*

- The cover letter may draw only on: the job ad, the base CVs, the base cover letter, and an optional per-job **"My notes about this company"** box on the job page. No fetching of the company website or other outside content, so nothing about the company is invented.
- The base cover letter is a **tone/style sample and source of reusable paragraphs**, not a source of company facts. Anything in it about a previous target (company name, addressee, role) must never carry over (see §6.7 findings: the current base letter names "Decode Global" and "Ms. Li").
- Addressee: use a name only if the job ad or Prayush's notes give one; otherwise "Hiring Manager".

### 6.4 Checks

**In code (deterministic — prefer these over asking Claude):**
- Page count on the rendered PDF: CV = 1, cover letter ≤ 2.
- Render check: PDF → extract text → confirm it parses cleanly, in the expected reading order.
- Regex for brackets/braces/placeholders (`[...]`, `{{...}}`, `XX%`, `Lorem`, `TBD`).
- Any company name other than the target's (template leakage), and role-title leakage.
- Banned-word list (configurable).
- AU spelling check (US → AU variants) and general spell check.
- Tech-name casing list (JavaScript, GitHub, Salesforce, Node.js, …; configurable).
- Fact diff: skills, numbers, titles, dates in output vs. base CVs; flag anything not found.
- Links: format-valid and reachable.
- Template structural rules: no tables/columns, consistent fonts/spacing, no orphaned headings.

**By the reviewer (judgement):**
- Relevance of every bullet/section to this job; over-tailoring; strongest match in top third.
- Inflated scope or verbs; stretches flagged.
- AI-sounding text: paraphrased JD summary, keyword stuffing, monotonous bullet rhythm.
- STAR form for bullets; overall tidiness.
- Keyword coverage of the JD and whether missing keywords are honestly missing.
- Each stated reason holds up.

### 6.5 Regenerate with instructions

- Instruction box on the job page + Regenerate button.
- Writer receives: the JD, chosen base CV, current version **including Prayush's manual edits**, and the instruction. It keeps manual edits unless the instruction says otherwise.
- Runs the full review loop again. Saves a new version labelled with the instruction.

### 6.6 In-app editing

- Prayush edits the structured CV/cover letter directly in the preview for small changes.
- Edits are saved as a new version (or update to the current one — builder's call; must be recoverable).
- Code checks re-run on save so Prayush sees if an edit broke a rule (e.g. now 2 pages). The reviewer is not re-run on manual edits unless Prayush asks (builder's call).

### 6.7 What the real files showed (2026-11-06)

Prayush supplied 3 job files and real base documents. Use them (redacted where needed, see §3) as the first test fixtures. Findings the build must handle:

**Job files (`Joblisting/job1–3.docx`)**
- "URL on line 1" really means the **first non-empty line**: two files start with an empty paragraph. In job1 the URL is a Word **HYPERLINK field** (field code + display text), and URLs contain XML-escaped `&amp;`. The parser must handle hyperlink fields, plain text URLs and entity decoding.
- URLs are what Prayush copied: a LinkedIn *search-results* URL with `currentJobId`, an Indeed search URL with `vjk`, a Seek apply URL. Store and open them as-is.
- The pasted text contains a lot of **site chrome**: "Apply", "Save", "Show match details", "People you can reach out to" (with a real person's name and headline), "Activate Premium", Seek's "How you match", company follower counts, EEO boilerplate. Extraction and keyword analysis must ignore this, and the writer must never use names from it.
- **Company ambiguity:** job2 is posted by a recruiter (Redwolf + Rosch) for an unnamed Queensland Government entity. Extraction must capture *advertiser* vs *employer* where they differ; cover-letter addressing and the leakage check must use the right one.
- **Target company that is also a skill:** job3's employer is Salesforce. The template-leakage check must not flag "Salesforce" as a foreign company when it is a skill, and must not miss it as the target.
- Job ads use US spelling ("optimize", "modeling"). Keyword matching must treat US/AU variants as the same keyword while output stays AU.
- job2 is a government role with "Key Selection Criteria" — a realistic case for a future template, but **no new template is built now**.
- The three jobs vary in fit (Salesforce dev 3–5 yrs; senior Salesforce 5+ yrs; Tableau pre-sales). Good spread for testing match-score honesty.

**Base CVs (`PersonalDetailsCV/`)** — two PDFs: an April 2026 "Software Engineer" (security leaning) CV and a September 2026 "LLM Observability & QA" CV.
- They **conflict on scope**: April says "**Led** a team of 5 developers"; September says "Introduced code reviews and task prioritisation **for** a 5-developer team". April: "Identified and implemented FLS in 50+ vulnerable Apex classes"; September: "Analysed 50+ Apex classes … and implemented FLS". The conflict check (§6.3) must catch exactly this kind of thing, and the writer uses the more conservative wording until Prayush resolves it.
- **Degree** reads "2025 – Present" (April) and "2025 – Nov 2026" (September). Neither reads "(conferral Nov 2026)". Flag on My documents; writer uses "Master of Information Technology, UTS (conferral Nov 2026)" form only once Prayush confirms it in a base CV.
- **Neither CV has a work-rights line.** The app must flag this on My documents; generated CVs can't include it until a base CV states it (never invented).
- April profile contains "**Proven track record**" — a banned phrase. Banned-word checks apply to *output*; base docs get an informational warning only.
- Both use a role-specific headline under the name ("Software Engineer", "Software Engineer Intern – LLM Observability & Quality Assurance"). The headline must be regenerated per job and is a template-leakage risk.
- "3+ years" appears in both summaries (ComplianceQuest Mar 2022–Dec 2024 ≈ 2y10m, plus internships). Consistent across bases, so the writer keeps "3+ years" exactly; it must not drift.
- Layout uses right-aligned dates on the same line as the title; PDF text extraction must keep title/date association correct.

**Base cover letter (`PersonalDetailsCoverLetter/`)** — one PDF, written for Decode Global (IT Intern, addressed to "Ms. Li").
- Contains previous-target details (company, addressee, role) — the leakage check must specifically catch "Decode Global" and "Ms. Li" in any output.
- Contains banned phrasing: "leveraging", "fast-paced environment", "express my interest". It's a tone sample only; these must not be copied.
- Address differs from CVs (Macquarie Park vs Sydney, NSW) and email is capitalised differently. Builder's call which contact block the cover letter uses; must be consistent with the CV for that job.

## 7. Screens

### 7.1 Main screen (Jobs)
- Grid of job cards: title, company, short description, status, match score. Sorted by match score (unscored at the end — builder's call).
- Status filter chips with counts; search box.
- Cards with status New show a Generate button.
- Card warnings (missing URL, generation failed).

### 7.2 Job page
- Header: title · company. Status dropdown. **Open job posting ↗**. Download CV (DOCX/PDF). Download cover letter (DOCX/PDF).
- Base CV dropdown and Template dropdown, each with Claude's reason.
- Full job description, with keywords covered by the CV highlighted.
- Tabs: CV · Cover letter · **Diff vs base CV** (shows exactly what was changed or emphasised).
- Editable preview that looks like the downloaded file.
- Reasons panel: match score and its explanation; keyword coverage and what's missing and why; each major change and why; stretches flagged; reviewer verdict, rounds taken, anything unresolved; code-check results.
- Instruction box + Regenerate.
- Version history (label, time, instruction); switch to / restore an older version.

### 7.3 My documents
- Base documents live in two folders Prayush created: **`PersonalDetailsCV/`** (base CVs) and **`PersonalDetailsCoverLetter/`** (base cover letters), paths configurable like the job folder. The app reads these folders; uploading/replacing/deleting on this page writes to them.
- Each base CV is labelled with the kind of role it's for. Files have no labels today, so *(Claude's call)* Claude suggests a label when a file is first seen (e.g. "LLM / QA", "Software engineering / cybersecurity") and Prayush can edit it.
- Warnings for facts that conflict between base CVs; missing work-rights line.
- Every generated version records which base document (and its version) it came from.

### 7.4 Settings (minimal)
- Job-listing folder path. API key (stored server-side, never in the browser). Model IDs. Review round limit. Banned-word and tech-casing lists.

Visual mockups from brainstorming: `.superpowers/brainstorm/*/content/job-cards-v2.html` (not committed; reference only).

## 8. Data (shape, not schema)

Entities: **User** (one row: Prayush), **Job** (source, source ref, URL, raw JD, extracted title/company/short desc, status, status history, warnings), **BaseDocument** (kind CV/cover letter, role label, original file, extracted text/structure, version), **Template**, **GenerationVersion** (job, base docs used, template, structured CV, structured cover letter, reasons, match score + explanation, reviewer rounds and verdicts, code-check results, instruction, manual-edit flag, created at), **CostLog** (per Claude call: model, tokens, cost, version).

Every row that belongs to a person carries a **user/owner id** from day one (§9).

## 9. Future-proofing (build the seams now, not the features)

Prayush asked which parts would change significantly with RSS, hosting and multi-user. Agreed to prepare these five, cheaply:

1. **Job source** — folder watcher becomes RSS. *Now:* every source converts input into the same standard Job record (title, company, description, URL, source, source ref). Nothing downstream knows where a job came from.
2. **Multi-user** — biggest change. *Now:* owner id on every user-owned record; one hard-coded user. No login built.
3. **File storage** — local folder becomes cloud storage. *Now:* all file read/write goes through one module.
4. **Security** — UI → n8n calls are open locally; online they need auth. *Now:* the UI makes all backend calls through one API client module; n8n endpoints are grouped so auth can be added in one place.
5. **API cost per user** — *Now:* log cost per Claude call per generation (CostLog).

**Unaffected** by the future work: generation, reasons, reviewer loop, match scoring, templates.

## 10. Left to the builder

- Exact n8n workflow breakdown and test approach (within the "Claude writes them as JSON in the repo" decision in §5).
- DOCX/PDF parsing and rendering libraries (e.g. mammoth, docx, LibreOffice/Gotenberg) and whether they live in n8n Code nodes or a sidecar container.
- Database schema and migrations.
- Prompt wording for writer and reviewer (must encode §2 anti-goals and §6.4 checklist).
- Structured CV/cover letter format and the Standard ATS template design (single column, standard section headings, one font family).
- UI component library and styling; editor approach for the editable preview.
- Spell-check approach for AU English.
- Exact status list and transitions.
- Error handling for API failures, timeouts and rate limits, with visible errors in the UI.
