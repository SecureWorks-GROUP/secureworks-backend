# Per-job fact custody (B3)

The approved context target's sections 3 and 5 govern this packet. One model result becomes new facts, supersessions and retractions in one transaction. The original five-argument source RPC stays installed with its existing checks; the new nine-argument overload is exclusively `luna_v2`.

## Worker interface

`persist_luna_context_revision(p_run_id uuid, p_lease_token uuid, p_job_id uuid, p_events jsonb, p_new jsonb, p_supersedes jsonb, p_retracts jsonb, p_extractor_version text = 'luna_v2', p_tokens_in integer = 0) -> jsonb`

- `p_events`: 1–25 exact complete business_events rows supplied by B2. The function locks each row and compares every byte of its JSON representation. Missing source time, revoked attribution, a different job or previously acknowledged evidence prevents persistence.
- New facts: `{kind,text,confidence,source_event_ids,evidence_excerpt?,due_date?}`. Nine kinds only. The server creates stable IDs from run/index, attribution confidence from the minimum source confidence, and event date from the latest cited event's real event_at. Unknown extra fact fields are rejected. Nothing here writes money, job status, booking or outbound-message columns.
- Transitions: `{fact_id,fact_store,reason,source_event_ids,new_fact_index?,expected_fact}`. J2 injects `expected_fact` from the exact current-view row shown to the model, not from model output. Index is zero-based and is only valid for supersedes. Every fact must still belong to the job and match the snapshot under a row lock.
- V2 facts additionally match an independent full-row custody hash, detecting human edits even when their extractor tag remains. Legacy classifier facts can be retired when their extractor identity is recognised and the read snapshot remains unchanged. Unknown or human writers are held. Legacy CAS proves stability since the prompt read; it cannot reconstruct undocumented edits before that read.
- Result: `{outcome:'inserted'|'idempotent'|'held',facts_new,facts_superseded,facts_retracted,fact_ids}` for success, or held with reason. The exact committed request retries idempotently. Changing a committed run's request is held. Held paths perform no writes; validation errors roll back the entire function.

The function calls B1's finish RPC inside the same transaction and raises if fencing fails. Event receipts, run completion, source digests, new rows and retirement changes therefore commit together. Retirement provenance retains its new supporting source ids and run id; original facts remain stored.

## Source-date expiry

`context_fact_expiry(p_kind text,p_event_at timestamptz,p_due_date date = NULL)` is the sole new expiry helper. Current state ends at the next Perth midnight after the source day, even when already expired at extraction. Pending actions end at midnight after the stated date, or 168 hours after the source event; a stated date currently requires its literal ISO date in the cited source. Unsupported dates are rejected rather than assigned invented expiry. Quote issues last 336 hours and the view additionally hides them after a later quote is recorded. Proposals last 504 hours. Client preferences keep their fact and get `review_at` one Perth calendar year later. The remaining kinds have no expiry.

Existing model records default to `trust='legacy'`. Removed kinds are retained as retracted audit notes with their original kind in provenance and reason taxonomy_removed. Unknown historical event dates are not fabricated from write clocks. New facts store event_date, source IDs, attribution confidence, extractor_version and lifecycle explicitly.

The current-facts view filters both stores before paging, including top-level lifecycle/expiry and original provenance retirement flags. V2 facts also disappear from current reads when any cited source is missing, revoked, has no event time or is rebound to another job; stored history remains intact. It does not resurrect old permanent time-bound rows missing expiry. Dossier proposals now query status `pending`, matching the proposal writer.

## Verification and rollback

Both helper contracts are registered in the standard PostgreSQL migration suite, including a deliberate expiry break and rollback assertions. Fixtures use the real B1/B2 migrations and shared UUID source tables. Edge schema requirements register both fact tables' lifecycle fields and custody tables. The rollback stops extraction and revokes the new overload while preserving history and the filtered view.

Production schema/ledger readback is unavailable because the configured token returned HTTP 401 in the parent session. Local fixture checks do not claim live schema equivalence or deployed acceptance. No production mutation, model call, send or financial action is part of this packet.
