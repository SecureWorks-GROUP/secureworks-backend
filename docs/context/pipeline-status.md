# Context pipeline heartbeat

`GET ops-api?action=context_pipeline_status` is the captain's one-line-a-day
read: Perth `run_date`, switch/lanes, today's extraction runs (total, by
status, and failed-by-error-code), model-call reservations, unreceipted
extractable evidence by attribution status, ready-job count (capped at 400),
and `coverage` of open jobs and authorised receivables.

Since F1 (`20260924020000_context_status_foundation.sql`) the SQL function is
a composer. Today's keys above are `context_core_status()` (the 17 Sep body,
unchanged) and stay top-level with identical values. The composer adds:

| Key | Sub-function | Owner slice | Until built |
|---|---|---|---|
| `cadence` | `context_cadence_status()` | cadence K1 | `null` |
| `capture_sources` | `context_source_freshness()` | F1 | built |
| `ghl_capture` | `context_ghl_capture_status()` | sms C1d | `null` |
| `booking_capture` | `context_booking_capture_status()` | dossier D3 | `null` |
| `parties` | `context_parties_status()` | sites S-M1 | `null` |
| `alarms` | every block's `alarms` array, each tagged with `block` | composer | `[]` |

Rules for the owning slices:

- Replace only your own sub-function, with `CREATE OR REPLACE`, keeping
  `() RETURNS jsonb`. Return an object with an `alarms` array; each alarm is
  `{key, severity, since, what_to_do, ...}`. Only F1 changes
  `context_pipeline_status()`.
- A block that raises shows as `{"error": "<SQLSTATE>"}` plus a
  `status_block_failed` alarm; the rest of the status still reads. A core
  failure still fails the whole read (unchanged behaviour).
- Your rollback restores the F1 stub (`SELECT NULL::jsonb`, comment starting
  `F1 stub.`). The F1 rollback refuses while any stub is replaced.

`capture_sources`: last `context_captured_at` per `business_events.source`
(rows with `metadata.capture_mode` `backfill` or `relink` ignored), business
minutes since (Mon to Sat, 07:00 to 18:00 Perth, no public holidays), and the
`capture_quiet` alarm when a normally active source (at least 2.5 rows per
business hour over the 14 days before its last row) has written nothing for
120 business minutes. Thresholds are published in the block's `policy`
(`context_source_freshness_policy()`). Sources silent for more than 60 days
drop off the list.

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
  first. Shared by the dossier last contact (sms R1) and cadence freshness (K4).
- `context_capture_runs`, written only through `record_capture_run(jsonb)`
  (service_role may SELECT, never write directly). One row per reconcile run
  (`source` e.g. `ghl_message_reconcile`, `scope_booking`); a running row may
  be recorded after each page; a finished row is immutable; counts and codes
  only, never message text.

The jarvis tool proxies this action through `context_pipeline.ts`. The
handler is GET-only and SELECT-only.

## SQL

`20260917210000_context_pipeline_status.sql` installed `context_coverage()` and
the original heartbeat body. F1 (`20260924020000`) moved that body unchanged
to `context_core_status()` and made `context_pipeline_status()` the composer
documented above. F1 is built on the live production definitions (read
23 Sep 2026): its opening guard refuses unless the heartbeat, the 9-arg
`persist_luna_context_revision` and the current-facts view are still that
pre-image (or already F1's result) and the status check still holds the nine
live values, and its rollback restores those bodies byte for byte and checks
their md5. F1 also made the heartbeat cheaper without changing any output.
`ready_jobs` no longer calls `context_extraction_candidates(400)` (15.5 s in
production on 23 Sep 2026: it serialises the whole jobs row, `scope_json`
included, once per linked event, which is why the read hit the 8 s API
timeout, 57014). It reads `context_ready_jobs_count(400)`, which admits
exactly the same jobs in a cheaper order and is pinned equal by the contract;
whoever changes the candidates read (cadence K1) changes it in step. The
per-row helpers `context_linked_status` and `context_in_business_hours`
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
`supabase/tests/migration-contracts/20260917210000_context_pipeline_status` and
`supabase/tests/migration-contracts/20260924020000_context_status_foundation`
(the latter compares the composer with a verbatim copy of the 17 Sep body on
the same fixtures).
Deno: `supabase/functions/ops-api/context_pipeline_test.ts`.
