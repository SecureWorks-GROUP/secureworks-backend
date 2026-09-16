# Per-job fact custody (B3)

The approved context target's sections 3 and 5 govern this packet. One model result becomes new facts, supersessions and retractions in one transaction. The original five-argument source RPC stays installed with its existing checks; the new nine-argument overload is exclusively `luna_v2`.

Landed on main as two forward migrations dated 2026-09-16, not the 20260911172000 draft that PR #838 first carried:

- `20260916120000_context_job_fact_custody.sql`: lifecycle, trust, event-date expiry, the per-job custody RPC, the current-facts view.
- `20260916120100_context_extraction_budget_scope.sql`: the D4 budget scope (outbound-only sources and archived holding jobs never take a model call).

## Why the migration was re-dated (ledger reconciliation)

Production's migration ledger (`supabase_migrations.schema_migrations`, read 2026-09-16) already carries `20260911170000_automation_switches`, `20260911170001_context_run_ledger` and `20260911171000_context_capture_attribution` (26 statements, hand-applied statement by statement on 14 Sep) under their own versions, plus six hand-applied rows that have no repository file: `20260914010227 context_capture_attribution`, `20260914010726 context_capture_attribution_indexes`, `20260914011949 b2_context_helper_fns`, `20260914012038 b2_context_attribution_fns`, `20260914012058 b2_context_extraction_fns`, `20260914022554 context_capture_stamp_and_rerun`. The production definitions of `context_extraction_candidates`, `context_extraction_events` and `context_contact_jobs` were read back and match the repository file byte for byte.

Consequences for this packet:

- The three ledgered B1/B2 files stay byte-identical to main. PR #838's earlier edits to them are dropped; nothing in them was still needed.
- `scripts/apply-pending-migrations.sh` iterates repository files, so ledger rows without a file are ignored and need no alias or exclusion. The six versions above are reserved: a future repository file at any of them would either be silently treated as applied (same name) or fail the run as a version/name collision (different name). Never reuse them.
- Both new migrations are re-runnable (guarded `ALTER`, `IF NOT EXISTS`, `CREATE OR REPLACE`, idempotent backfill predicates). `scripts/test-context-b3.sh` applies each twice on a disposable database and then runs the contracts.
- The post-apply schema gate reads `scripts/edge-function-schema-requirements.txt`; both versions are declared there so an `ops-api` deploy refuses until they are ledgered.

## Worker interface

`persist_luna_context_revision(p_run_id uuid, p_lease_token uuid, p_job_id uuid, p_events jsonb, p_new jsonb, p_supersedes jsonb, p_retracts jsonb, p_extractor_version text = 'luna_v2', p_tokens_in integer = 0) -> jsonb`

Unchanged from the PR #838 draft; the jarvis per-job extractor (jarvis #157) codes against it as is.

- `p_events`: 1 to 25 exact complete business_events rows supplied by B2. The function locks each row and compares every byte of its JSON representation. Missing source time, revoked attribution, a different job or previously acknowledged evidence prevents persistence.
- New facts: `{kind,text,confidence,source_event_ids,evidence_excerpt?,due_date?}`. Nine kinds only. The server creates stable IDs from run/index, attribution confidence from the minimum source confidence, and event date from the latest cited event's real event_at. Unknown extra fact fields are rejected. Nothing here writes money, job status, booking or outbound-message columns.
- Transitions: `{fact_id,fact_store,reason,source_event_ids,new_fact_index?,expected_fact}`. J2 injects `expected_fact` from the exact current-view row shown to the model, not from model output. Index is zero-based and is only valid for supersedes. Every fact must still belong to the job and match the snapshot under a row lock.
- V2 facts additionally match an independent full-row custody hash, detecting human edits even when their extractor tag remains. Legacy classifier facts (Haiku `context-fact-extractor:*` and per-event `context-luna-subscription:v1`) can be retired when their extractor identity is recognised and the read snapshot remains unchanged. Unknown or human writers are held.
- Result: `{outcome:'inserted'|'idempotent'|'held',facts_new,facts_superseded,facts_retracted,fact_ids}` for success, or held with reason. The exact committed request retries idempotently. Changing a committed run's request is held. Held paths perform no writes; validation errors roll back the entire function.

The function calls B1's finish RPC inside the same transaction and raises if fencing fails. Event receipts, run completion, source digests, new rows and retirement changes therefore commit together.

## Source-date expiry

