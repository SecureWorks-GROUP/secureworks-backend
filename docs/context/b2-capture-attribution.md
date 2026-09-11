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

## Producer provenance follow-up (2026-09-11)

Direct IDs now require `direct_job_id`, `direct_reference`, or `manual` source provenance, both in `resolveMatch` and the database. Confidence alone never makes a contact, email, phone, or recent-job guess authoritative. Dropped suggestions remain in `metadata.attribution_hint`; receiver payload suggestions are explicitly named `suggested_job_id`/`suggested_job_number`. Unmarked historical IDs cannot be assumed explicit; the migration reconsiders them through the ladder, preserving the hint. Thread/contact/Luna attribution remains database-owned.

- GHL outbound SMS uses the explicit caller job only; the latest-contact-match shortcut is removed. Both fallback and T7 retain the full body, contact, provider ID and source date or null.
- Receiver call/status/note/SMS all use only an explicit source job UUID. Transcript invocation forwards `event_at` from the provider independently of ingestion.
- `transcribe-call` accepts `event_at?: string|null` and `job_match_method?: MatchMethod`. Old `occurred_at` input is not a source-time substitute. A job hint without an explicit method is quarantined; legacy extraction enqueue also uses the normalized job, never raw input. Audio upload failure returns HTTP502 before transcription. The separate transcription task/retry packet owns durable scheduling/recovery; this endpoint does not claim that coverage.
- Notes use the saved `job_events.created_at` and author. Quote acceptance uses the exact timestamp persisted to `accepted_at` and fails if that write fails. Internal status changes share one timestamp and use the job UUID. Clock events retain source timestamp, location and actor for all accepted clock actions; absent client time uses the known server action time, while malformed supplied time remains unknown.
- Xero deposit/payment evidence uses `FullyPaidOnDate`, or null when absent. Operational deposit timestamp fallback remains unchanged and is explicitly not represented as payment occurrence. Contradiction evidence uses provider update time. Invoice auto-link markers are system events; name-match hints do not become direct job evidence.
- SES intake handoff failures/deferred markers are system-channel events and cannot become facts. Existing operational intake continues.
- `job_detail.business_events` now includes nullable `event_at` alongside `occurred_at` for honest UI source dates.

Verification: 68 focused evidence/deposit tests pass; PostgreSQL17 B1+B2 forward, behavior and rollback pass in isolated `cio_codex_b2_producers_final_20260911`. Tests prove high-confidence weak matching cannot bind/enqueue, raw SQL weak/unmarked IDs reach Luna, explicit IDs remain direct, missing/invalid provider date remains null, and deposit operational fallback is not source payment time. Six affected endpoint checks pass (receiver, proxy, transcribe-call, ops-api, xero-sync, monitor-ses-makesafes). `send-quote` baseline and modified source both report the same 46 pre-existing type errors in publication RPC interfaces/nullability; it is not claimed typecheck-clean. No provider/model/production calls were made. Source fixtures reflect checked-in types; current live constraints remain unverified after HTTP401.

### Remaining capture coverage and mailbox compatibility

Bounded writer inspection still finds gaps: `addPhoto`/`attachJobPhoto` and Trade photo upload persist `job_media` plus `job_events` without retained business-event document/media pointers; work-order creation emits a metadata-only `wo.created`, while `sendWorkOrder` marks sent and logs only `job_events`. Document assembly/attachment writers similarly need producer-by-producer bridging. These paths are not fixed by note capture and are not capture-all acceptance.

Recommended follow-up: after each successful authoritative row write, create a deterministic source-table/source-ID envelope with that row's date and explicit job, original MIME/hash and a private evidence copy/pointer. Retain pointer-only rows without pretending they contain readable/model-extractable text. Keep each writer's operational file/URL intact; do not convert existing public buckets or remove business files. No bulk historic replay is implied.

B5's safe compatibility seam is after durable normalized-mail capture and `inbox_events` projection: a separate deterministic, idempotent supplier projection can restore classification/priority/action fields using sender/subject/explicit reference rules, then file only after authoritative attribution. A private document access route/short-lived signed-link reader is needed before projecting private attachment pointers into current `job_documents`/`job_media` consumers, which expect public URLs. Do not restore paid classification or publish private capture bytes to make the old UI work. Existing SES operational intake remains separate and active. This seam is proposed; the removed supplier filing/classification behavior remains a B5 compatibility gap until implemented and tested.
