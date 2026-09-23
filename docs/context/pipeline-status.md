# Context pipeline heartbeat

`GET ops-api?action=context_pipeline_status` is the captain's one-line-a-day
read: Perth `run_date`, switch/lanes, today's extraction runs (total, by
status, and failed-by-error-code), model-call reservations, unreceipted
extractable evidence by attribution status, ready-job count (capped at 400),
and `coverage` of open jobs and authorised receivables.

Since F1 (`20260924020000_context_status_foundation.sql`) the SQL function is
a composer. Today's keys above are `context_core_status()` and stay top-level
with identical values. The composer adds:

| Key | Sub-function | Owner slice | Until built |
|---|---|---|---|
| `cadence` | `context_cadence_status()` | cadence K1 | built |
| `capture_sources` | `context_source_freshness()` | F1 | built |
| `ghl_capture` | `context_ghl_capture_status()` | sms C1d | built |
| `booking_capture` | `context_booking_capture_status()` | dossier D3 | `null` |
| `parties` | `context_parties_status()` | sites S-M1 | `null` |
| `email_capture` | `context_email_capture_status()` | email EM1 | `null` (F1b stub) |
| `transcript_capture` | `context_transcript_capture_status()` | transcripts T2 | `null` (F1b stub) |
| `money` | `context_money_status()` | money MN1 | `null` (F1b stub) |
| `bucket` | `context_bucket_status()` | bucket B2 | `null` (F1b stub) |
| `alarms` | every block's `alarms` array, each tagged with `block` | composer | `[]` |

The last four blocks were added by F1b (`20260924152100_context_status_f1b.sql`,
INTEGRATION X22), the foundation owner's second slice.

Rules for the owning slices:

- Replace only your own sub-function, with `CREATE OR REPLACE`, keeping
  `() RETURNS jsonb`. Return an object with an `alarms` array; each alarm is
  `{key, severity, since, what_to_do, ...}`. Only F1 and F1b
  (same owner) change `context_pipeline_status()`.
- A block that raises shows as `{"error": "<SQLSTATE>"}` plus a
  `status_block_failed` alarm; the rest of the status still reads. A core
  failure still fails the whole read (unchanged behaviour).
- Your rollback restores the stub (`SELECT NULL::jsonb`, comment starting
  `F1 stub.` or, for the F1b blocks, `F1b stub.`). The F1 and F1b rollbacks
  refuse while any of their stubs is replaced; F1b rolls back before F1.

`cadence` (K1, `20260924030000`): `context_cadence_status()` replaces the F1
stub. The composer is untouched. The block publishes `policy`, due and waiting
job counts, `oldest_unread_landed_at`, `oldest_due_wait_minutes`,
`cadence_breach` (a due job waited over 90 minutes with the extraction lane on
and model budget left), runs today, ceiling and pacing holds, lease takeovers,
unplaced rows, rows not written as `service_role`, and `alarms`. Due is
`context_jobs_cadence`; do not re-derive it here.

`capture_sources`: last `context_captured_at` per `business_events.source`
(rows with `metadata.capture_mode` `backfill` or `relink` ignored), business
minutes since (Mon to Sat, 07:00 to 18:00 Perth, no public holidays), and the
`capture_quiet` alarm when a normally active source (at least 2.5 rows per
business hour over the 14 days before its last row) has written nothing for
120 business minutes. Thresholds are published in the block's `policy`
(`context_source_freshness_policy()`). Sources silent for more than 60 days
drop off the list. Each source row also carries `alarm_exempt` (F1b):
`retired` for a writer that has stopped for good (`transcribe-call`, the
Whisper path, replaced by `ghl-call-transcript`), listed while it has rows but
never alarmed; `flag_off` for a flag-gated writer (`ghl-call-transcript`,
flag `ghl_call_transcript_fetch_v1`), which is always listed, even before its
first row, with its `flag` state (`present`, `missing`, `unreadable`) and
alarms only while the flag is on (missing or unreadable reads as off).
`quiet` stays the measured fact; the alarm needs `quiet` and no exemption.
Both lists are in the policy (`retired_sources`, `flag_gated_sources`).