`context_fact_expiry(p_kind text,p_event_at timestamptz,p_due_date date = NULL)` computes expiry; `context_supported_due_date(p_text text,p_event_at timestamptz)` deterministically parses cited date evidence without reading the extraction clock. Current state ends at the next Perth midnight after the source day. Pending actions end at midnight after the stated date, or 168 hours after the source event; a stated date must match a deterministic parse of its cited source (ISO, Australian day-first numeric, named months with optional ordinal, today/tomorrow anchored to the source event; bare or relative weekdays, two-digit years and conflicting dates are rejected). Quote issues last 336 hours and the view additionally hides them after a later quote is recorded. Proposals last 504 hours. Client preferences keep their fact and get `review_at` one Perth calendar year later. The remaining kinds have no expiry.

## Trust, kinds and the backfill

`trust` is a write-time fact. A `BEFORE INSERT` trigger (`context_fact_stamp_trust`) stamps `trust='luna'` and `extractor_version` for rows written by `luna_v2` or the per-event `context-luna-subscription:v1` extractor; every other writer stays `legacy`, which is what the 2026 Haiku classifier rows read as in `current_job_context_facts`.

The nine-kind closed list is a CHECK on `job_context` for Luna-trust rows (`job_context_kind_check`); `job_temporary_context` keeps its three-kind time-bound check. The four legacy operator-override kinds live in production (`payment_agreement`, `do_not_chase`, `internal_instruction`, `context_fact`) are deliberately left untouched under `trust='legacy'`: the stage-gate engine reads `payment_agreement` as a deposit override and the jarvis internal-instruction extractor still writes `internal_instruction`. Retracting or renaming them here (as the draft did) would silently break that reader. J3 retires the writer and owns tightening the constraint to every row.

The migration backfills existing rows from provenance they already carry: `extractor_version` from `provenance.extractor`; `lifecycle` from the legacy provenance lifecycle marker; and, for Luna v1 rows only, `event_date`, `source_event_ids` and the event-date expiry from `provenance.source_occurred_at`. That moves the v1 time-bound rows off the 24 hour write TTL the audit measured (25 of 45 dead on arrival) onto the event-date rules. A write clock or `extracted_at` never anchors an expiry, so undated legacy proposals leave current reads instead of receiving an invented date. `current_job_context_facts` hides a time-bound row with NULL `expires_at` only when `trust='legacy'`; live five-argument `persist_luna_context_revision` writes (no `expires_at`) stay readable.

## D4: budget scope

`context_job_extractable(jobs)` is false only for holding jobs, marked by `metadata.do_not_schedule = true` (the SWF-PDF-BUCKET row also carries `metadata.purpose = 'pdf_unlock_bucket'`, no contact and an internal site; the marker, not the number or `jobs.status`, is the rule). Quiet, closed or archived jobs are not rechecked unless something new lands; that is the fresh-inbound rule on candidates and events, not an archived-status exclusion. `context_extraction_candidates` admits a job only on unreceipted non-outbound evidence; `context_extraction_events` includes outbound rows only when the same batch has unreceipted inbound or internal evidence, so our own messages are read beside the client's and never extracted alone. Names, signatures, the per-day one-run guard, the 400 cap and the reservation functions are unchanged.

## First production apply failed: ambiguous `source_id` (2026-09-16)

PR #838 merged and the deploy lane's auto-apply of `20260916120000` failed with SQLSTATE 42702 (`column reference "source_id" is ambiguous`) and rolled back, leaving both new migrations unledgered. The view's `unnest(visible.source_event_ids) source_id LEFT JOIN business_events b ON b.id=source_id` was ambiguous because production `business_events` carries `source_table` and `source_id`; the registry fixture and the B3 lane fixture did not, so the contracts passed twice locally. The fix qualifies every join and subquery reference (`AS cited(source_event_id)`, `rev.run_id`, `run.id`) and both test schemas now mirror the production `business_events` envelope, so main's original text fails locally the same way production did and the corrected text applies. Rule for the next migration on these tables: read `information_schema.columns` live before writing an alias, and never let a bare alias share a name with a column of any table in the same query.

## Verification and rollback

- `supabase/tests/migration-contracts/20260916120000_*` and `20260916120100_*`: registered contracts, rollbacks, and deliberate breaks (expiry function nulled; extractable predicate forced true).
- `scripts/test-context-b3.sh` with `CONTEXT_B3_TEST_DATABASE_URL`: disposable database, production-shaped view first, both migrations applied twice, then `context_b1_contract.sql` and `context_b3_contract.sql`.
- The B2 contract's outbound-tail case now asserts the D4 rule.
- Rollbacks stop extraction, revoke the v2 overload, drop the trust triggers, and restore the 20260911171000 extraction functions. Columns and backfilled values stay as audit truth.

No production mutation, model call, send or financial action is part of this packet. Production reads on 2026-09-16 were read-only (ledger, function definitions, fact populations, the holding job's metadata).
