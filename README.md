# JobHunter

**A personal job-hunting assistant.** Drop in job ads; JobHunter scores each one against your CV, then writes a tailored, ATS-friendly CV and cover letter for the jobs you pick. A second AI reviewer and a set of code checks review every draft before you see it, and nothing is ever invented: every fact comes from your own base CV.

**Live demo:** https://prayush.tailf0cd99.ts.net. It runs on my own PC, so it is only online while that PC is on.

## Why I built it

Tailoring a CV for every application takes a long time, and a plain AI chat gets it subtly wrong. It invents results, overstates your role, misses the ad's exact keywords and forgets the rules for Australian Government applications. JobHunter turns that one-off chat into a repeatable pipeline with guard rails:

- **Honesty first.** Your base CV is the only source of facts. Code checks catch numbers, skills, dates or employers that aren't in it, and anything close to the line (an estimated result figure, an inferred soft skill) is listed as a *stretch* for you to decide on.
- **A writer and a separate reviewer.** One Claude call writes the documents. Another judges them like a strict recruiter against 15 criteria: relevance, inflated claims, AI-sounding text, keyword stuffing, STAR bullets, selection criteria and more. Failed drafts go back with specific objections, for up to 3 rounds.
- **Keywords the way scanners count them.** It uses the ad's exact wording for hard and soft skills and states the job title once, which is what tools like Jobscan look for.
- **You stay in control.** You can edit any version, lock your own wording so the AI copies it word for word, and regenerate with an instruction ("make the summary shorter"). Every version is kept.

## What it does

| | |
| --- | --- |
| **Job board** | Put one Word file per job ad in a folder. Each becomes a card with its title, employer and a short summary, found automatically every 30 seconds. |
| **Match score** | Every job gets a 0–100 fit score against your CV, with a "Why this score?" explanation, sorted best match first. |
| **My documents** | Upload your base CV and cover letter (PDF or Word). Claude reads them into structured facts, which you can view and correct. |
| **Generate** | Tailored CV and cover letter, as Word and PDF. There are two templates: **Standard ATS** (one page) and **Australian Government** (two pages, with selection-criteria coverage, competency statements and key achievements). |
| **Review screen** | The job ad sits next to the tailored documents, with the reasons for every change, the reviewer's verdict, the stretches and a diff against your base CV. |
| **Versions** | Edit, regenerate with an instruction, restore and download any version. Nothing is overwritten. |
| **Tracking** | Statuses New → CV ready → Applied → Interviewing → Closed, with keyboard shortcuts (A = applied, S = skip, E = edit, G = regenerate). |
| **Cost log** | Every Claude call is priced and logged per job and per run. |

## How it works

```mermaid
flowchart LR
    A[Job ad .docx files] -->|every 30 s| B[Worker: read files]
    B --> C[n8n: Job intake<br/>Claude Haiku extracts details]
    D[Your base CV and letter] --> E[n8n: Base documents<br/>Claude Opus reads facts]
    C --> F[n8n: Match scoring<br/>Claude Sonnet]
    E --> F
    F --> G[Web app: job board]
    G -->|Generate click| H[Writer: Claude Opus]
    H --> I[Code checks<br/>facts, keywords, page fit, spelling]
    I --> J[Reviewer: Claude<br/>15-point checklist]
    J -->|fail: objections| H
    J -->|pass| K[Word and PDF<br/>via Gotenberg]
    K --> G
```

Five services run in Docker Compose:

- **n8n**: the workflows that glue everything together and call Claude. There are 8 workflows, each laid out in stages with sticky notes so they are easy to read in the editor.
- **Worker**: Node and TypeScript. It reads `.docx` and PDF files, runs the code checks on generated documents, fits the CV to the page limit and renders Word files.
- **Postgres**: jobs, statuses, base documents, every generated version, review results and the cost log.
- **Gotenberg**: converts Word to PDF.
- **Web**: React and TypeScript, served by nginx. It has light and dark mode, dense job lists and keyboard shortcuts.

### Claude models

