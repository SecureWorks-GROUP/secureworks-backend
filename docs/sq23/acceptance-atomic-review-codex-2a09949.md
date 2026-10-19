# Codex adversarial review of sq23/acceptance-atomic at 2a09949

Static, read-only. Saved 20 Oct 2026. Task task-mvfga2gj-v6pkl9.
**UNSOUND for switch-on.** The transaction structure is promising, but fingerprint validation, recovery ownership and gap reporting still have correctness holes.

Confirmed branch `sq23/acceptance-atomic`, HEAD `2a09949f47602dd45ec57cc564b32090f254ef3d`. Read revision 7 and the supplied patch. No edits, builds, installs, tests, database or network calls.

References below use `M` = `supabase/migrations/20261019230000_quote_accept_atomic.sql`, `T` = `supabase/migrations/20261019210000_fence_quote_option_jobs.sql`, and `C` = `supabase/tests/migration-contracts/20261019230000_quote_accept_atomic/contract.sql`.

**Must-fix**

1. **The fingerprint does not prove that send-quote decided from the state validated by the transaction.**  
   Reading a digest before several independent reads and comparing it afterwards does not exclude an A→B→A change: the decision can observe B while both digests describe A. Furthermore, the RPC locks the job and existing quote documents, but not the `run_acceptances` or `run_line_items` rows included in the fingerprint. Those inputs can change after validation.

   The encoding itself also loses information: `concat_ws` skips NULLs. Moving timestamp T from `accepted_at` to `declined_at`, with the other column NULL, produces the same encoded document despite changing its meaning.

   The normal party-rule fields are substantially covered, but this is not a sound snapshot protocol. Return the decision inputs and a revision together, then validate that revision under a locking protocol shared by their writers, or decide inside the transaction. Use structured, NULL-preserving encoding.  
   **Refs:** `M:79–91`, `M:139–160`; `supabase/functions/send-quote/index.ts:1723–1749`.

2. **The document re-read can retain stale guard inputs.**  
   The handler continues using the original `doc`. It compares the *derived* run label, but not the raw `run_label`, version, send timestamps or share token. Raw `run_label` controls the party query separately from the derived label.

   For example, changing raw `run_label` while leaving `data_snapshot_json.run.run_label` unchanged before the fingerprint read passes the comparison, but the handler queries the old party. Token rotation before that read is likewise not revalidated. Replace the original document with a freshly authenticated read, and bind all guard inputs to the validated snapshot.  
   **Refs:** `supabase/functions/send-quote/index.ts:1602–1630`, `:1667–1672`; `supabase/functions/send-quote/quote_party_view.ts:40–46`, `:113–128`.

3. **An acceptance timestamp is not a unique request ownership token.**  
   Two concurrent requests can generate the same millisecond timestamp. If one commits and the other loses its replay response, recovery finds the winner’s matching instant and incorrectly permits the second request to run follow-up work too. Both can send messages or request invoices.

   Recovery also returns `failed` when the reconciliation read fails or happens before an in-flight commit becomes visible. The handler then shows 503 even though acceptance may already have committed. Its “nothing was written” comment is false for that outcome.

   Persist an independent request identifier and reconcile ownership against it. Distinguish confirmed rollback from unknown commit outcome. Keep the original acceptance instant separately for R2.  
   **Refs:** `supabase/functions/send-quote/index.ts:1716`, `:1810–1817`; `supabase/functions/send-quote/quote_accept_atomic.ts:94–109`.

4. **R3 omits review-only failures and can actively hide them.**  
   If the run insert fails, work fails, and the review event succeeds, there is no unsettled run. The gap query does not return review events. Instead, that event suppresses `won_with_open_sibling`, so the surviving durable failure record disappears from this read.

   Other gaps:
   - Any qualifying group review event can suppress a different unresolved problem.
   - With `accepted_at IS NULL`, even an old review event suppresses the result.
   - Two won siblings with no open draft/quoted sibling are not detected.
   - Staff-advanced acceptance review events are not listed.
   - Supersede-off operation can produce `won_with_open_sibling` despite marking being intentionally disabled.

   Include unresolved review records explicitly and tie suppression/resolution to the particular obligation.  
   **Refs:** `M:230–236`, `M:289–309`; `T:475–484`.

5. **The new completion ledger records “done” despite failed or unfinished follow-up work.**  
   Deposit failures are caught or ignored, then `finishAtomicAcceptance` marks completion. Council email is still fire-and-forget when completion is recorded. Such failures disappear from `acceptance_downstream_unfinished`.

   Preserving existing customer responses does not require declaring these effects successful. Record incomplete/unknown outcomes, or explicitly describe this field as “handler reached its response,” without claiming follow-through completeness.  
   **Refs:** `supabase/functions/send-quote/index.ts:2047–2066`, `:2295–2305`, `:2335–2384`; `M:264–266`, `M:308–309`.

**Should-fix**

- **Isolate the atomic marker from the fallible strict-switch read.** Both are evaluated inside one caught expression; any error there resets `v_strict` to false. The atomic guarantee should not depend on SQL expression evaluation order avoiding the switch subquery. Read the marker first; only consult the strict switch when it is false. Add atomic-marker-on plus strict-unreadable coverage. The final raise itself is correctly outside the swallowing blocks.  
  **Ref:** `T:503–513`.

