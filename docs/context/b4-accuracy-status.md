# Context accuracy and pipeline status (B4)

Implements target sections 5 and 7 plus build contracts 8 and 9. Reads remain synchronous database reads with no provider or model calls. Existing job and invoice response shapes remain unchanged. Their shared visibility helper now also honours top-level lifecycle and expiry on permanent proposals.

## API

- `GET context_pipeline_status`: switch row/effective lanes, daily extraction slots, actual model-call reservations and cap, unreceipted evidence counts by attribution status, admin size, missing source dates, oldest pending event, latest completed pass, coverage, latest accuracy week and pending notification records. The ready-job query is capped at 400 and explicitly marks a lower bound at that limit. If B1's new reservation table is absent/unreadable, actual model calls are null with budget state unavailable; extraction slots are never relabelled as model calls.
- `GET context_accuracy_sample?week_start=YYYY-MM-DD`: stored rows and actual requested/sampled/missing counts. Default is the previous completed Perth calendar week. This route does not draw a sample or judge facts. No sample returns not_drawn; fewer than 40 returns insufficient_sample.
- `POST context_accuracy_verdict`: week_start, fact_id, fact_store, verdict (true/false/wrong_job), optional invented_payment. The authenticated operator JWT supplies actor UUID and organisation; the database reads that user's current name and staff role. A supplied judged_by string cannot establish identity. Service/Jarvis calls without a real human session receive human_auth_required. Read tools continue to work with authorised server credentials.

These routes inherit the existing signed-caller/staff gate, and JWT callers must belong to the configured organisation. No AI truth judgment or silent human impersonation is permitted.

## SQL interfaces

- `context_accuracy_draw(p_week_start date) -> jsonb`: completed Monday-to-Monday weeks only; idempotently freezes one sample. Scope and time-bound strata preserve repeat-customer candidates where possible, then repeat and random each select ten from the remaining facts. All four strata are non-overlapping, selected deterministically from source-backed v2 facts written that week. Small populations retain actual gaps, not invented rows. Source excerpts and fact snapshots are stored at draw time.
- `context_accuracy_publish(p_week_start date) -> jsonb`: recomputes exact verdict totals and separate current coverage. Fully judged undersized samples report true/actual, requested 40, missing, and sample_sufficient=false. Partial reviews report no accuracy ratio. Two consecutive calendar weeks each with an observed breach stop extraction: more than two wrong-job facts is sufficient even with an incomplete review; percentage-based breach requires all intended 40 judged and fewer than 36 true. Different breach types across the two weeks count. A missing week breaks the sequence. Any explicit human invented-payment false verdict stops immediately, including a finding made after publication. Nothing automatically re-enables extraction.
- `record_context_accuracy_verdict(p_week_start date,p_fact_id uuid,p_fact_store text,p_verdict text,p_actor_id uuid,p_invented_payment boolean=false) -> jsonb`: service-side RPC used only after the API verifies a human session; records the database-owned actor name and publishes in the same transaction. Exact repeated verdicts are idempotent. A later human correction is supported.
- `context_coverage() -> jsonb`: current facts versus open jobs, and separately open authorised receivable invoices; unlinked invoices remain a distinct unknown. No-evidence-yet is not an accuracy success or a false claim of completeness.
- `context_pipeline_status() -> jsonb`: the status read described above.

All helpers are service-only and covered by the registered SQL contract. New tables are RLS-enabled with no anonymous or browser table access. The source population view is also service-only.

## Existing-worker integration and delivery

J3 invokes the idempotent draw for the previous completed week through its existing daily worker, including after a missed Monday, before model-lane checks. No new scheduler is introduced here. `latest_accuracy_week` contains n_sampled/n_true/n_false/n_wrong_job, reviewed, requested, missing, sample_sufficient, review_complete, accuracy and tripwire_reason. Unjudged is n_sampled minus reviewed.

Tripwires append `context_accuracy_alerts` rows: id, week_start, reason (invented_payment or accuracy_two_weeks), created_at, delivered_at. The existing morning-brief channel consumes these records and appends the exact counts independently of model narrative. The status read returns undelivered alerts. Setting delivered_at is permitted only after actual transport acknowledgment; a pending record is not proof of delivery. J3 owns that bridge, not this backend packet.

## Verification and boundaries

The complete registered PostgreSQL suite passes with real B1–B3 dependencies, source-backed sample fixtures, all four strata, incomplete/gapped/mixed-breach weeks, immediate payment stops, rollback and a deliberately broken publish function. Nine focused Deno/reader tests, the ops-api typecheck and ten schema-preflight tests pass.

This is backend-only. There is no new operations-screen panel, review form or human-session transport in the Jarvis tool in this packet. Those remain integration surfaces and must not be described as delivered UI. No production mutation, publication, message send or deployed acceptance occurred. Production schema readback remains blocked by the parent session's expired token.
