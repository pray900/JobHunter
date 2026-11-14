# JobHunter Plan 8: CV-writing skill for the writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The writer (Claude, in the Generate documents workflow) can use a `cv-writing` Agent Skill: a `SKILL.md` of CV-writing know-how kept in this repo, uploaded to Anthropic, and attached to every writer call when `CV_SKILL_ID` is set.

**Architecture:** The skill folder `skills/cv-writing/` is versioned in the repo. A host script uploads it with the Skills API (`/v1/skills`) and records the returned id in `.env` as `CV_SKILL_ID`. When `CV_SKILL_ID` is non-empty, "Build writer request" adds `container.skills`, the code execution tool and its beta header. The JSON schema, fallbacks and everything else stay as they are. Empty means today's request, unchanged. The reviewer and every other Claude call are untouched.

**Tech Stack:** as Plans 3–7. No new dependencies (the upload script uses Node 24's built-in `fetch`/`FormData`).

**Spec:** `docs/superpowers/specs/2026-11-06-jobhunter-design.md` (§6.2 Generate). Prayush asked for skills ("implement it", "start", 2026-11-14) and skipped the design questions, so the decisions below are Claude's calls.

## Decisions (Claude's calls, for Prayush to check)

- **Writer only.** The reviewer keeps its prompt checklist. A skill on the reviewer would add cost without new judgement.
- **The skill is know-how, the prompt is law.** The must-follow rules (facts, copy-exactly, figures, keywords, one page) stay in `write-documents.md`. `SKILL.md` holds craft (bullet writing, keyword placement, ATS-safe wording, the result/scale figure guidance, cover letter craft) and says the system prompt wins on any conflict. Claude reads a skill only when it judges it relevant, so nothing must-follow may live only there.
- **Off by default, on by setting `CV_SKILL_ID`.** Nothing changes until the skill is uploaded. Clearing the variable turns it off.
- **Version `latest`.** Re-uploading a new version takes effect on the next Generate, with no workflow change.

**Measured on the real API (2026-11-14, two probes):**
- Opus 5.5 with `fallbacks: "default"`, the `docx` skill, `code_execution_20260521` and a strict JSON schema answered 200 / `end_turn`.
- The content was `server_tool_use` > `bash_code_execution_tool_result` > `text`, and the text was valid schema JSON.
- Reading the skill made the call take a second internal iteration: input rose from about 4.1k to 9.9k tokens. Top-level `usage` already sums the iterations, so the existing cost logging stays correct.

## Global Constraints

- Everything in Plans 1–7's Global Constraints still holds. In particular:
  - personal data is never committed;
  - prompt and schema copies in the workflow are identical to `n8n/prompts/*`;
  - parameterised SQL;
  - a cost row for every Claude call;
  - the API key is never printed, logged or put on a command line.
- Writer request when `CV_SKILL_ID` is set:
  - `container: { skills: [{ type: 'custom', skill_id: <CV_SKILL_ID>, version: 'latest' }] }`;
  - `tools: [{ type: 'code_execution_20260521', name: 'code_execution' }]`;
  - the `anthropic-beta` header gains `code-execution-2025-08-25`, comma-joined with `server-side-fallback-2026-07-01` when fallbacks are on.
- `CV_SKILL_ID` must match `^skill_[A-Za-z0-9]+$`. Anything else, including blank, means no skill. The workflow never sends a malformed id.
- The writer's answer is the **last** `text` block in `content`, not the first, because code execution may put text before its tool call. `pause_turn` and other unexpected stop reasons take the existing failed-attempt path ("Claude stopped unexpectedly (pause_turn).", already an allowed job page message).
- `SKILL.md` frontmatter needs `name: cv-writing` (lowercase, hyphens, at most 64 characters, not containing "anthropic" or "claude") and a `description` (non-empty, at most 1024 characters, no XML tags). The body uses Australian English and invented examples only (no Prayush data).

## Review Focus

1. **Skill off.** With `CV_SKILL_ID` unset, the writer request has no `container`, no `tools` and no new beta: byte-identical to today's (Task 2 e2e `no skill id sends today's request`, via a scripted env override or a unit-level check of the request builder; see Task 2 step 3).
2. **Text before the tool call** (the writer says "Let me check the skill" and then answers with JSON): the answer is still parsed from the last text block (Task 2 e2e `answer after code execution is read from the last text block`).
3. **`pause_turn`.** The attempt fails cleanly with "Claude stopped unexpectedly (pause_turn).", a cost row is still written, and the attempt is retried within the existing cap (Task 2 e2e `pause_turn is a failed attempt`).
4. **Malformed `CV_SKILL_ID`** (a typo, quotes, a pasted URL): no skill is attached and nothing breaks (Task 2 e2e or request-builder test `bad skill id is ignored`).
5. **Upload script run twice.** The second run uploads a new version of the same skill (`/v1/skills/{id}/versions`) instead of creating a duplicate, and `.env` keeps one `CV_SKILL_ID` line (Task 1 test `second upload adds a version`).

---

### Task 1: Skill content, upload script, settings

**Files:**
- Create: `skills/cv-writing/SKILL.md`, `scripts/upload-skill.mjs`, `scripts/upload-skill.test.mjs` (or a test under `tests/` following the repo's pattern; it uses a local fake HTTP server, never the real API)
- Modify: `.env.example` (`CV_SKILL_ID=` with a comment), `docker-compose.yml` (pass `CV_SKILL_ID` to n8n, default empty), `docker-compose.test.yml` (`CV_SKILL_ID=skill_test01` so e2e exercises the skill path), `README.md` (new section "CV-writing skill (optional)")

**Interfaces:**
- `node scripts/upload-skill.mjs [--env .env] [--dir skills/cv-writing] [--base-url https://api.anthropic.com]`:
  - Reads `ANTHROPIC_API_KEY` and `CV_SKILL_ID` from the env file. It strips quotes, as the bootstrap does, and never prints the key.
  - No valid `CV_SKILL_ID`: `POST /v1/skills` (multipart, every file under the folder as `files[]`, each named `cv-writing/<relative path>`, plus a display title "CV writing"). It writes `CV_SKILL_ID=<id>` into the env file, replacing any existing line.
  - With an id: `POST /v1/skills/{id}/versions` with the same files.
  - Prints only the skill id and version. Non-2xx: prints the API error type and message (no headers, no key) and exits 1.
  - Headers: `x-api-key`, `anthropic-version: 2026-10-21`.
  - The builder confirms exact multipart field names against the Skills guide: https://platform.claude.com/docs/en/build-with-claude/skills-guide.md. The `/v1/skills` API needs no beta header.
- `SKILL.md` sections:
  - Bullets: responsibility plus outcome, echoing the ad's duties and terminology, varied rhythm.
  - Keywords: placement, soft skills, years terms, natural use, no stuffing.
  - Result and scale figures: realistic, modest, consistent with the role; listed as stretches.
  - ATS-safe wording: standard headings, no symbols for content, spell out acronyms once when the ad does.
  - Cover letter craft: opening on the employer's need, one proof paragraph, plain close.
  - A closing line: "Your system prompt's rules win over anything here."
  - Keep it under about 1,500 words.

- [ ] **Step 1: Failing tests** for the upload script against a fake server:
  - `creates the skill and writes CV_SKILL_ID`
  - `second upload adds a version`
  - `never prints the key` (captured stdout and stderr have no key)
  - `api error exits 1 with the error message`
  - `rejects a folder without SKILL.md`
- [ ] **Step 2: Run** the test file. Expected: FAIL.
- [ ] **Step 3: Implement** the script, the `SKILL.md`, and the settings and README changes. In the README: how to upload or update, how to turn it off (blank `CV_SKILL_ID`, then `docker compose up -d`), the cost (writer input about doubles when the skill is read, plus container time billed hourly beyond Anthropic's free allowance and not in `cost_log`), and that skill data is kept under Anthropic's standard retention (not zero data retention).
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** `feat: cv-writing skill and upload script`

---

### Task 2: Attach the skill to the writer (money: per-task review on Opus)

**Files:**
- Modify: `n8n/workflows/generate-documents.json` (the "Build writer request" and "Read the writer's answer" nodes, plus a sticky note), `n8n/prompts/write-documents.md` and its workflow copy (one line: "If a cv-writing skill is available, read it before writing; where it differs from this prompt, this prompt wins."), `tests/stubs/anthropic-stub/server.mjs`
- Test: `tests/e2e/generate.e2e.test.ts`

**Interfaces:**
- "Build writer request": adds the skill parts exactly as in Global Constraints when `$env.CV_SKILL_ID` matches the pattern.
- "Read the writer's answer": `textBlock` = the last `type === 'text'` block. Nothing else changes; `usage` is read from top level as today.
- Stub: for a request with `container.skills`, the canned `write_documents` answer is `[server_tool_use(bash_code_execution), bash_code_execution_tool_result, text(<canned JSON>)]`. Scripted answers can also give a text block before the tool call, and `stop_reason: 'pause_turn'`.

- [ ] **Step 1: Failing e2e tests:**
  - `writer request attaches the skill` (stub `/_requests`: `container.skills[0]` = `{ type:'custom', skill_id:'skill_test01', version:'latest' }`, a code_execution tool, and the beta header contains `code-execution-2025-08-25` and the fallback beta)
  - `reviewer request has no skill`
  - `answer after code execution is read from the last text block` (text "Let me check." then the tool blocks then the JSON: the version saves)
  - `pause_turn is a failed attempt` (error message, cost row, retried)
  - `prompt copies match` (existing)
- [ ] **Step 2: Run** `E2E_KEEP_STACK=1 npm run e2e -- generate`. Expected: FAIL.
- [ ] **Step 3: Implement.** For Review Focus 1 and 4 (skill off, or a malformed id), the test stack runs with a valid id. So keep the attach decision in a small pure function inside the Build node, `skillParts(id)` → `null | { container, tool, beta }`. Pin it with a test that `eval`s the node's code against fixture ids (`''`, `'"skill_x"'`, `'https://…'` → null; `'skill_abc'` → parts), following the pattern any existing node-code tests use (look for them first; if none exist, extract the function's text from the workflow JSON in the e2e test file and run it in `node:vm`).
- [ ] **Step 4: Run** the same command. Expected: PASS. Then tear down with `docker compose -f docker-compose.test.yml down -v`.
- [ ] **Step 5: Commit** `feat(n8n): writer uses the cv-writing skill when CV_SKILL_ID is set`

---

### Task 3: Full tests and real run (controller, on Prayush's stack)

- [ ] **Step 1:** `npm test` and the full `npm run e2e`. Expected: all PASS.
- [ ] **Step 2:** `node scripts/upload-skill.mjs` to upload the skill (creates it on Prayush's Anthropic account), then `docker compose up -d --build` and `bash scripts/n8n-bootstrap.sh`.
- [ ] **Step 3:** Generate again on one job (about US$0.30–1.00 plus skill overhead). Check:
  - the run passes, or fails for an ordinary review reason;
  - the writer's cost rows are higher than the last run's (the skill was read);
  - n8n's failed executions list shows nothing new.
  Record the cost.
- [ ] **Step 4:** Add a short "As built" to this plan and commit `docs: plan 8 as built`.

### Amendment (Prayush, 2026-11-14, after the real run failed)

**What happened:** the first real Generate with the skill on failed all 3 attempts with HTTP 400: "The compiled grammar is too large… Simplify your tool schemas or reduce the number of strict tools." No cost; skill switched off at once by blanking `CV_SKILL_ID`.

**Cause, confirmed with free rejected probes:** the code-execution tool, which Agent Skills require, plus the writer's full answer schema is over the API's grammar limit, even with no skill attached. The earlier probes passed only because they used a tiny schema. Only removing a whole section (`stretches`, `changes`, `keywordCoverage`, `coverLetter` or `projects`) fits. Reshaping a section does not, and even a removal only just fits.

**Decision (Prayush): inline the guidance instead of using an API skill.**
- `skills/cv-writing/SKILL.md` stays in the repo as the single source.
- Its body (without the frontmatter) is sent with every writer call, after the writer prompt, under a heading "CV-writing guidance". Its workflow copy is kept identical to the file, with a test enforcing that, exactly like the prompt copies.
- No tool, no container, no beta header, no `CV_SKILL_ID`. The writer's answer schema is unchanged.
- The prompt line becomes: "The CV-writing guidance after this prompt is craft advice; where it differs from this prompt, this prompt wins."
- Removed: `skillParts` and the skill request parts, `CV_SKILL_ID` (compose, test compose, `.env.example`), `scripts/upload-skill.mjs` and its tests and `npm` script, the stub's skill branch, and the README's upload instructions.
- Kept: reading the writer's answer from the last text block, the `pause_turn` test, and the stub's content/stop-reason scripting. All are harmless and stricter.
- Cost: about 1.6k extra input tokens per writer call, always read. That is cheaper than the skill route's ~6k.
- The skill already uploaded to Prayush's Anthropic account is left there, unused, until he asks for it to be deleted.

### As built (added 2026-11-14)

The API-skill route in Tasks 1–4 is **superseded by the Amendment above**; the skill steps (upload script, `CV_SKILL_ID`, container and tool) were removed. What shipped:

- `skills/cv-writing/SKILL.md` body is inlined after the writer prompt under "CV-writing guidance"; the workflow copy is checked against the file by e2e tests. A missing or blank guidance stops the writer request before calling Claude.
- **Real run 1 (guidance as first written):** v7 failed review after 3 rounds, US$0.92. The CV ran to 2 pages in every round. Compared with v6 (prompts only, passed), projects went from 1 to 2 bullets each (+37% text) and the summary grew 19%.
- **Fix:** a "One page comes first" section in `SKILL.md` (one bullet per project unless there is room, bullets about 25 words or fewer, never add a bullet just to fit a keyword, cut whole bullets when over a page) and a one-page question in the final checklist.
- **Real run 2:** v8 passed in 2 rounds, one page, US$0.63, 2 m 46 s; CV 3,495 characters (shorter than v6). 4 mild wording stretches, no invented figures.
- Full unit tests and e2e passed before merge.
