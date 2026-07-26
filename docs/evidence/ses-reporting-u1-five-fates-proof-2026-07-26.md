# SES Reporting U1: Five-fates intake proof

**Mission:** `ses-reporting-end-to-end-2026-07`, unit U1  
**Backend baseline:** `df1d13a`  
**Contract read:** U1 and the binding correlation spine  
**Safety:** production reads only. No job, draft, case, cursor, email, storage or communication write was made.

## What we did

We gave the intake sea a chart.

The new replay harness reads the real SES mailbox projection with GET requests only, runs the same deterministic planner and PDF extraction boundary used by intake, joins the existing intake case ledger and emits a PII-free verdict for every source email.

The first voyage replayed all **1,394** retained SES emails. It found **78 real historical email shapes**, not invented fixtures. Every shape has an observed count and a hashed example source in `ses-reporting-u1-five-fates-replay.json`.

The replay exposed two code defects, one stale contract test and one release-state failure:

1. **Newest builder PDFs lost the extraction budget.** A standing scan reads an old sweep half and a recent half. PDF extraction sorted both oldest first, so the 50-document budget was consumed by old sweep mail before a newly-arrived clean work order was parsed. The fix gives exact diagnostic sources and the recent half first claim on the budget, newest first, while old non-priority sweep rows retain oldest-first progress.
2. **A failed scan handoff could exist only in edge logs.** `fetch` resolves on HTTP 401, 403, 409 and 5xx. The monitor logged that status, released the mailbox lease and wrote no durable alarm. The fix records `makesafe.intake.scan_handoff_failed` with the mailbox watermark, failure class, HTTP status and included-source count. Source content is never copied into the alarm.
3. **The late-PDF test still treated an absent advancement env value as OFF.** Captain Amendment 46 made clean-draft advancement default ON and retained exact `false` as the brake. The test now exercises that explicit brake instead of deleting the variable. Runtime semantics are unchanged.
4. **Production is not on the backend reality replayed here.** Six latest source emails have no durable intake fate. The intake health row still reports a legacy `usage_cap` result and model call, despite the repository's standing deterministic code. This leg did not deploy or mutate production. Closing that release drift is a supervised post-merge step.

## What correct means

Every builder email has one and only one terminal intake fate:

1. `live_job`
2. `blocked_live_job`, with a visible blocking reason
3. `reason_coded_exception`
4. `revision_or_reattendance`, attached to an existing lineage
5. `accounted_non_work`

For U1, the available correlation chain is:

`source_instruction_id -> instruction_id -> lineage_id -> case_id -> job_id`

The replay fails an email when any of these are true:

- the deterministic plan gives it zero or multiple fates
- the source has zero or multiple durable case links
- an exception has no reason code
- a blocked job has no blocker
- a live fate has no job
- the durable fate disagrees with the current deterministic replay
- a clean live job has no measurable job-created timestamp
- a clean live job takes more than 300 seconds from source receipt to job creation

Later correlation links from attendance cycle through closeout remain owned by U2 to U8. U1 does not invent them.

## What the Captain will see

Once the two functions are released from the authorised main release worktree:

- a new clean builder work order gets PDF capacity ahead of old replay traffic
- the existing guarded draft approval remains the only live-job boundary
- no invoice, send, allocation or close action is added
- a rejected or unreachable scan handoff creates a durable operational alarm instead of disappearing into logs
- the replay command can be rerun without changing any production row
- Hugo's five-minute promise has a countable result rather than a comment

## Current path map against the five fates

| Stage and exit | Durable record | Five-fates classification | Verdict |
|---|---|---|---|
| Graph post matches a configured builder sender, watched sender, reference or work-order subject | `emails` plus append-only `email_events_raw`; attachments settle before the mailbox watermark | Enters deterministic planning | Correct, retry-safe |
| Graph post is excluded | `email_events_raw(change_type=excluded)` plus `email_classifier_exclusions` | Accounted non-work | Correct, no silent exclusion |
| Email, raw-event, attachment, projection, sync-state or watermark write fails | Failing poll aborts before completed watermark; any earlier email row remains durable | Retried, not a terminal exit | Correct, fail loud |
| Mail read fails | `business_events(makesafe.intake.mail_read_failed)` | No unseen source can be fated yet | Correct operational alarm |
| Mailbox lease is held | No cursor movement; next poll retries | Deferred, not terminal | Correct |
| Scan continuation returns non-2xx or throws | Synced email rows plus new `business_events(makesafe.intake.scan_handoff_failed)` | Deferred to next poll with a durable handoff alarm | Fixed in U1 |
| Own-domain copy or deterministic chatter/noise | Canonical case plus case-source row | Accounted non-work | Fate 5 |
| Cancellation | Canonical case plus reason `cancellation` | Reason-coded exception | Fate 3 |
| Unknown builder, conflict, claim-only identity or parse gap | Canonical case plus typed reason and evidence map | Reason-coded exception | Fate 3 |
| Complete identity but required secondary field is absent | Live job-linked case plus `blocked_reasons` | Visible blocked live job | Fate 2 |
| Complete clean instruction | Guarded draft approval, live job, canonical case and source links | Live job | Fate 1 |
| Revision or reopen | Typed parent relation and existing lineage/job binding | Revision or reattendance | Fate 4 |
| Per-case job creation fails after source accounting | Case remains a visible `awaiting_job_creation` exception and ranks as a bounded job retry | Reason-coded exception until promoted | Fate 3, retryable |
| Isolated authority conflict or missing parent | Degraded health/caveat; existing source email and any prior authority remain durable; sweep retries | Not terminal while unresolved | Visible retry, not a silent drop |
| Scan health write fails | Request throws before completion cursor commit | Retried idempotently | Correct, fail loud |
| Scan cursor write fails | Cases/fates remain durable and response carries `scan_cursor_unavailable` | Completed fates remain valid | Correct, coverage caveat visible |

