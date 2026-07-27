# Make-safe cap-5 timeout root cause, 2026-07-21

Structured evidence:

`docs/evidence/makesafe-cap5-timeout-root-cause-2026-07-21.json`

Production remained on `legacy` throughout diagnosis and implementation.

## 1. Data safety and explicit recovery

The three timed-out cap-5 requests each persisted one 250-row sweep-page cursor
before the request completed:

| Request | Persisted cursor | Rows in page |
|---|---:|---:|
| 11:57 | 2026-06-05 05:36:24Z | 250 |
| 11:59 | 2026-06-18 07:41:01Z | 250 |
| 12:01 | 2026-06-29 03:44:47Z | 250 |

The 60-day live window contained 1,339 eligible email rows. Exactly 750 were behind
the final timeout cursor and 589 were after it. The timed-out runs did not update
deterministic health or business counts, so the 750 rows cannot be claimed as
completed accounting merely because they were read.

This was delayed coverage, not proven permanent loss. The tuple sweep eventually
reaches the tail and resets to the window head. However, relying on eventual cycling
would leave those rows delayed and would not prove completion of the aborted pages.
While `intake_mode=legacy`, the dedicated live deterministic cursor and post-id
tie-breaker were therefore explicitly reset to null. No case, source, artifact, draft,
job or email business row was changed. The next deterministic run must start at the
window head and reread all three pages.

## 2. Why cap 5 crossed five seconds

The scheduled chain was:

1. `pg_cron` calls `trigger_monitor_ses_makesafes()` every two minutes.
2. The trigger uses `pg_net` to call `monitor-ses-makesafes` with a fixed 5,000 ms
   request timeout.
3. After mail sync, `monitor-ses-makesafes` awaited a nested
   `ops-api?action=scan_ses_makesafes` fetch before returning to `pg_net`.

The deterministic source read and plan are fixed at 500 rows. Case persistence is
sequential and grows with the configured 1..10 case cap. Cap-2 scheduled scans wrote
completed health 1.750 and 2.131 seconds after their schedule boundaries. At cap 5,
the additional case persistence pushed the awaited nested scan beyond five seconds.
All three `pg_net` requests timed out at 5,000 ms. The caller disconnect cancelled the
request chain before deterministic health completed.

A second fault turned cancellation into unsafe progress: the deterministic cursor was
persisted immediately after the source read, before planning, case accounting and
health. The cursor therefore described rows read into an interrupted invocation, not
a completed page.

## 3. Fix design

The fix deliberately does not raise the timeout. A larger fixed timeout would only
move the failure threshold and continue coupling scheduler liveness to case-batch
cost.

### Bounded asynchronous continuation

`monitor-ses-makesafes` now registers the nested ops scan with
`EdgeRuntime.waitUntil` and returns the mail-sync response immediately. The outer
`pg_net` request is no longer held open for the deterministic batch. The continuation
is still bounded by the deterministic runtime's source cap, 1..10 committed-case
cap and attempt ceiling. The current standing entry point passes four sources per
invocation; the 500-row value described above was the pre-repair incident state.

The existing 10-minute mailbox lease is transferred to the continuation and released
only after the nested scan settles. A later two-minute poll exits cleanly as locked
instead of starting an overlapping scan. If `EdgeRuntime.waitUntil` is unavailable,
the already-committed mail poll stays successful, logs the deferred scan, and releases
the lease normally so the next poll retries.

### Completion checkpoint cursor

The deterministic sweep cursor is now committed only after the run has:

1. completed planning and case attempts
2. written truthful deterministic health
3. recorded any write or lineage failure in degraded health and report caveats

A dry observation commits only after its complete report. A completed cap-exposed
no-op also commits. A stale/rejected configuration, thrown request or cancelled
request never reaches the checkpoint and retains the prior cursor for immediate
idempotent reread. A completed degraded run advances with
`scan_page_completed_degraded_retry_next_sweep`: its failure is loud, and the bounded
sweep retries it after returning to the window head instead of letting one poison
case pin all older pages.

This changes the cursor from a read-ahead marker to a completion checkpoint without
sacrificing bounded sweep progress.

## 4. Test boundary

Live-shaped tests cover both halves of the incident:

- a simulated nested scan that remains pending beyond the scheduler boundary is
  registered as a continuation while scheduling returns immediately
- the continuation receives the same POST contract and completes after the delayed
  scan resolves
- a capped source page followed by a rejected exact source does not create or advance
  a cursor
- a completed run with case write failures reports
  `scan_page_completed_degraded_retry_next_sweep`, commits only after degraded health,
  and preserves bounded sweep progress
- the continuation owns the existing mailbox lease until settlement, preventing the
  next poll from launching an overlapping batch
- successful bounded sweeps still advance and reset across the full window

The full deterministic suite must pass before `/no-mistakes`, merge and canonical
production deploy. Re-climbing starts from the explicitly reset window head and cap 1.