| Task | Model |
| --- | --- |
| Reading job files | Claude Haiku 5.5 |
| Reading your CV and cover letter | Claude Opus 5.5 |
| Match scoring | Claude Sonnet 5.5 |
| Writing the CV and cover letter | Claude Opus 5.5 |
| Reviewing them | Claude Opus 5.5 (configurable; Sonnet works well) |

Every model is set in `.env`. Answers use structured JSON output, so each response has a fixed shape.

## Tech stack

n8n 2.46 · Node 24 · TypeScript · React · Vite · PostgreSQL 17 · Docker Compose · Gotenberg · `docx` · Anthropic Claude API · Vitest

## Quality

- **Test-driven.** About 460 unit tests (worker and web) and about 420 end-to-end tests. The end-to-end tests run against a separate Docker stack with a fake Anthropic API, so they never use real data or a real key.
- **Prompts are versioned files** (`n8n/prompts/`, `skills/cv-writing/`). The tests check that the copies inside the workflows match them exactly.
- **Security:**
  - every port is bound to `127.0.0.1`;
  - nginx guards against DNS rebinding;
  - webhooks only accept their own origins and a custom header;
  - secrets stay in a git-ignored `.env`;
  - personal files are never committed.
- **Design decisions** are recorded in `docs/superpowers/specs`, the step-by-step build plans in `docs/superpowers/plans`, and the domain words in `GLOSSARY.md`.

## Running it yourself

You need Docker Desktop, Git Bash and an Anthropic API key. The short version:

```bash
cp .env.example .env          # then set ANTHROPIC_API_KEY, POSTGRES_PASSWORD, N8N_ENCRYPTION_KEY
mkdir -p Joblisting           # one .docx per job ad goes here; the first line is the posting link
docker compose up -d --build
bash scripts/n8n-bootstrap.sh # loads credentials and workflows into n8n
```

Open http://localhost:8080 and upload your CV on **My documents**. The full details are below.

