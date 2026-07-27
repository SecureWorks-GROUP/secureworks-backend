# SES deterministic scan 546 repair — 2026-07-27

## Contract grounding

Read from the working wiki mirror:

- Section 3, unit **U1 — Run SES ingestion and land data exactly once**
- Checkpoint **CP1 — SES ingestion truth proven**

Contract:
`/Users/marninstobbe/Projects/secureworks-wiki/coding/work/campaigns/makesafe-system/missions/ses-reporting-end-to-end-2026-07/CONTRACT.md`

SHA-256:
`d076dedb8e5c92932ae386084dac256d9bc1c02668acd760b0eaba34aef95d52`

The repair preserves U1's exact-fate rule and CP1's fail-loud requirement. No
production write, deployment, migration, replay, cron change, or intake-mode
change was made while producing this evidence.

## Outcome

The worker was not exhausting memory. Supabase killed it for CPU time.

The standing scan gives the deterministic runtime four physical sources per
invocation. The historical lane remains cursor-backed, while the recent lane is
a newest-first queue of physical sources without a final durable fate (a
canonical case-source row or classifier exclusion). It pages only source
identifiers, fetches full bodies for the two selected recent sources, and keeps
transient exceptions eligible. A fresh source reopening an exception must fit
its persisted authority closure inside the same four-source allowance or is
deferred with a reason-coded outcome.

Fresh-source health is now based on durable coverage rather than function
completion or `last_inbound_email_at`: it degrades when the oldest eligible
unfated source exceeds five minutes. The existing handoff failure path still
degrades `makesafe_intake_health` when a continuation fails.

A non-2xx or network-failed continuation now also degrades
`makesafe_intake_health`. The existing per-source exception rows and aggregate
business event remain, but the supervisor-facing health surface can no longer
stay frozen on an old scan while every continuation dies.

## What consumed the worker

Read-only production evidence was collected through the Supabase Management API
using a browser-like User-Agent.

| Measurement | Observed result |
| --- | --- |
| Failed execution | `b968e14f-5591-4fe0-9e25-0ad13ab40b76`, `ops-api` deployment version 908 |
| Edge response | HTTP 546 after 16,528 ms wall time |
| Shutdown reason | `CPUTime` / `CPU Time exceeded` |
| CPU used at kill | 2,027 ms |
| Memory at kill | 37,657,734 bytes total: 33,439,168 heap + 4,218,566 external |
| Current selected source page | 500 rows, 3,588,201 bytes of email bodies |
| Eligible PDFs on that page | 371 PDFs, 197,490,938 compressed bytes |
| First 50 PDF attempts | 24,145,192 compressed bytes |
| Duplicate work in first 50 | 25 unique stored PDFs, each attempted twice |
| Largest first-50 PDF | 3,748,724 bytes |

The hard limit that killed the invocation was therefore CPU, not heap. The
dominant evidenced work immediately before the kill was downloading and parsing
historical work-order PDFs. The current 500-source page supplies enough eligible
documents to spend the full 50-extraction budget, including duplicated mailbox
copies of the same stored PDFs. This is not a Graph, authentication, credential,
or Anthropic-cap failure.

## The bound

`scanSesMakesafes` now passes `maxSources: 4` to the existing deterministic
runtime. Full-open standing authority requires empty exact allowlists, so no seed
rows can expand this standing page past the cap.

The runtime allows at most two eligible PDFs per source. Four sources therefore
make eight PDF attempts the structural maximum. A read-only simulation across
all 1,155 rows after the stuck cursor measured:

- maximum observed PDF attempts in a simulated four-source run: 6;
- worst downloadable compressed PDF volume in one simulated run: 9,207,260
  bytes;
- largest single eligible PDF: 4,457,298 bytes.

For comparison, the killed 500-source run reached a 50-attempt workload with
24,145,192 compressed bytes before accounting for PDF decompression and text
extraction CPU. The four-source cap is deliberately conservative because the
live limit is a roughly two-second CPU budget, not a wall-clock deadline.

## Durable backlog progress

