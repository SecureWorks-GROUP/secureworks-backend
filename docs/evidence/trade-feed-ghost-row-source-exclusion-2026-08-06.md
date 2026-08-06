# my_jobs applies the calendar_events ghost-row rule at source

Bug, authority level 2, authorized by Captain Shaun 2026-08-04. Backend half of
the Trade App stale-schedule defect; the client half and the full diagnosis with
live row evidence live in secureworks-ux
`docs/evidence/fencing-board-stale-schedule-2026-08-04/README.md` (branch
`fm/trade-board-stale-schedule`, merged).

## Defect

A ghost `role:'observer'` assignment row (`job_assignments.is_ghost = true`)
mirrors a job onto an ops manager's own list and is never moved when the crew's
real row is rescheduled, so it keeps the job's old `scheduled_date` and no
`start_time`. Both calendars read the `calendar_events` view, which is defined
`WHERE ja.is_ghost = false`, so neither ever sees one. `myJobs()` selected
`job_assignments` raw — the one schedule surface that never learned the rule —
so any consumer deduping to one row per job could pick the ghost's staler date.
Captain-reported 2026-08-04 on the Trade App fencing board (SWF-26813,
SWF-261042 stale vs SWF-26972 agreeing-by-tie).

## Fix

`.eq('is_ghost', false)` — the view's own predicate, verbatim, no broader
filter — on every `job_assignments` read whose rows can reach the my_jobs feed:

- the dispatcher full-range (showAll) pages,
- the manager rolling-vertical query,
- the manager fencing full-range pages,
- the personal own-rows query,
- the personal/manager make-safe backstop,
- the pool occupancy probe (`fetchOccupyingAssignments`), whose winning row is
  emitted verbatim by `occupiedPoolAssignmentCard` — on the personal lens the
  probe PREFERS the viewer's own row, so the ops manager's stale ghost would
  otherwise beat the crew row and become their card.

Constants `GHOST_EXCLUDED_COLUMN` / `GHOST_EXCLUDED_VALUE` plus the GHOST ROWS
note sit above the occupancy-probe select in `supabase/functions/ops-api/index.ts`.

## Live verification (read-only SELECTs, 2026-08-06, project kevgrhcjxspbxgovpmfl)

- `pg_get_viewdef('public.calendar_events')` contains `is_ghost = false`, and
  `job_assignments.is_ghost` is `boolean NOT NULL DEFAULT false` — so
  `.eq('is_ghost', false)` is exactly the view's predicate with no NULL third
  case.
- The full live divergence set (jobs with a non-cancelled ghost row dated
  earlier than the earliest crew row, plus the three screenshotted fencing
  jobs): fencing SWF-26813, SWF-261042, SWF-26317, SWF-26535, SWF-26972 (tie
  control) and patio SWP-26257, SWP-26328, SWP-26359, SWP-26372. For every one,
  the post-rule row set (non-ghost, non-cancelled) is exactly the row set
  `calendar_events` publishes — counts agree job by job, and every job keeps at
  least one real crew row, so no card disappears.
- 0 jobs are held ONLY by ghost rows (bool_and(is_ghost) over non-cancelled
  rows per job), so the occupancy-probe filter flips no job's
  occupied/available verdict.
- `is_ghost = true` ↔ `role = 'observer'` remains biconditional across the
  whole table: 119 ghost rows, all observer; 0 non-ghost observer rows (matches
  the 2026-08-04 diagnosis exactly; no drift since).
- Ghost-row owners: one ops_manager (118 rows) who holds the Everyone lens —
  where the crew's real rows already appear — and one lead_installer (1 live
  row), who loses that single watcher card from the Mine feed. No code consumer
  reads observer rows on purpose: the ux fencing board drops them at intake
  (`scripts/test-fencing-board-ghost-rows.js` pins that), and the ux
  diagnosis's "Not fixed here" section requested exactly this backend change.

## Regression test

`supabase/functions/ops-api/myjobs_ghost_rows_test.ts` — five tests, verified
failing (5/5) with the filter reverted and passing with it applied:

- dispatcher / fencing-manager / personal feeds return exactly the
  calendar_events-visible rows for the SWF-26813 repro shape;
- the occupancy probe cannot hand a job to a ghost row even on the
  own-row-preferring personal lens;
- a structural sweep requires `.eq('is_ghost', false)` on EVERY
  `job_assignments` query issued by every myJobs branch and the probe, so a
  read added later without the rule fails loudly.

`myjobs_manager_scope_test.ts`'s two minimal occupancy-probe mocks gained an
inert `eq` chain method to accept the new filter.

## Validation gate

- Repo/branch: secureworks-backend `fm/trade-board-stale-schedule-backend-source-fix`.
- Changed: `supabase/functions/ops-api/index.ts` (six read-path filters + GHOST
  ROWS note), `myjobs_ghost_rows_test.ts` (new),
  `myjobs_manager_scope_test.ts` (mock `eq` stubs), this note, CLAUDE.md/AGENTS.md
  pointer.
- Ran: full ops-api suite — 2978 passed, 18 failed, all 18 reproduced as
  pre-existing on the unfixed baseline (dominated by `makesafe_resume_phase1b`
  et al., plus the documented no-`--allow-run` budget tests); the new file both
  directions as above. `deno check` on index.ts reports one PRE-EXISTING
  TS2769 under local deno 2.9.2 (`body: pdfBytes` at a fetch call, newer
  Uint8Array typings) that reproduces on clean HEAD and does not fail CI's
  deno v2.x (ops-api PRs passed CI the same day).
- Not tested: no deployed-app click-through (no live writes permitted; nothing
  is deployed from this branch).
- Live state: PR-only. **Merging auto-deploys ops-api to production.**