`ghl_capture` (C1d, `20260924133000_context_ghl_message_reconcile.sql`):
the item flag `ghl_message_capture_v2` (a missing row reads off) and the
capture lane; GHL webhooks in 24 h by outcome and by auth and mode, last
webhook and last app webhook, unresolved ids (from the receiver's ids-only
`webhook_log` receipts); the reconciler's last run, last finished
(`succeeded` or `partial`) run, watermark, backlog, webhook misses and write
errors in 24 h (from `context_capture_runs`, source `ghl_message_reconcile`).
Alarms: `ghl_webhooks_quiet` (no app webhook for 120 business minutes) and
`ghl_reconcile_stale` (no finished `succeeded` or `partial` run for 45
minutes), both only while the lane and the flag are on; `ghl_webhook_misses_high`
(more than 5 in 24 h); `ghl_auth_missing` (critical: any post refused after
the receiver enforces auth; observe-mode `auth=missing` is counted, not
alarmed). Thresholds: `context_ghl_capture_policy()`. The reconciler itself:
[ghl-message-reconcile.md](ghl-message-reconcile.md).

`actor_missing` (F-ACT, `20260924201000_ops_api_actor_recording.sql`,
INTEGRATION X31) is a core key, so it sits at the top level with the others:
`{state, today, last_7_days}`, the number of ops-api calls in the `api_key`,
`routine`, and `agent_read` classes, plus valid HMAC-link cost-report calls,
that carried no usable trusted actor, today and over the last 7 Perth days,
today included. `x-sw-actor` is trusted only
with the service or agent server secret. Shared browser-key and routine calls
ignore a claimed header and count as missing; JWT calls use the verified user
and ignore the header. `state` is `available`, or `unavailable` with `code`
when the counter cannot be read; it never fails the heartbeat. Calls with a
usable actor are not counted. It raises no alarm: identity is for audit only,
and such a call is never refused. The counter is `ops_api_actor_calls`, one row
per Perth day holding the missing count only (35 days kept), written only
through `record_ops_api_actor_missing()`, which takes no argument. The actor
itself is in the ops-api log line, one per call:
`[ops-api] action=<action> method=<m> actor=<actor> actor_source=<jwt|header|header_invalid|header_untrusted|hmac_link|none>`
for a served call, and `[ops-api] denied action=... actor=... actor_source=... status=<n> code=<code>`
for a call the front door refused. The count runs through
`EdgeRuntime.waitUntil`, best-effort.

Alarms are read by the CIO desk's scheduled check (INTEGRATION decision D-A),
never Telegram.

## F1 shared pieces

- `context_linked_status(text)`: the one definition of a linked row (`direct,
  thread, single_open, single_line, luna, content_ref, party`). Null and
  unknown read false. `persist_luna_context_revision` and the
  `current_job_context_facts` view both use it, so a fact the writer accepts
  is never hidden by the view.
- `business_events.attribution_status` also allows `content_ref`, `party`,
  `unplaced`; `business_events.candidate_job_ids uuid[]` (partial GIN). F1
  writes neither; the placement track does.
- `context_unplaced_for_job(job_id)`: `pending_luna`/`unplaced` rows whose
  `candidate_job_ids` contain the job, the job contact's `admin_bucket` rows,
  and the job contact's worded rows on a `do_not_schedule` holding job. Newest
  first. Shared by the dossier last contact (sms R1) and K1
  `context_job_freshness` (dossier K4 consumes the same helper).
- `context_capture_runs`, written only through `record_capture_run(jsonb)`
  (service_role may SELECT, never write directly). One row per reconcile run
  (`source` e.g. `ghl_message_reconcile`, `scope_booking`); a running row may
  be recorded after each page; a finished row is immutable; counts and codes
  only, never message text. F1b added `window_end_id` (text, `COLLATE "C"`):
  the provider id of the last item fully processed at `window_to`, so
  `(window_to, window_end_id)` is a pair cursor for sources whose items share
  timestamps (email). It needs `window_to`, and a `record_capture_run` call
  that moves `window_to` without naming `window_end_id` clears it, so a stale
  id is never paired with a new time. Ids only: at most 512 characters of
  `A-Za-z0-9._:=+/@<>-`.