The deterministic runtime already uses a `(received_at, post_id)` completion
cursor and persists it only after the run completes its writes and health update.
The entry-point repair uses that mechanism rather than introducing a second
checkpoint.

With `maxSources: 4`, the runtime reserves the historical share according to the
existing backlog cursor and uses the remaining allowance for the newest unfated
physical sources. The recent identifier queue skips sources with final fates,
then fetches bodies only for the selected recent rows; the historical lane and
the eight-PDF standing maximum remain unchanged.

At the measured 1,155-row backlog, a complete sweep needs at most 578
invocations. At the existing two-minute cadence that is about 19 hours 16
minutes, assuming runs continue to complete. A killed or rejected run does not
advance the cursor, so its rows are retried rather than silently skipped.

## Failure visibility

The monitor already wrote a reason-coded `email_events_raw` fate for each
included source and a `makesafe.intake.scan_handoff_failed` business event when a
continuation returned non-2xx or failed on the network. That evidence was not on
the supervisor's primary health surface.

The same failure callback now upserts:

- `extraction_status = 'degraded'`;
- `degraded_reason = 'scan_handoff_http_546'` for the observed outage class, or
  the corresponding network/non-2xx reason;
- `degraded_since`, preserving the start of a repeated identical incident;
- `updated_at` for the current failure.

It deliberately does not write `last_scan_at`: a worker killed before returning a
JSON report did not complete a scan. If source-fate, aggregate-alarm, or health
persistence fails, the continuation rejects and the ten-minute mailbox lease is
retained for a loud retry rather than being acknowledged as settled.

At the current two-minute poll cadence, the health degradation is visible after
the first failed continuation instead of after a later manual log investigation.

## Regression proof

Fresh local validation:

```text
deno test --allow-all --no-check \
  supabase/functions/ops-api/makesafe_reporting_intake_pass_test.ts \
  supabase/functions/ops-api/monitor_ses_makesafes_test.ts

80 passed, 0 failed
```

The new tests prove:

1. the standing scan invokes the runtime exactly once with `maxSources: 4` and
   returns the runtime's bounded JSON report; and
2. an HTTP 546 continuation writes the source fate, aggregate alarm, and degraded
   health row without falsely advancing `last_scan_at`; and
3. the production-shaped dual-alias fixture proves final-fate filtering and the
   bounded recent queue, while the migration contract requires
   `20260727020000_makesafe_intake_fresh_source_health.sql` before `ops-api`.

Both edge entry points also pass their required Deno checks:

```text
deno check --config deno.jsonc supabase/functions/ops-api/index.ts
deno check --config deno.jsonc supabase/functions/monitor-ses-makesafes/index.ts
```

The existing repository-wide `deno task test:ops-api` gate does not reach test
execution because four unchanged tests have type errors in
`makesafe_board_test.ts`, `makesafe_intake_recapture_test.ts`, and
`makesafe_submit_report_test.ts`. A no-check whole-suite run reached 2,081
passes and exposed unrelated attendance-cycle/pack test-stub failures. It also
caught an exact source-contract assertion affected by the first version of this
patch; that regression was repaired, and
`makesafe_deterministic_intake_migration_test.ts` is now 24/24 green. The owned
entry points and task-specific tests are clean; the unrelated broad-suite
baseline was not modified.

## Captain-gated production proof

This worktree was not deployed, so it would be false to claim that production
already returns 200. After merge and an authorised deploy from the canonical
release worktree, the required live proof is:

1. `POST .../ops-api?action=scan_ses_makesafes` returns HTTP 200 with a JSON
   deterministic report;
2. `source_read.cap` is 4, the historical tuple cursor advances on successive
   runs, and the recent queue selects only eligible unfated sources;
3. recent function logs show neither HTTP 546 nor `CPUTime` shutdown;
4. `makesafe_intake_health.last_scan_at` advances on success and the prior
   handoff degradation clears through the runtime's normal health write; and
5. a deliberately observed future non-2xx continuation produces both source
   fates/business event and a degraded health row.

No stranded instruction replay or historical backfill belongs in that deploy
proof.
