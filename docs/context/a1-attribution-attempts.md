# Safe attribution (A1-BE)

Slice A1-BE of the context build (`INTEGRATION.md` Wave 2; `sms.md` §4b rule 8; `cadence.md` §6 step 7, §9.A item 11). Migration `20260924060000_context_attribution_attempts`. Requires F1 (`unplaced`, `candidate_job_ids`, `context_unplaced_for_job`). The runtime half (A1-RT, `attributePending` in secureworks-jarvis) is a separate slice.

A message Luna cannot place gets one answer and rests as `unplaced`, instead of being asked about again every pass.

Service-role APIs:

- `attribute_context_event_with_luna(p_event_id uuid, p_job_id uuid, p_confidence numeric, p_outcome text)`. Outcome `job` places the row (`luna`, or `thread` when a racing thread winner exists) and needs a contact candidate and confidence of at least 0.8; below 0.8 it rests as `undecided` with `metadata.luna_below_floor`. Outcomes `several` and `undecided` set `unplaced` (step 5, no job), keep `candidate_job_ids`, and record `metadata.luna_outcome`. Every answer writes the attempt record. The legacy three-argument function is unchanged (live body, `admin_bucket` on no pick, no attempt record) so the deployed runtime keeps working until A1-RT; it has no default on `p_outcome`, so the two never collide.
- `record_attribution_error(p_event_id uuid, p_code text)`: a failed ask, with a lowercase code (at most 64 characters, never message text). Backoff 30 minutes, then 2 hours, then the next Perth day; at most 2 asks per row per Perth day. A changed candidate list (stored `candidate_job_ids`, else the contact's open jobs) restarts the counts.
- `context_attribution_due(p_limit integer = 50)`: `pending_luna` rows an ask is allowed for now, oldest first, at most 200; empty while the attribution lane is off.
- `reserve_context_model_call('attribution', …)` refuses beyond 60 attribution reservations a Perth day with outcome `attribution_budget` (nothing reserved). The 400 daily cap is checked first and still answers `cap`. Other phases are not counted.

`context_attribution_attempts` (RLS on, service_role SELECT only) holds counts and codes: attempts under the current candidate list, asks on the current Perth day, last and next ask, outcome, last error code, candidate hash. Its one writer is the private `context_attribution_record_attempt`.

`unplaced` rows are never selected by `rerun_context_attribution` or the due read. Reopening them on a named event (new job lead window, new candidate, new message in the same conversation) belongs to the placement slices (P1b, P4).

Pre-image: production's three-argument Luna function was hand-applied by ledger row `20260914012038` and differs from the `20260911171000` file by one comment line only; the guard and the contract setup pin the live text (`md5 48eabf7e…`). Rollback: `supabase/rollbacks/20260924060000_context_attribution_attempts_down.sql` restores the live reservation body byte for byte and drops the rest; rested rows stay `unplaced`. Contract: `supabase/tests/migration-contracts/20260924060000_context_attribution_attempts`.