The jarvis tool proxies this action through `context_pipeline.ts`. The
handler is GET-only and SELECT-only.

## SQL

`20260917210000_context_pipeline_status.sql` installed `context_coverage()` and
the original heartbeat body. F1 (`20260924020000`) moved that body to
`context_core_status()` (same keys and values; `ready_jobs` now reads
`context_ready_jobs_count`) and made `context_pipeline_status()` the composer
documented above. F1 is built on the live production definitions (read
23 Sep 2026): its opening guard refuses unless the heartbeat, the 9-arg
`persist_luna_context_revision` and the current-facts view are still that
pre-image (or already F1's result) and the status check still holds the nine
live values, and its rollback restores those bodies byte for byte and checks
their md5. F1 also made the heartbeat cheaper without changing any output.
`ready_jobs` no longer inlines the pre-K1 `context_extraction_candidates`
body (15.5 s in production on 23 Sep 2026: that body serialised the whole
jobs row, `scope_json` included, once per linked event, which is why the
read hit the 8 s API timeout, 57014). It reads `context_ready_jobs_count(400)`,
which K1 made a count of the due-rule `context_extraction_candidates` read
(still capped at 400). Keep those two in step. The per-row helpers
`context_linked_status` and `context_in_business_hours`
inline (no SET clause), the current-facts view reads `b.metadata` for
retraction instead of serialising each cited event row, and expression
statistics on `xero_invoices` let coverage hash its invoice counts. On 200k
synthetic events the whole heartbeat went from 2.9 s to 0.64 s.
`context_coverage()` is unchanged: open jobs (not
cancelled/archived/lost/closed/complete/completed) and authorised ACCREC
invoices with `amount_due > 0`, split into with_current_fact / no_current_fact
/ evidence_without_current_fact / no_evidence_yet.

Copied from the unmerged accuracy packet without `context_accuracy_*` tables or
`latest_accuracy_week` / `accuracy_alerts`.

Corrections against that draft (still the `context_core_status()` body):

1. `missing_event_time` counts rows where **both** `event_at` and `occurred_at` are null. An `event_at IS NULL` count would report ~33k healthy rows after PR 854. `oldest_pending_event_at` is `min(coalesce(event_at, occurred_at))`.
2. Coverage filters `xero_invoices.invoice_type`. Production has no `type` column on that table.
3. `evidence_by_attribution_status` excludes `empty` and `automated` (candidates never admit them).
4. Today's extraction runs are published as `runs_by_status` and `failed_by_error` so a failure-code morning is visible without SQL.

## Failure

Any RPC failure or empty payload returns 503 `context_status_unavailable` with a
`reason`: the Postgres SQLSTATE or PostgREST code (for example `57014`,
`PGRST202`), `rpc_error_no_code` when the error has no safe code (fetch
failure), or `empty_payload`. The edge log carries one
`context_pipeline_status_rpc_failed` line with code, message and hint, never
the payload.

## Proof

Registered contracts
`supabase/tests/migration-contracts/20260917210000_context_pipeline_status`,
`supabase/tests/migration-contracts/20260924020000_context_status_foundation`
(the latter compares existing composer keys with a copy of the 17 Sep body on
the same fixtures, and pins `ready_jobs` to the candidates count),
`supabase/tests/migration-contracts/20260924030000_context_evidence_cadence`
(K1 cadence block, due rule, and ready-job count),
`supabase/tests/migration-contracts/20260924133000_context_ghl_message_reconcile`
(C1d `ghl_capture` block, item flag, cron, and lane list), and
`supabase/tests/migration-contracts/20260924152100_context_status_f1b`
(F1b composer stubs, `window_end_id`, and the freshness source swap).
Deno: `supabase/functions/ops-api/context_pipeline_test.ts`.
