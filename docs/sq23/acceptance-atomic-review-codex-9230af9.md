# Codex adversarial re-review of sq23/acceptance-atomic at 9230af9

Static, read-only. Saved 20 Oct 2026. Task task-mvfhbf8k-bf67tf.
**SOUND WITH CHANGES** for building towards switch-on. No remaining must-fix found in this static review. Nothing was switched on.

Confirmed branch `sq23/acceptance-atomic`, HEAD **`9230af9`**. Reviewed both supplied patches and the current source. No edits, builds, installs, tests, database or network calls.

References:

- **M**: `supabase/migrations/20261019230000_quote_accept_atomic.sql`
- **C**: `supabase/tests/migration-contracts/20261019230000_quote_accept_atomic/contract.sql`
- **D**: `docs/sq23/acceptance-atomic-design.md`
- **U**: `supabase/functions/send-quote/quote_accept_atomic_test.ts`

| Previous finding | Result | Evidence |
|---|---|---|
| 1. Legitimate NULL neighbour rejected | **RESOLVED** | `M:272–280` accepts NULL when a NULL-contact item exists or the run is empty; non-NULL requires membership in that exact job/run. This matches every possible value of the legacy selector at `M:150–151`. |
| 2. Resolutions hide reopened conditions | **RESOLVED** | `M:74` restricts resolution kinds. `M:412–428` derives both conditions directly; `M:434–435` explicitly bypasses resolution suppression for them. |
| 3. Design accuracy | **PARTLY** | Signatures are corrected at `D:50,53`; tested-subset wording at `D:95`; erroneous `xmin` claims removed. Some contradictory prose remains below. |

The neighbour contracts cover mixed NULL acceptance, all-NULL acceptance, an off-run contact refusal, empty-run NULL acceptance, and single-contact NULL refusal/contact acceptance (`C:432–457`). I found no legitimate legacy choice rejected by the new predicate.

The remaining resolvable references are durable occurrence identifiers:

- `settle_run_unsettled`: settlement-run ID (`M:400`), newly allocated for each trigger run.
- `review_needed`: event ID (`M:404`), identifying the particular review event.
- `acceptance_handler_unfinished`: document ID (`M:430`), valid because `document_id` is unique in the attempt table (`M:47`) and subsequent calls replay the existing attempt (`M:218–222`).

No resolvable kind still uses `xmin`, timestamps or mutable group membership as its occurrence key. Document identity remains sufficient under the enforced one-atomic-acceptance-per-document model.

**Should-fix, ranked**

1. **Finish aligning the design with the implementation.**
   - `D:68` still says nothing except resolutions/`resolved_at` suppresses rows. Conditions also disappear when corrected; settled runs and finished handlers disappear naturally.
   - `D:79` still describes NULL as valid only when the run has no items. Include NULL-contact items.
   - `D:71` ambiguously suggests both condition kinds require the supersede switch. Only `won_with_open_sibling` does; `more_than_one_won` remains listed with that switch off (`M:415,425`).
   - `D:76` says the switch read is the only addition to the legacy path; UUID generation and no-op finish calls also occur.

2. **Complete the regression coverage for the stated boundary.**
   - `C:432` says both mixed-run choices are legitimate, but only NULL is exercised on that mixed run. Add a separate acceptance fixture for its non-NULL choice.
   - `U:137–139` verifies acceptance arguments only with NULL run/neighbour values. Add non-NULL argument plumbing.
   
   These are coverage gaps, not observed implementation failures.

Executable signatures agree across migration/grants, down migration, contract helper/direct calls, rollback contract, break replacement and send-quote arguments. This round introduces no executable signature change.

The break contract should still fail at the intended **R4 message**, `C:118–119`: its replacement omits the marker, permits the warning-only status change, and returns successfully; the following assertion rejects that success. Actual execution remains unobserved.

With **atomic and strict both off**, the whole-branch diff preserves legacy guards, pre-reads, write payloads and response paths. Atomic off alone is insufficient if strict is independently enabled.

Not verifiable statically: contract/unit/break execution, concurrent-session behaviour, live schema and grants, deployed behaviour, full handler/follow-up execution, and Ops-reader integration. This verdict is not switch-on approval.

Codex session ID: 01a15507-e059-7532-8f03-a37a8f8dd56c
Resume in Codex: codex resume 01a15507-e059-7532-8f03-a37a8f8dd56c