A typical Generate costs about US$0.30–0.90, and everything else is cheap or free (see [Cost](#cost)).

---

# Full documentation

JobHunter is a local app. Everything runs on your machine, and the only things that leave it are the job ad text, your CV and your cover letter, which are sent to Claude (see Cost for when).

## Pinned versions

- n8n: `n8nio/n8n:2.46.6` (latest stable on 2026-11-06)
- Postgres: `postgres:17`
- Worker: Node 24
- Job extraction model: `claude-haiku-5-5` (`EXTRACT_MODEL`)
- CV and cover letter reading model: `claude-opus-5-5` (`ANALYSE_MODEL`)
- Match scoring model: `claude-sonnet-5-5` (`SCORE_MODEL`)
- CV and cover letter writer: `claude-opus-5-5` (`WRITER_MODEL`)
- Independent reviewer: `claude-opus-5-5` (`REVIEW_MODEL`); at most `GENERATION_MAX_ROUNDS` (default 3, at most 5) write-and-review rounds per Generate

## Set it up from scratch

You need Docker Desktop (running) and Git Bash. Run every command below from the project folder in Git Bash.

1. Copy the settings file: `cp .env.example .env`
2. Open `.env` and set:
   - `ANTHROPIC_API_KEY` to your key. The other keys (`ANALYSE_MODEL`, `SCORE_MODEL`, `EXTRACT_MODEL`, `JOBLISTING_DIR`) already have working defaults.
   - `POSTGRES_PASSWORD` and `N8N_ENCRYPTION_KEY` to your own random values (replace `change-me`).
   - Leave `N8N_OWNER_EMAIL` and `N8N_OWNER_PASSWORD` empty; the bootstrap fills them in.
3. Create the job folder: `mkdir -p Joblisting` (or the folder you set in `JOBLISTING_DIR`). It must exist before you start the stack; see Where to put job files.
4. Start everything: `docker compose up -d --build`
5. Load the credentials and workflows into n8n: `bash scripts/n8n-bootstrap.sh`

   It creates your n8n login, saves it in `.env` (it only prints "n8n owner login saved in .env"), imports the workflows and publishes them. It is safe to run again, but it resets the shipped workflows to the repo JSON (see Bootstrap below).
6. Open the job board: http://localhost:8080

Until you add job files the board is empty. Open **My documents** (top menu) and upload your CV first; until a CV is read, cards say "Not scored yet".

Every service has `restart: unless-stopped`, so after a reboot Docker Desktop brings the stack back by itself once it starts. If it is not running, start it with `docker compose up -d`.

## Where to put job files

Put one Word file (`.docx`) per job in the `Joblisting/` folder in the project root. To use another folder, set `JOBLISTING_DIR` in `.env` and run `docker compose up -d` again. The worker sees the folder read-only.

The folder must exist before `docker compose up`. The worker mount is declared with `create_host_path: false`, so on a Linux Docker engine a missing folder stops the worker from starting instead of Compose creating an empty one. Docker Desktop on Windows still creates a missing folder for the mount, so there check the path in `JOBLISTING_DIR` yourself: a typo gives you an empty board, not an error.

- The first non-empty line of the file must be the link to the job posting. That becomes the "Open job posting" button on the card.
- The folder is checked every 60 seconds. A new file becomes a card, an edited file is read again, and a deleted or renamed file keeps its card but shows "Source file removed".
- Word's temporary lock files (names starting with `~$`) are ignored.
- If the folder is missing or cannot be read, the sync fails loudly and changes nothing. It never marks jobs as removed because of a broken scan.
- `Joblisting/`, `.env` and the old `PersonalDetailsCV/` / `PersonalDetailsCoverLetter/` folders are git-ignored, so personal data is never committed.

## My documents (your CV and cover letter)

JobHunter uses **one** base CV and **one** base cover letter, and they only come in through the app. Open http://localhost:8080/documents (**My documents** in the top menu). There are two slots, one for the CV and one for the cover letter.

1. Click **Upload CV** (or **Upload cover letter**) in an empty slot and choose a `.pdf` or `.docx` (up to 5 MB). It is read by Claude straight away; the slot shows "Analysing…", then "Ready".
2. To change it, click **Replace** in the slot and confirm in the page. The new file replaces the current one in one step; if the upload fails, the current file stays. Uploading the same file again changes nothing and costs nothing.
3. After reading, each slot shows warnings: **work rights** missing or unclear, **degree status** unclear, and **banned phrases** found in the letter (for example "leveraging", "fast-paced"). A Word file with no text in it shows "Couldn't read this file" and is never sent to Claude.

If reading your CV or letter failed 3 times, uploading it again tries again (about $0.06 for a CV, $0.03 for a letter).

Where the files are kept:

- The worker keeps the uploaded files in its own storage, a Docker volume (`documents_data`, mounted at `/data/documents` inside the worker). Nothing on your disk outside Docker is read or written, and there is no delete: you can only replace a file.
- Uploaded file names are cleaned to letters, digits, space and `. _ ( ) -`.
- `docker compose down` keeps the volume; `docker compose down -v` deletes it together with the database, after which you upload your CV and cover letter again.
- The old `PersonalDetailsCV/` and `PersonalDetailsCoverLetter/` folders are no longer used. JobHunter never reads or changes them; you can delete them yourself. After updating, upload your CV and cover letter once on the My documents page.

### View and correct what was read

Each ready slot has a **View and edit** link. The page shows the original file on the left (a PDF is shown on the page; a Word file gets a **Download original** button) and the facts Claude read from it on the right, with warnings in amber.

- **Edit** (or press **E**) turns the facts into a form where every field can be changed. Lists can add, remove and move items. **Save** stores your corrections. Saving is free and never calls Claude.
- A CV edit re-scores every job once (about US$0.016 each, the same as a new CV). The form shows the total before you save. Saving facts identical to what was read stores no edit and re-scores nothing. Cover letter edits re-score nothing.
- **Undo all edits** goes back to what was read from the file.
- Once edited, the corrected facts are your base CV or cover letter everywhere: scoring, Generate, Regenerate, the edit checks and the Diff vs base CV tab. The original CV file is no longer sent to Claude, so the writer and the reviewer never see two versions.
- Replacing the file drops your edits (the Replace dialog warns you first). Uploading the same file again keeps them. An earlier file uploaded again later comes back without its old edits.
- If the CV changed since the page opened, Save is refused until you reload the page.
- Versions made before a CV edit show "made from an earlier base CV" on their Diff tab until the edit is undone.

## How match scores work

Each job card shows a score from 0 to 100: how well your one base CV fits that job ad, with a **"Why this score?"** explanation (what matched, what is missing). The board sorts best match first.

- A score is recomputed only when your CV changes or the job file changes. Otherwise it is kept and costs nothing.
- Scoring runs every 30 seconds in the "Job match scoring" workflow. Each run scores at most **10 jobs**, and each job intake run reads at most **10 job files**, so a burst (a new CV, many new files) is spread over several runs instead of hitting Anthropic rate limits. The rest wait for the next run.
- A failed score is retried up to 3 times in total (after 1, then 5 minutes).

## Job page: edit, versions, regenerate

Open a job card to see its job ad next to the tailored CV and cover letter. Every change adds a new **version**; nothing is ever overwritten or deleted, and the current version is the newest one.

- **Generate** (or **Generate again**) writes new documents from your base CV, then the code checks and the reviewer judge them (see Cost). Generate again ignores the version on screen and your edits; they stay in the history. To show result or scale, the writer may add realistic figures to experience and project bullets; these are estimates, not marked in the document, and each is listed as a "Stretch — you decide" in the reasons panel so you can check it before an interview. The same goes for the ad's soft-skill keywords ("cross-functional team", "customer-facing", "mentorship"): the writer works them into a bullet or the summary where a role makes them plausible, even if your base CV doesn't say them, and lists each one as a stretch.
- **Edit** (or press **E**) opens the CV and cover letter as a form. Headline, summary, contact details, bullets, skills and the letter can be changed. Name, work rights, role titles, employers, dates and education are copied from your base CV and are read-only (change them there). **Save** adds an "Edited" version. It runs the free code checks again (rules you broke show in amber, and things the reviewer would have ruled on, such as a technology that is not in your base CV, show as "Needs a look"), but not the reviewer (figures you type into experience and project bullets are not checked against your base CV): an edited version says "Not reviewed: your edits came after the review". If a generation finishes while you are editing, your edit is still saved as the newest version and the other one stays in the history. Leaving the page with unsaved edits (a link, reload or closing the tab) asks first.
- **Template**: the job page suggests Standard ATS (one page) or Australian Government (up to two pages, answering the ad's selection criteria inside the CV and cover letter) with a one-line reason; pick another to use it on the next Generate. A Regenerate keeps the version's own template.
- **Version history** lists every version with where it came from (Generated, Regenerated, Edited by you, Restored), when, and its review result. Click one to view it read-only and download its own files (the file name ends in " - v3" and so on). **Restore this version** copies it as a new version.
- **Regenerate with an instruction** (press **G** to jump to the box) asks Claude for a new version of the version on screen, for example "Make the summary shorter". Your manual edits are **kept exactly as you wrote them**: Claude copies them word for word whatever the instruction says, and a check that fails inside your own edit is listed as "Your edit — kept as you asked" (the version is then shown as not passed) instead of being "fixed". Claude never adds facts that are not in your base CV anywhere else, and the code checks and reviewer judge the rest as strictly as any version. A regenerate always uses your current base CV. If it fails, **Try again** repeats the same regenerate (same instruction, same starting version).
- **A** marks the job Applied, **S** skips it (Closed). Shortcuts never fire while you type in a field; the **?** button lists them.

Editing, saving an edit, restoring, viewing versions, the Diff vs base CV tab and downloads are **free** (no Claude call). A Regenerate costs the same as a Generate.

## Open n8n

Go to http://localhost:5678. The login is in `.env`: `N8N_OWNER_EMAIL` and `N8N_OWNER_PASSWORD`. The web page is on port 8080; the worker and Postgres are only reachable inside the Docker network (use `docker compose exec postgres psql -U jobhunter` for the database).

In the left menu click **Workflows**, then open one. Each workflow has coloured sticky notes (`## 1. ...`, `## 2. ...`) that group the nodes into stages. Read them left to right. To see what a run did, open **Executions** in the workflow and click a run; each node shows the data it received and produced.

The shipped workflows **don't save successful runs** (workflow settings `saveDataSuccessExecution: none`, `saveManualExecutions: false`), so the execution list only shows failed runs and the database doesn't fill up with a run every 30 seconds. While learning, switch it on per workflow: open the workflow, **⋯ → Settings**, set **Save successful production executions** to *Save* (and **Save manual executions** to *Save*), then save. You will then see every run under **Executions**. Re-running the bootstrap resets it.
## Reading the workflows in n8n

There are eight shipped workflows: Job intake sync, Jobs API, Base documents sync (reads your CV and cover letter), Documents API (serves and changes the My documents page, reads and saves your corrections to the base CV and cover letter, and serves the original file), Job match scoring, Generate documents (writes, checks and reviews a tailored CV and cover letter after a Generate or Regenerate click), Job page API (the job page: details, status, notes, downloads, and queueing Generate / Regenerate) and Versions API (version history, saving an edit, restoring a version; never calls Claude). The first two are described step by step below; open the others in n8n and read their sticky notes the same way.

### Job intake sync

Runs every 30 seconds and also when the web page or a test calls `POST /webhook/api/jobs/sync`.

- **Start**: the "Every 30 seconds" schedule (switched off when `JOBHUNTER_SCHEDULE_ENABLED` is `false`, as in the test stack) or the webhook.
- **Header check** (webhook only): `POST /webhook/api/jobs/sync` must send the header `X-JobHunter: 1` (the web app always does), otherwise it answers `403 {"error":"missing_jobhunter_header"}` and nothing runs. This stops other websites triggering a sync from your browser with a plain cross-site POST, which CORS alone does not block. Call it yourself with `curl -X POST -H 'X-JobHunter: 1' http://localhost:5678/webhook/api/jobs/sync`.
- **1. Scan folder**: asks the worker to read every `.docx`. If the scan fails, the run answers 502 and stops with no changes.
- **2. Upsert jobs**: one query per file. New file: insert the job and its first status. Known file: refresh the text and link, and only if the content changed reset the extraction. Unreadable or empty files are marked `skipped` and never sent to Claude.
- **3. Mark removed files**: jobs whose file is gone get `source_removed = true`. The job itself is kept.
- **4. Claim pending extractions**: gives up on claims stuck for over 5 minutes, checks `EXTRACT_MODEL` has a known price (stops before spending anything if not), then claims the jobs to extract (new or changed, or failed with fewer than 3 attempts once they have waited 1 minute after the first attempt or 5 minutes after the second, so a short outage does not use up all 3 attempts).
- **5. Ask Claude**: one call per claimed job, using structured output so the answer is always title, employer, advertiser and short description.
- **6. Save details or failure**: a good answer is saved and the job is `done`; anything else is `failed` and retried (after 1, then 5 minutes) up to 3 attempts in total. Token cost is logged in `cost_log`. Saves only apply if the job still holds this run's claim.
- **Finish**: waits for all branches and answers the webhook with `{ ok, scanned, extracted }`.

### Jobs API

Serves the job board.

- **Start**: `GET /webhook/api/jobs`, called by the web page.
- **1. Read the job list**: one SQL query returns the whole list as a JSON array, so an empty table gives `[]`. Best match first, unscored jobs last, newest first on ties.
- **2. Reply**: answers `200 { jobs: [...] }`.

Both of these webhooks ("GET api/jobs" here and "POST api/jobs/sync" in Job intake sync) set **Allowed Origins (CORS)** to `http://localhost:8080,http://localhost:5173` (the board and the Vite dev server), so other websites you visit cannot read your jobs through your browser. nginx also strips n8n's CORS headers from `/api/`, since the board calls it from its own origin.

## Cost

Real costs measured on 2026-11-07, in US dollars (Anthropic bills in US$):

| What | Model | Cost | When |
| --- | --- | --- | --- |
| Reading your CV | Opus 5.5 | about US$0.06 | only when you upload a new or changed CV |
| Reading your cover letter | Opus 5.5 | about US$0.03 | only when you upload a new or changed letter |
| Scoring one job | Sonnet 5.5 | about US$0.016 | when the job or your CV changes |
| Reading one job file | Haiku 5.5 | about US$0.0003 | new or changed job file (and retries) |
| Writing a CV and cover letter (one round) | Opus 5.5 | about US$0.15 (measured on a real run, 2026-11-08) | only after you click Generate |
| Reviewing them (one round) | Opus 5.5 | about US$0.14 (measured on a real run, 2026-11-08) | once per writing round |
| Regenerate with an instruction | Opus 5.5 | the same as Generate (about US$0.30–0.90) | only after you click Regenerate |
| Edit, save an edit, restore, version history, Diff vs base CV, download | none | free | any time |
| Save a base document edit | none | free (a CV edit re-scores every job once, like a new CV) | after you click Save |

A Generate click costs one round (about US$0.30) when the first draft passes the review, and at most `GENERATION_MAX_ROUNDS` rounds (3: about US$0.90), so about US$0.30–0.90 per click. A failed attempt (an API error, or n8n restarted mid-run) is retried after 1, then 5 minutes, at most 3 attempts, and a retry **continues from the last finished round** (rounds already paid for are kept and count towards `GENERATION_MAX_ROUNDS`). Only the round that was cut off is paid for twice, so the worst case for one click is 2 × (rounds + 2) calls: 10 calls (about US$1.50, at about US$0.15 per call) at 3 rounds, 14 calls (about US$2.10) at the maximum of 5. A round whose documents are malformed is not reviewed, so it costs only the writer call. A Regenerate is a Generate with your instruction and the same limits; when the only problems left are inside your own kept edits, it stops at once instead of paying for rounds that cannot fix them. Nothing is written or reviewed without a click: the "Generate documents" workflow only picks up runs that a Generate click queued, and every call's cost is logged with its job and generation run.

Reading the job folder every 30 seconds costs nothing, and the documents sync only reads your CV and letter after an upload or to retry a failed reading. A new CV re-scores every job once (10 per run). Check the real total any time with `docker compose exec postgres psql -U jobhunter -c "select sum(cost_usd) from cost_log"`.

## PDF and Word output

The worker renders tailored CVs and cover letters with the Standard ATS template (A4, one column, Arial, no tables or text boxes) to Word through the `docx` library. PDFs are made by converting that Word file with Gotenberg (`gotenberg/gotenberg:8.21.1`), a fifth container with no host port and `restart: unless-stopped`. The worker finds it through `GOTENBERG_URL` (default `http://gotenberg:3000`). If Gotenberg is down, the PDF request answers `502 pdf_render_failed` and Word output still works.

**Uploading:** upload the PDF download to job sites; keyword scanners such as Jobscan read PDFs most reliably.

**Header:** the CV header is name, headline, then one contact line: location | email | phone | short links (no `https://`, `www.` or labels) | work rights. The cover letter uses the same line without work rights.

**One-page fit:** the worker tries layouts in order (`LAYOUT_STEPS` in `services/worker/src/templates/layout.ts`) and uses the first that fits one page: 10.5pt with wide margins and normal spacing, then tighter spacing, then narrower margins, then 10pt, and finally 9.5pt (the floor). The writer includes every project, most relevant first, one bullet each. If even the floor does not fit, the check step (`/generation/check`) drops projects from the end of the list (the least relevant) and fits again. It never drops a project that holds a locked manual edit, or any project before one. If nothing fits, the original CV goes back to the writer with the page-limit failure. The check returns the fitted CV and `fit: { step, droppedProjects }`; the workflow uses that CV from then on, and the job page reasons panel shows "Left out to fit one page: <name>". Downloads only re-run the layout steps and never drop projects. The check call has a 180 s timeout. When deploying, update the worker before the workflow.

## CV-writing guidance

`skills/cv-writing/SKILL.md` holds craft advice for the writer: bullets as responsibility plus outcome, keyword placement, how keyword scanners count, ATS-safe wording, result figures and cover letter structure. Its body (without the frontmatter block at the top) is sent with every writer call, after the writer prompt, under the heading "CV-writing guidance". The reviewer never gets it. The writer prompt holds every must-follow rule and says it wins wherever the guidance differs.

- **Edit it:** change `SKILL.md`, then copy its body into the workflow: the `writer_guidance` value in the "Writer and reviewer prompts" node of `n8n/workflows/generate-documents.json` must be identical to the file without its frontmatter (`npm run e2e -- generate` checks this). From the project folder, this updates it:

  ```bash
  node -e "const fs=require('fs');const p='n8n/workflows/generate-documents.json';const w=JSON.parse(fs.readFileSync(p,'utf8'));const g=fs.readFileSync('skills/cv-writing/SKILL.md','utf8').replace(/\r\n/g,'\n').replace(/^---\n[\s\S]*?\n---\n/,'').trim();w.nodes.find((n)=>n.name==='Writer and reviewer prompts').parameters.assignments.assignments.find((a)=>a.name==='writer_guidance').value=g;fs.writeFileSync(p,JSON.stringify(w,null,2)+'\n')"
  ```

  Then run `bash scripts/n8n-bootstrap.sh` to load the workflow into n8n.
- **Cost:** about 1.6k extra input tokens on every writer call.

## Tests

Run the commands from the project folder.

- Unit tests: start the test database with `docker compose -f docker-compose.test.yml up -d postgres`, run `npm install`, then `npm test`. It runs the worker and web tests; the worker tests need that test database (`TEST_DATABASE_URL`, default `postgres://jobhunter:test@localhost:55433/jobhunter`), the web tests alone (`npm test -w apps/web`) need nothing. Stop the database with `docker compose -f docker-compose.test.yml down`.
- End-to-end: `npm run e2e` (needs Docker running; it starts and removes its own separate stack).

The test stack (`docker-compose.test.yml`, project `jobhunter-test`) uses host ports 55433 (postgres), 55678 (n8n), 58080 (web) and 58081 (fake Anthropic), all bound to 127.0.0.1, and `./.tmp/e2e-joblisting` as the job folder; its uploaded documents go to its own volume (`documents_test_data`). It never touches your real data or key.


### End-to-end details

`npm run e2e` brings up the `jobhunter-test` stack (`docker compose -f docker-compose.test.yml up -d --build --wait`), runs `scripts/n8n-bootstrap.sh`, runs `tests/e2e/*.e2e.test.ts`, then tears the stack down (`down -v`). Set `E2E_KEEP_STACK=1` to leave it running while iterating.

The test stack includes `anthropic-stub` (host port 58081), a fake Anthropic Messages API (it also answers the CV, cover letter and scoring requests with canned data) that n8n reaches via `ANTHROPIC_BASE_URL`. It requires `x-api-key` and `anthropic-version: 2026-10-21` (else 400); user text containing `STUB_FAIL` returns 500, `STUB_REFUSE` returns `stop_reason: "refusal"`, anything else returns a canned extraction. `GET /v1/models` (used by the bootstrap key check) answers 200 for any key except `bad-key` (401). `GET /_requests` lists recorded Messages request bodies, `POST /_reset` clears them. Helpers live in `tests/e2e/lib.ts` (`stack`, `writeJobFile`, `removeJobFile`, `triggerSync`, `putDocument` (uploads through the API), `getFacts` / `saveFacts` (read and save base document facts), `storedDocuments`, `db`, `stub`, `api`).

### Bootstrap

`scripts/n8n-bootstrap.sh [compose-file]` (default `docker-compose.yml`; run with bash, Git Bash on Windows is fine) is idempotent. `JOBHUNTER_ENV_FILE` overrides which env file it reads and writes (default `.env` in the project folder). Values in `.env` may be wrapped in one pair of matching quotes (`KEY="value"` or `KEY='value'`); the quotes are stripped. For n8n 2.46.6 it:

1. Waits for `/healthz`.
2. Creates the owner account (n8n 2.x needs an owner to own imported items) after checking `/rest/settings` for setup state; an already-set-up instance is fine, any other failure aborts. Real stack: `N8N_OWNER_EMAIL` / `N8N_OWNER_PASSWORD` come from `.env`; if missing, the script generates a random password (email default `prayush@jobhunter.local`), appends them to the git-ignored `.env` and prints only "n8n owner login saved in .env". Only `docker-compose.test.yml` (detected by file name) uses a fixed throwaway login. The real stack's n8n port is bound to 127.0.0.1.
3. Real stack only: checks `ANTHROPIC_API_KEY` from `.env` with a free `GET /v1/models` request, run inside the n8n container with the key passed over stdin (never on a command line, never printed). A rejected key (401/403) stops with "Your Anthropic API key was rejected — check ANTHROPIC_API_KEY in .env"; a network error or any other status also stops, naming the status. `JOBHUNTER_ANTHROPIC_BASE_URL` overrides the URL checked (the tests point it at the stub).
4. Builds the credentials JSON (`jh-postgres` / "JobHunter Postgres", `jh-anthropic` / "Anthropic") from the postgres container's `POSTGRES_PASSWORD` and `ANTHROPIC_API_KEY` in `.env`, pipes it over stdin to a temp file inside the n8n container, runs `n8n import:credentials --input=/tmp/jh-credentials.json`, then deletes it (a trap also deletes it if the script fails or is interrupted). Fixed ids make re-import an upsert. The test stack always uses a dummy key, never the real one.
5. `n8n import:workflow --separate --input=/workflows` (imported inactive; workflow JSON needs stable `id`s to stay idempotent). Importing a published workflow queues an "unpublish" record holding the old version in n8n's publication outbox; the script waits (up to 120 s, `JOBHUNTER_PUBLISH_WAIT_S` overrides it; normally under 15 s) until the running n8n has processed it. Otherwise n8n would apply that record after the publish below and keep serving the old version.
6. `n8n publish:workflow --id=<id>` for each workflow `id` in `n8n/workflows/*.json` (2.x replaced `update:workflow --active`; `publish:workflow --all` is no longer supported). Workflows you created yourself in n8n are not published or changed.
7. If any shipped workflows exist, restarts the n8n container (publish only takes effect on restart), waits for `/healthz`, waits until n8n's published version of each shipped workflow is the one just imported (read from n8n's SQLite database), then probes every webhook path found in `n8n/workflows/*.json` (with a non-matching HTTP method, so nothing runs) until n8n reports it registered; exits non-zero on timeout. CLI failures abort the script.

After pulling workflow changes, one bootstrap run makes them live. Re-running the bootstrap resets the shipped workflows (all eight) to the JSON in `n8n/workflows/`, so edits you made to them in the n8n editor are overwritten. Export your edits first (in the workflow, **...** > **Download**, or `docker compose exec n8n n8n export:workflow --id=<id>`). Your own workflows are left alone. Workflows removed from `n8n/workflows/` are not deleted from n8n.

## Troubleshooting

- Cards stuck on "Details unavailable" after you fixed `ANTHROPIC_API_KEY` (wrong key, or a key saved with quotes by an older bootstrap): extraction gave up after 3 failed attempts. Re-run `bash scripts/n8n-bootstrap.sh` to load the fixed key, then queue the failed jobs again with `docker compose exec postgres psql -U jobhunter -c "update jobs set extraction_status='pending', extraction_attempts=0 where extraction_status='failed';"`. The next sync (within 30 seconds) retries them.
