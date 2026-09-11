# Context switch and daily run custody (B1)

Implements target sections 3b/4/6 and build contracts 1/5. No production action has run. The switch is seeded on as approved; deploy through the normal reviewed migration path. Existing operator off values survive reapply.

The three known scheduled evidence paths are monitor-inbox-poll (capture), xero-invoice-sync (capture), contact-matching (attribution). Their command predicates stop posting when disabled. Unknown command shapes abort deployment instead of silently leaving a caller ungated. Matching HTTP endpoints also check the switch, before provider access. The invoice sync endpoint returns `skipped: true, reason: automation_lane_disabled` when off; it does not claim a financial sync failed or completed. Token refresh and other financial mirrors retain their own behavior. Ops capture backfill actions and trigger_xero_sync also check capture. Manual single-job invoice synchronization remains available. Webhook capture is a B2 integration seam.

SQL helpers, all revoked from anonymous/authenticated callers:

- `automation_lane_enabled(lane text) -> boolean`: strict fail closed; service role allowed.
- `automation_switch_cron_lanes() -> table(cron_jobname,lane)`: three classified jobs.
- `automation_switch_wrap_cron_jobs()` / `automation_switch_unwrap_cron_jobs()`: idempotent command changes, postgres only. Missing cron extension reports skipped; unexpected existing commands abort.
- `claim_context_extraction_run(p_job_id uuid,p_run_date date,p_phase text) -> jsonb`: outcome claimed/done/busy/cap/paused, run object. Today's Perth date only. Extraction admissions serialize at 400 daily rows; retries reuse the slot even at cap. Phase is attribution/extraction/bucket. New lease is 30 minutes with a fresh UUID token.
- `finish_context_extraction_run(p_run_id uuid,p_lease_token uuid,p_status text,p_event_ids uuid[],p_tokens_in integer,p_facts_new integer,p_facts_superseded integer,p_facts_retracted integer,p_error text,p_retry_at timestamptz) -> boolean`: running, unexpired token required; statuses done/failed/skipped. Successful extraction acknowledges supplied event UUIDs for this job and `luna_v2`. Failure retains retry time without event acknowledgments. Wrong/expired token returns false. B3 must call this INSIDE the fact revision transaction and raise if false, so facts and acknowledgments commit together.
- `claim_context_pass(p_run_date date) -> jsonb`: same outcomes except cap; returns pass object and top-level lease_token. Starts at/after 06:00 Perth, 3-hour lease. Persisted retry_at survives restart.
- `renew_context_pass(p_run_date date,p_lease_token uuid) -> boolean`: extends a live lease 3 hours. Worker renews between jobs and must stop on false.
- `finish_context_pass(p_run_date date,p_lease_token uuid,p_status text,p_retry_at timestamptz,p_error text) -> boolean`: fenced completion; updates daily run count. Phase markers attribution_done_at/bucket_done_at let worker avoid repeating completed phases while another lane is paused; marker updates must check the same active lease.

`context_extraction_event_receipts` primary key is (event_id,job_id,extractor_version). B2 candidate queries use missing receipts, not timestamps: delayed attribution and the remainder after 25 survive. B3 owns source snapshot validation before transactional persistence. J1 must keep model deadlines below the run lease and never execute under a failed claim. Claims do not themselves invoke a model or production business effect.

Rollbacks retain operator decisions, attempts and receipts; they stop admissions and unwrap scheduled commands. They deliberately do not drop audit tables. Restore code in the same rollback operation; remaining new callers fail closed.

Verification: executable PostgreSQL tests use a separately named disposable database with UUID jobs/events and bigint cron ids, not a production clone. They prove missing row/table/column, lane isolation, command wrap/reapply/unwrap/refusal, leases, retries, receipts, cap and pass fencing. Deno tests prove uncached strict RPC handling. Production ledger version collision check and live cron inventory remain deployment checks; no production readback claimed.