## Real replay evidence

### Corpus

| Measure | Result |
|---|---:|
| Retained real SES emails replayed | 1,394 |
| Real historical shape combinations | 78 |
| Sources assigned exactly one replay fate | 1,394 |
| Sources with a durable production fate | 1,388 |
| Silent production source gaps | 6 |
| Overall correct against replay, durable fate and latency law | 1,347 |
| Overall incorrect | 47 |

### Replay fate table summary

| Fate | Current deterministic replay | Durable production ledger |
|---|---:|---:|
| Live job | 43 | 1 |
| Blocked live job | 0 | 0 |
| Reason-coded exception | 668 | 706 |
| Revision or reattendance | 0 | 0 |
| Accounted non-work | 683 | 681 |
| **Total** | **1,394** | **1,388** |

The 47 incorrect verdicts overlap by reason:

- 6 sources have no durable fate at all
- 40 durable exception fates disagree with the repaired replay's clean live-job fate
- 42 clean live-job replays have no production live-job timestamp
- the one measurable historical live job took 3,802,333 seconds because it was a backlog promotion, so it is not evidence of steady-state speed and it fails the literal law

The latest six missing sources comprise two own-domain copies, a twin-captured clean inbound work order and a twin-captured inbound builder-reference message. The clean work-order twin is the real-email regression that exposed PDF-budget starvation.

### Five-minute law

**Current production verdict: FAIL.**

| Measure | Result |
|---|---:|
| Clean live-job source verdicts in repaired shadow replay | 43 |
| Measured production live jobs | 1 |
| Within 300 seconds | 0 |
| Over 300 seconds | 1 |
| Unmeasured because no live job exists | 42 |

This does not claim the repaired code is live. It proves where the law stands now and gives the final proving run a fixed calculation.

## Regression commands

```bash
npx -y deno test --no-check --allow-all \
  supabase/functions/ops-api/makesafe_deterministic_intake_test.ts \
  supabase/functions/ops-api/makesafe_deterministic_intake_runtime_test.ts \
  supabase/functions/ops-api/makesafe_deterministic_intake_migration_test.ts \
  supabase/functions/ops-api/makesafe_reporting_intake_pass_test.ts \
  supabase/functions/ops-api/makesafe_intake_late_pdf_test.ts \
  supabase/functions/ops-api/makesafe_intake_five_fates_replay_test.ts \
  supabase/functions/ops-api/monitor_ses_makesafes_test.ts

npx -y deno check \
  supabase/functions/monitor-ses-makesafes/index.ts \
  supabase/functions/ops-api/makesafe_deterministic_intake_runtime.ts \
  supabase/functions/ops-api/makesafe_intake_five_fates_replay.ts \
  scripts/replay-makesafe-five-fates.ts

SUPABASE_URL=https://kevgrhcjxspbxgovpmfl.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=... \
npx -y deno run --allow-env --allow-net --allow-write \
  scripts/replay-makesafe-five-fates.ts \
  --days 180 --max-sources 2000 \
  --output docs/evidence/ses-reporting-u1-five-fates-replay.json
```

The transport guard rejects POST, PATCH, PUT and DELETE before network fetch. The service key is read from the environment and never written to evidence.

The seven-file behavioural suite passes **198 tests**. Every changed runtime and harness module passes normal `deno check`. Importing the monolithic `ops-api/index.ts` under normal typecheck still reports nine pre-existing errors outside this change; the behavioural suite therefore uses `--no-check`. CP1 cannot claim whole-index typecheck closure until that existing debt is repaired.

## What the next island needs

1. Merge and release the authorised main branch through the production release worktree. Do not deploy from this feature worktree.
2. Confirm the monitor and ops-api deployed revisions match main, then allow the ordinary poll to account the six durable source gaps. No manual source mutation is required.
3. Run one supervised clean builder-email probe. Record source receipt, canonical case creation, guarded job creation and Hugo board visibility. The same correlation record must cross all four timestamps and complete within 300 seconds. This leg did not send that probe because live sends and job creation were forbidden.
4. U2 must consume the same source, lineage, case and job coordinates when proving Hugo's board projection. A job row alone is not the final visibility proof.
5. Rerun this exact 1,394-row harness, plus all newly-arrived sources. The gate is zero silent disappearances, zero fate disagreement and every clean live-job sample measured at or below 300 seconds.
