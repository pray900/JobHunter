# Claim limit report

## Changes
- n8n/workflows/job-match-scoring.json: "Claim jobs to score" subquery now has `order by j.created_at, j.id limit 10` before `for update of j skip locked`; sticky note updated.
- n8n/workflows/job-intake-sync.json: "Claim pending extractions" subquery now has `order by created_at, id limit 10` before `for update skip locked`; sticky note updated.
- Comments use no `$N` (plain text only); queries stay parameterised.

## Tests (tests/e2e)
- scoring: 12 pending jobs + CV ready -> first run 10 score requests (the 10 oldest done), second run total 12 (remaining 2); claim query contains `order by ... limit 10`.
- intake: 12 new files -> first sync 10 extract requests, second sync 12 total; claim query contains `order by ... limit 10`.

## RED
`npm run e2e -- intake scoring` before the workflow change: 4 failed (both behavioural: "expected [..] to have a length of 10 but got 12"; both definition tests: regex did not match).

## GREEN
`npm run e2e` after: Test Files 10 passed, Tests 161 passed. Test stack torn down.
