# Make-safe deterministic intake full-live evidence, 2026-07-21

Structured evidence:

`docs/evidence/makesafe-deterministic-full-live-2026-07-21.json`

## Final state

Deterministic make-safe intake is fully live in production:

- `intake_mode=deterministic`
- `deterministic_selection_mode=full_open`
- maximum contract cap 10
- both exact allowlists empty
- zero AI calls

Canonical `main` commit `e114a427` is deployed as `ops-api` v860. Active-key smoke
passed 9/9 before activation.

## Clean ladder

Scheduled scans completed cleanly at caps 1, 2 and 5. Each wrote health `ok`, zero
model calls, zero insert-conflict/drop counters and no artifact, draft or job. Cap 5
also returned nested HTTP 200, proving the timeout and long-filter fixes on the prior
failure boundary.

Cap 10 was activated at `2026-07-21T14:23:30.919404Z`. Nine consecutive scheduled
cap-10 scans were observed through `14:41:02.094Z`:

- nine nested HTTP 200 responses
- zero nested non-200 responses
- zero ops-api errors or continuation 500 logs
- final health `ok`
- zero AI calls
- zero new artifacts, deterministic drafts or jobs
- mailbox lease released after every completed scan

The cap-10 window created 87 append-only, side-effect-suppressed canonical cases and
no jobs. The full activation window ended with 128 cases, 257 sources, four historical
artifacts, two historical deterministic drafts and zero case-linked jobs.

## Authority and reversal

The full-live authority was recorded by the captain's standing order. The prepared
reversal remains one settings-row update to `intake_mode=legacy`; canonical cases and
sources remain append-only evidence and must not be deleted.