- **The contracts overstate coverage.** The fingerprint cases mutate only decline and snapshot run label, not every input. There is no handler-level proof of skipped writes, response parity, unknown commit recovery, timestamp collisions or follow-up ownership. The 16-case block checks status, one sibling mark and document acceptance; it does not prove the complete attempt/event/R3 state for each combination.  
  **Refs:** `C:209–229`, `C:386–405`; `supabase/functions/send-quote/quote_accept_atomic_test.ts:53–128`.

- **The combination failure injector uses one `NEW` record expression across incompatible tables.** `NEW.event_type` is referenced in an expression also used for `jobs` and `quote_option_settle_runs`. A missing-field failure can substitute for the intended injected failure. Use nested table-specific branches so the contract demonstrates the intended fault.  
  **Ref:** `C:350–353`.

- **The database’s stronger guarantees depend on a trusted caller.** It validates allowed status strings, not the correctness of the derived status or supplied run label; a whole-quote acceptance event is optional. That matches the present handler but not an unconditional database guarantee. Enforce required event presence for whole quotes, or narrow the contract explicitly.  
  **Refs:** `M:175–193`, `M:239–242`.

**Fine, with stated limits**

- Job-first, then quote-document locks in ID order serialize same-job RPC acceptances. The existing cross-job trigger uses bounded advisory acquisition and `SKIP LOCKED`, avoiding an indefinite sibling-row wait. This does not establish compatibility with every other writer’s lock order. **Refs:** `M:138–143`; `T:383–401`.
- Replay precedes fingerprint and eligibility checks once the job/document identity is resolved. It writes nothing. **Ref:** `M:149–157`.
- Status overwriting preserves the current staff-advanced acceptance semantics. The job update checks exactly one affected row. The marker is restored on success; an uncaught failure rolls back its transaction-local change with the failed statement/subtransaction. **Ref:** `M:215–236`.
- Sibling supersession and the contact-bearing run upsert reproduce the legacy predicates and fields. The no-contact run exception is explicit. **Ref:** `M:198–212`.
- Function EXECUTE grants and table grants restrict access to the service-role boundary; the search path is fixed. This assumes `public` is not writable by untrusted roles. RLS is disabled, so ACLs are the protection. **Refs:** `M:57–60`, `M:114–115`, `M:252–253`.
- The patch preserves the legacy acceptance writes and guards them on the atomic path. All three normal job-backed success responses call finish; the jobless fallback cannot have committed through this RPC. Existing success-page builders are unchanged. This is static inspection, not byte-for-byte handler execution proof.

**Switch combinations and R5**

With strict off, the combinations reduce to:

| Atomic | Supersede | Backend behaviour |
|---|---|---|
| Off/missing/unreadable | Off/missing/unreadable | Legacy split writes; trigger silent |
| On | Off/missing/unreadable | Atomic acceptance; no supersede work |
| Off/missing/unreadable | On | Legacy split writes; existing unrecorded-status residual remains |
| On | On | Atomic acceptance plus trigger; intended triple-failure rollback |

The Ops reader flag does not alter these backend branches. Its off/unreadable behaviour and treatment of existing marks require the separate reader review.

**Atomic → verified reader → supersede is a compatible order, but not a complete safety proof.** If atomic later becomes unreadable while supersede remains on, send-quote falls back to split writes. With strict on, that can again commit the document acceptance before refusing the status.

The 16 cases simulate plain/RPC paths; they do not exercise the actual atomic switch or Ops reader. The helper test proves readable-true selection only. Neither proves all three-switch integration.

Universal **R5 remains unmet by design** while preserving all other writers’ current behaviour. The owner must explicitly accept that staged scope; this branch cannot claim both universal R5 and unchanged warning-only writers.  
**Refs:** `C:330–343`; `supabase/functions/send-quote/quote_accept_atomic.ts:12–23`; `T:370–371`, `:493–516`.

**PostgreSQL contracts and slice 2**

Static inspection finds no inherent prohibition on the PL/pgSQL `EXECUTE`, transactional table renames, or rollback of `set_config` used here. `session_replication_role` requires the privileged runner. R4’s initial case checks full rollback, then correctly expects no gap. The break replacement should reach the expected R4 message, **provided setup and preceding privilege checks pass**; execution was not verified. **Refs:** `C:16–27`, `:96–110`, `:140–157`, `:323–325`; `break-contract.sql:3–15`.

Section 7 resolves the earlier missing transition definitions and correctly binds the neighbour note to the creation result plus link completion. However, its claim that lease predicates are “disjoint in time” is too strong: PostgreSQL `now()` is transaction-start time. A stale transaction can retain an apparently valid lease after a sweep. Require worker writes to check `state='running'`, clear/invalidate ownership on sweep/reconciliation, and specify the clock and transaction boundary.  
**Ref:** `docs/sq23/acceptance-atomic-design.md:98–104`.

Not verifiable statically: PostgreSQL 17 contract execution and exact break output, two-session races and deadlocks, deployed grants/schema, all 40 writers’ runtime parity, Ops reader integration, provider effects, and rendered customer-response parity.

Codex session ID: 01a154ed-4911-7c33-9f3a-7f3a2fbac7e8
Resume in Codex: codex resume 01a154ed-4911-7c33-9f3a-7f3a2fbac7e8
