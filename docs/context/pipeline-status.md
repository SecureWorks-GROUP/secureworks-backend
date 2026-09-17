# Context pipeline heartbeat

`GET ops-api?action=context_pipeline_status` is the captain's one-line-a-day
read: Perth `run_date`, switch/lanes, today's extraction runs (total, by
status, and failed-by-error-code), model-call reservations, unreceipted
extractable evidence by attribution status, ready-job count (capped at 400),
and `coverage` of open jobs and authorised receivables.

The jarvis tool proxies this action. It is SELECT-only. Deploy `ops-api` with
`--no-verify-jwt`.

## SQL

`20260917210000_context_pipeline_status.sql` installs two functions:

- `context_coverage()` — open jobs (not cancelled/archived/lost/closed/complete/completed) and authorised ACCREC invoices with `amount_due > 0`, split into with_current_fact / no_current_fact / evidence_without_current_fact / no_evidence_yet.
- `context_pipeline_status()` — the heartbeat payload, including that coverage object.

Copied from the unmerged accuracy packet without `context_accuracy_*` tables or
`latest_accuracy_week` / `accuracy_alerts`.

Corrections against that draft:

1. `missing_event_time` counts rows where **both** `event_at` and `occurred_at` are null. An `event_at IS NULL` count would report ~33k healthy rows after PR 854. `oldest_pending_event_at` is `min(coalesce(event_at, occurred_at))`.
2. Coverage filters `xero_invoices.invoice_type`. Production has no `type` column on that table.
3. `evidence_by_attribution_status` excludes `empty` and `automated` (candidates never admit them).
4. Today's extraction runs are published as `runs_by_status` and `failed_by_error` so a failure-code morning is visible without SQL.

## Proof

Registered contract
`supabase/tests/migration-contracts/20260917210000_context_pipeline_status`.
Deno: `supabase/functions/ops-api/context_pipeline_test.ts`.
