# Capture and attribution (B2)

Approved target sections 1 and 2. B1 must apply first. B2 retains SMS bodies, provider message time (separate from write time), provider identity and contact/conversation identity. Both GHL webhook routes accept message events; the receiver no longer truncates full SMS to 500 characters or uses a conversation as a message identity. Xero invoice auto-link evidence now writes a job UUID. Jarvis owns sms-cache-backfill and must emit the same `ghl:<message id>` identity.

The database ladder binds direct references, known threads, one open contact job, or one open job of the line. Multiple candidates become `pending_luna`; no match stays in `admin_bucket`. No human queue. Empty/pointer-only and automated rows remain stored but are not extracted. Automated rule inputs are `payload.automated`, `payload.auto_submitted`, existing automated status, and system/audit channels; B5 owns mail-specific rules.

Service-role APIs:

- `context_attribution_jobs(p_contact_id text)` returns id, job_number, type, status, site_suburb, updated_at.
- `attribute_context_event_with_luna(p_event_id uuid,p_job_id uuid,p_confidence numeric)` atomically locks a pending row and binds its thread. Null job means bucket. An existing racing thread winner is preserved and returned. Missing/not-pending/disabled/invalid candidate calls fail explicitly.
- `rerun_context_attribution(p_limit integer=250,p_contact_id text=null)` returns rows reconsidered. Oldest checked rows rotate first, max 1000. Jobs invoke a bounded pass at creation. The daily worker runs remaining rows; ambiguous rows become pending Luna.
- `context_extraction_candidates(p_limit integer=400)` returns job IDs with today's unfinished runs first, then oldest unreceipted evidence; excludes today's completed/skipped jobs. Closed jobs with new evidence are included.
- `context_extraction_events(p_job_id uuid,p_limit integer=25)` returns events in source-date order, with at most 25. It uses B1 receipts, preserving delayed attribution and multi-day backlogs. A retained incoming message accompanies outbound tails; this anchor may already have a receipt and receipt insertion must remain idempotent.

Historical rows are deterministically classified in 250-row batches without assigning `context_captured_at`. A job becomes eligible only after a fresh attributed incoming capture; its historical evidence can then drain. No extraction backfill, model call, cron or production action is performed by B2.

Rollback removes triggers and callable code while preserving captured rows and thread custody. It does not reverse historic attribution or delete evidence. Restore prior endpoint code with the rollback; the retained additive columns keep those writes compatible.

Undated provider evidence retains a null `event_at`; attribution never substitutes ingestion time. The fact writer must hold such sources until a true occurrence date exists. Internal event producers likewise supply their occurrence date explicitly.

## Checks and evidence boundary

Local PostgreSQL 17: real B1 migrations + B2 migration + behavior assertions + rollback assertions passed. Deno endpoint checks pass; evidence helper tests: 49 passed. Behavior assertions cover repeat customers, Luna and thread binding, matching line, direct/ambiguous references, empty pointer retention, automated rows, job-created reconsideration, dedupe, provider time, missing-date retention, retry discovery under a bounded candidate list, closed jobs, 25-row cap, receipt backlog, outbound tail and fail-closed attribution.

Fixtures use UUID job IDs and checked-in T7 match_status values. Production schema query returned HTTP401; current live constraints were not observed. No live capture/provider receipt or deployment is claimed.

## Existing capture paths retained (source inspection only)

| Signal | Existing producer | B2 boundary |
| --- | --- | --- |
| SMS in/out | ghl-webhook-receiver; ghl-webhook; ghl-proxy | GHL message routes corrected; Jarvis cache path coordinated separately |
| Call metadata/transcript | ghl-webhook-receiver; transcribe-call | Retained, not executed; transcript provider/source-time completeness not proven |
| Staff notes | ops-api add_note / recordEvidence | Retained; full note text recognized by ladder |
| Documents/photos/WO | ops-api document and media actions | Existing job_events/media persistence is not proof every path emits business_events; comprehensive coverage remains to audit |
| Quotes/invoices/payments | send-quote; ops-api; xero-sync | Invoice auto-link UUID fixed; capture-all state-transition coverage not proven |
| Site clock/delivery/status | ops-api / GHL stage receiver | Existing events retained; comprehensive spine emission coverage not proven |

This packet does not claim capture-all acceptance for untested producer paths. B5 owns mailbox coverage, private body pointers and automated-mail rules.
