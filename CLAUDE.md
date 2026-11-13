# Workflow

- Superpowers is the primary workflow (brainstorm → plan → TDD → execute).
- Matt Pocock skills are review-only and run manually by me:
  - /grill-with-docs after a plan is written
  - /code-review after a feature is finished
  - /improve-codebase-architecture every few features
- If a review conflicts with the Superpowers plan, stop and ask me. Do not resolve it yourself.

## Agent skills

### Issue tracker

Issues are local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

# UI

- Use the frontend-design skill for all UI work.
- Style: clean, minimal productivity tool (think Linear / Notion). Calm, focused, fast to scan.
- Theme: support light and dark mode; dark as default.
- Colour: neutral greys for most of the UI, one accent colour (bluegreen) for primary actions and focus.
- Status colours, used consistently everywhere:
  - New / to review: blue
  - Approved / applied: green
  - Interview: purple
  - Rejected / skipped: muted grey
  - Needs attention / error: amber
- Typography: one clean sans-serif (Inter); clear size hierarchy; no decorative fonts.
- Layout: sidebar navigation, generous spacing, content in cards or tables.
  Job lists should be dense enough to scan many at once.
- Review screens: show the job description and the tailored CV/cover letter side by side,
  with clear Approve / Edit / Skip buttons.
- Interaction: subtle hover and focus states, no heavy animations.
  Keyboard shortcuts for review actions (e.g. A = approve, S = skip).
- Accessibility: good contrast, visible focus outlines, don't rely on colour alone
  (pair status colours with labels or icons).
