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
   continuation per queued attachment. The continuation claims exactly one row,
   downloads at most `PDF_TEXT_MAX_BYTES`, extracts text with the existing
   deterministic extractor, and persists a reason-coded result.
3. After an extracted or quarantined result is durable, the worker invokes the
   existing deterministic intake scanner for that source. The scanner consumes
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

The historical cron drains one PDF per minute, oldest-first, with `SKIP LOCKED`
claims and a ten-minute stale-claim recovery. The worker returns the live
`remaining_backlog` and `drain_eta_at` after every invocation. For `N` queued
rows, the upper-bound drain duration at the implemented rate is:

`ceil(N / 1) minutes`

The last production-shaped replay measured 534 deferred PDF documents. At the
implemented rate that known replay-shaped backlog is 534 minutes (8 hours 54
minutes), with a conservative completion date of **2026-08-01** for a drain
started on 2026-07-31. The actual production backlog may differ; the deployed
worker's `drain_eta_at` is the authority and must be recorded by the verifier.
This is intentionally a one-document worker, not a raised standing-scan cap,
so the scope-json OOM failure mode is not reintroduced.

The five-fates replay retains its 50-document fallback cap for historical rows
that have not crossed the belt. Persisted belt results are reused as exact
documents and do not spend that local fallback budget. This preserves the
read-only replay's bounded-memory semantics while allowing the live belt to
drain independently.

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
3. A fresh, non-synthetic inbound builder WO records `received_at`, PDF
   `pdf_extraction_completed_at`, canonical job creation, board observation, and
   Hugo notification acceptance. The first PDF read and the board-visible result
   are each within five minutes of receipt, with no portal-capture dependency.
4. The extraction endpoint reports a finite `remaining_backlog` and
   `drain_eta_at`; failed rows have a reason and retry/terminal accounting, and
   fresh-source health is based on the oldest eligible source rather than a
   successful HTTP response alone.

The checks should use the canonical board projection and the existing Hugo audit
table `makesafe_intake_hugo_notifications`, not a client-side status derivation.
