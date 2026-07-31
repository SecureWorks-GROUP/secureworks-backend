# Make-safe PDF extraction belt - 2026-07-31

## Decision

The builder work-order PDF is the evidence of record. A portal link or portal
capture may remain supporting evidence for later reporting, but neither is a
live-job prerequisite or a Hugo-notification prerequisite. The deterministic
planner still owns identity, eligibility, and job creation; this change only
moves the same PDF text extraction to a bounded worker before that planner reads
the source.

The deployed PR445 filename rule is confirmed by the local deployed-shape check:

`work_order_MLB-26267PO-56336_Secureworks_Group_Pty_Ltd.pdf` resolves to
`builder_claim_ref=MLB-26267`, `builder_work_order_number=MLB-26267PO-56336`, and
`builder_po_number=PO-56336` from the filename alone. The remaining production
failure was therefore an unread PDF, not the underscore identity grammar.

## Fresh-work path

1. The monitor stores the validated PDF bytes and queues its
   `email_attachments` row.
2. The same poll schedules one `ops-api?action=makesafe_pdf_extraction_drain`
   continuation per unique queued SHA coordinate. The continuation claims one
   coordinate under a fenced token,
   downloads at most `PDF_TEXT_MAX_BYTES`, extracts text with the existing
   deterministic extractor, and fans the reason-coded result to every carrier
   row for those bytes.
3. After an extracted or quarantined result is durable, the worker invokes the
   existing deterministic intake scanner for every carrier source. The scanner consumes
   the persisted text and does not invoke PDF text extraction again. The
   existing job-artifact seam may copy the same bytes once into the private job
   document store; that is evidence staging, not a second text read.
4. Hugo notification remains downstream of canonical job/board creation. Its
   only change is that `missing:portal_capture` can no longer prevent the job
   from reaching that existing post-board notification path.

`EdgeRuntime.waitUntil` owns the continuation. If that runtime is unavailable,
the attachment remains queued, gets a `pdf_extraction_handoff_runtime_failed`
reason and a durable `makesafe.intake.pdf_extraction_handoff_failed` event, and
the fresh-source health degradation remains visible. Download, size, and
extractor failures use distinct retry or quarantine reasons; no failure is
treated as a successful read.

## Historical drain date and rate

The historical cron drains one untouched SHA coordinate per minute before
retrying failures, with `SKIP LOCKED` claims, a two-minute stale-claim recovery,
and a three-attempt terminal bound. The worker returns the live
`remaining_backlog` and `drain_eta_at` after every invocation. For `N` queued
rows, the upper-bound drain duration at the implemented rate is:

`sum(attempts remaining + two-minute retry waits) at one attempt per minute`

The last production-shaped replay measured 534 deferred PDF documents. The
actual unique-SHA production backlog and retry allowance may differ; the
deployed worker's conservative `drain_eta_at` is the authority and must be
recorded by the verifier.
This is intentionally a one-document worker, not a raised standing-scan cap,
so the scope-json OOM failure mode is not reintroduced.

The historical cron invokes `ops-api` with `x-api-key` from the Vault secret
`sw_api_key`. That secret must be present and non-empty before the drain is
enabled; there is no embedded or stale credential fallback. The pg_net request
is recorded and checked asynchronously, so timeout, network error, non-200
response, or a missing response fails the cron visibly rather than appearing as
a successful drain. The current pace remains one item per minute. A future
cap-5 change is only a recommendation for a separately benchmarked,
sequential, SHA-fenced implementation.

The five-fates replay retains its 50-document fallback cap for historical rows
that have not crossed the belt. Persisted belt results are reused as exact
documents and do not spend that local fallback budget. This preserves the
read-only replay's bounded-memory semantics while allowing the live belt to
drain independently.

## Release order

Apply these migrations in order before deploying the matching `ops-api` and
`monitor-ses-makesafes`:

1. `20260729010000_makesafe_hugo_notification_sla_v1.sql`
2. `20260731000001_makesafe_pdf_extraction_belt.sql`
3. `20260731000002_makesafe_intake_settlement_closure.sql`
4. `20260731081410_fix_makesafe_pdf_drain_auth_and_response_check.sql`
5. `20260731081411_remove_sw_service_key_fallback.sql`

Migration-only merges enter the same reviewed production migration lane and
deploy zero functions. The matching function deploy remains after all listed
migrations are applied.

The schema-requirements manifest is the deploy gate for the required tables,
columns, indexes, constraints, policies, and triggers. Code must not deploy
ahead of any of these three ledger versions.

## Post-deploy verification checklist for the PR

The independent verifier should record UTC timestamps and check all of the
following against production after migration-before-function deployment:

1. The canonical `ops-api?action=makesafe_board` projection contains
   `MLB-19475` and `MLB-RR-26836`; neither source's live blocker contains
   `missing:portal_capture`; no job row is hand-edited.
2. The attachment named
   `work_order_MLB-26267PO-56336_Secureworks_Group_Pty_Ltd.pdf` has
   `pdf_extraction_status=extracted`, non-null persisted text, and a completed
   timestamp. Its deterministic case/job path is no longer parked solely on
   `adapter_parse_failure`.
3. Submit one fresh WO for every supported intake path and record the exact
   expected canonical classification:

   | Source path | Expected canonical family or reason |
   | --- | --- |
   | Physical make-safe | `general_makesafe` |
   | Temporary fence | `temp_fence_makesafe` |
   | Roof report | `roof_report` |
   | Assessment and quote | `assessment_report_quote` |
   | Repair work order | `repair` |
   | Restoration work order | `restoration` |
   | Quote request without a PO | `repair` with `repair_quote_stage` |

   For every row, record `received_at`, the SHA coordinate's `completed_at`,
   canonical job creation, board observation, and exactly one accepted Hugo
   audit keyed by `(org_id, job_id)`. Every job must carry a `work_order` row in
   `job_documents`; extraction and board visibility must each occur within five
   minutes with no portal-capture dependency. A combined physical-plus-report
   WO must produce and independently verify both job-keyed mint rows.
4. The extraction endpoint reports a finite `remaining_backlog` and
   `drain_eta_at`; failed rows have a reason and retry/terminal accounting, and
   fresh-source health is based on the oldest eligible source rather than a
   successful HTTP response alone.
5. Insert or observe a late carrier for a SHA already processing or terminal.
   Confirm one coordinate row, one shared attempt count no greater than three,
   one claim token while processing, and no second download/extraction. Confirm
   every carrier mirrors the coordinate terminal result.
6. Confirm this query returns zero rows:
   `select org_id, job_id, count(*) from makesafe_intake_hugo_notifications group by 1,2 having count(*) > 1`.
   Confirm every accepted audit joins to one explicit
   `makesafe_intake_job_mints` row with non-null evidence, board, and notification
   timestamps.
7. Re-run settlement for every fresh family sample and confirm no second
   provider send.
   Then rescan one historical approved draft and perform one later update on an
   existing job with no mint row; both must create zero Hugo audits.
8. For one deliberately ambiguous provider response, confirm the durable failed
   audit remains job-keyed and a retry does not create a second provider
   dispatch. Separately clear a proven pre-transport configuration failure and
   confirm it can reclaim the same audit row.

The checks should use the canonical board projection and the existing Hugo audit
table `makesafe_intake_hugo_notifications`, not a client-side status derivation.
