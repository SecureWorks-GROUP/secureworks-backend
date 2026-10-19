**NOT BOUNDED / FIX EXISTS**

Verified branch `sq23/acceptance-atomic`, HEAD `d98903ce31d85b0dc0d25485e6f116ad2bb32495`. Local static review only.

“NOT BOUNDED” means section 3 does not fully describe the affected transitions or the detection limits. The trigger-local aggregate is correct; the end-to-end safety claim is not.

References below:

- **T** — `supabase/migrations/20261019210000_fence_quote_option_jobs.sql`
- **M** — `supabase/migrations/20261019230000_quote_accept_atomic.sql`
- **I** — `supabase/functions/send-quote/index.ts`
- **A** — `supabase/functions/send-quote/quote_accept_atomic.ts`
- **P** — `supabase/functions/send-quote/quote_party_view.ts`
- **D** — `docs/sq23/acceptance-atomic-design.md`

1. **High: a refused final acceptance can be completely absent from the gap list.**  
   **M:488–494; I:1974–1981,2025–2028,2135–2142.**

   Concrete sequence:

   - Job is `partially_accepted`.
   - Handler selects legacy because its atomic read fails, or reads off before activation.
   - The final party’s document acceptance commits.
   - On the run path, its `run_acceptances` upsert also commits.
   - The proposed status is `accepted`.
   - The trigger reaches triple failure, reads both flags true, and refuses that status.

   The job remains `partially_accepted`. **M:493 explicitly excludes it.** The won predicates also exclude it, and legacy creates no atomic attempt. Triple failure provides no settle row or review event. With no unrelated finding, the gap list can be empty.

   This applies to both whole-quote multi-party acceptance and run acceptance. **D:63’s assertion that this leaves a listed `accepted_document_job_not_won` is therefore too strong.**

2. **High: strict also refuses departures from won status, not just entries.**  
   **T:439–460,493–530,542–547; D:55,63,88.**

   The trigger fires when the old and new **won predicates differ**, in either direction. Its final strict gate does not require the new status to be won.

   Therefore a legacy acceptance that overwrites a staff-advanced won job with `partially_accepted`, or a run decision of `quoted`, can commit its document/run acceptance and then have that overwrite refused. The prior won status survives.

   `accepted_document_job_not_won` excludes this at **M:492**. `won_without_acceptance_event` may list it, but an existing event matching the job’s unchanged `accepted_at` hides it at **M:476–479**.

   This also broadens the staff-blocking scope: a staff reversal from won to quoted/lost/cancelled can be refused under triple failure. Section 3 should say **crossing the won boundary**, not only moving into won.

3. **High: legacy continues acceptance follow-up after an ordinary returned status error.**  
   **I:2027,2035–2096,2135–2152,2168–2180.**

   Both legacy status updates ignore the returned error. Subsequent work uses the intended status and precomputed acceptance decision.

   Thus the split can extend beyond document-versus-status:

   - run acceptance and acceptance evidence committed;
   - job status refused;
   - expected-cost freeze attempted;
   - run deposit-invoice requests attempted;
   - whole-quote acceptance event describing the intended status still inserted.

   Those are code-reachable attempts, not proof that a downstream invoice or message succeeds. Section 3 currently understates this consequence.

4. **Medium: the gap read is a current-condition diagnostic, not a complete acceptance reconciliation.**  
   **M:427–512; D:65,97–98.**

   It never compares `run_acceptances` with the document, the intended status, or an acceptance attempt. In addition to the partial/won cases above:

   | Instance | Detection limit |
   |---|---|
   | Accepted run row survives while its document becomes superseded or declined | **M:491** excludes the document; no independent run-row check exists. |
   | Accepted document’s timestamp precedes `p_since` | **M:494** excludes it, even if the inconsistency arose recently. |
   | Job is won but the new acceptance’s status update failed | **M:492** excludes the document; historical matching event can suppress the other finding at **M:476–479**. |
   | Run upsert fails but document and status commit | No run-consistency predicate. A won-event finding may appear incidentally; a partial job can remain unlisted. |
   | Whole-quote sibling-document supersession fails | **I:1877–1879** logs and continues. The gap reader’s sibling checks concern **jobs**, not sibling quote documents. |
   | Legacy handler stops after acceptance while job already partial/won | No legacy attempt row, so **M:510–512** cannot report the unfinished handler. |

   Conversely, a listed accepted document on a non-won job does **not prove a refused status**: later legitimate reversal also produces it. The RPC even permits a run result of `quoted` (**M:270; P:88**), so the detector cannot universally equate that state with failed acceptance.

   `p_since` is correctly described as an acceptance-time bound in **D:92**, but it cannot support “every instance” or serve as a change cursor. **D:97’s “every legacy acceptance” remains overstated**, despite the qualified wording in section 2a.

The complete split sequence boundary is as follows:

| Sequence | Result |
|---|---|
| Handler atomic read fails while stored atomic/strict are true | Legacy selected at **A:25–28**. Strict can later refuse after acceptance commits. |
| Handler reads atomic false/missing/NULL; atomic becomes true before trigger gate | Same split, provided strict is true at that gate. |
| Strict turns on after the handler selected legacy | Same split if atomic is also true when the trigger reads both. Strict changing alone does not force a handler that selected atomic onto legacy. |
| Supersede becomes true before the trigger’s initial read | Enables the work and possible triple-failure refusal. |
| Supersede reads false/missing/unreadable initially | Trigger returns at **T:370–371**; this strict refusal cannot occur. Other legacy failures remain possible. |
| Supersede turns off after that initial true read | Does not cancel the work already entered: the final gate does not re-read supersede. |
| Atomic or strict is off/unreadable at the final aggregate | No flag-based refusal there. Earlier legacy writes can still split through unrelated errors or interruption. |
| Handler selected atomic, then either flag changes | RPC stays atomic; marker controls refusal independently. No fallback to legacy occurs on RPC failure. |
| Whole quote, legacy | Document, sibling-document supersession, status and event are separate commits. |
| Run, legacy | Document, run upsert and status are separate commits; run upsert/status returned errors are ignored. |
| Lost legacy response or process interruption between requests | Earlier commits survive. A lost document-update response can stop the handler after commit; retry sees “Already accepted” at **I:1642** rather than repairing it. |
| Lost atomic RPC response | Commit outcome can be unknown, but core writes remain one transaction. Recovery checks request identity; an unrecovered commit leaves an unfinished attempt after grace (**A:183–200; M:510–512**). Follow-up can still be incomplete. |
| Staff status-only write | Refusal rolls back that statement. It does not by itself create a document split. Separate preceding staff writes can survive; that depends on the writer’s transaction boundary. |
| Concurrent legacy decline/supersession/acceptance | Prechecks and unconditional document update are separate (**I:1642–1652,1852–1855**). A stale acceptance can coexist with a later decline/supersession, or concurrent options can interfere. Atomic fingerprint/locks address this for the atomic path, not legacy. |

For the **strict-induced** split, all of these additional conditions are necessary: grouped job, crossing the won boundary, supersede read true, run-record/work/review failure, and either marker on or both flags true at the final gate. A flag discrepancy alone is insufficient.

A sound fix exists, with different compatibility costs:

| Approach | Assessment |
|---|---|
| **(a) Always enter one RPC; choose mode inside it** | **Sound if that RPC owns all acceptance writes.** Read the switch once, retain the selected mode, and let the trigger consume that decision rather than reinterpret global flags. A mode-off branch must explicitly prevent flag-based strict refusal, or deliberately accept rollback semantics. Locks on jobs do not lock feature flags; merely moving the read into an RPC is insufficient if it returns “legacy” for the handler to execute later. |
| **(b) Signal legacy through the PostgREST status update** | **Sound for preventing this strict-induced refusal, but not all legacy splits.** A dedicated, protected request coordinate could be included in the same UPDATE as status and consumed only for that transition. A separately written or persistent `legacy=true` marker is unsound: it can fail, race, or exempt later staff writes. Requires schema, privilege and replay design. A request header is also cooperative caller input, not proof of origin. |
| **(c) Strict reads transaction/row context** | **Sound when scoped to the actual operation.** Best implemented through a status RPC that sets a transaction-local legacy marker, updates status and restores it. Atomic marker must win over any exemption. Unmarked staff writes retain the existing strict policy. Reading “there is an accepted document/run row” is unsound: historical acceptance does not identify this writer or transaction. |
| **(d) Remove global strict; retain atomic marker only** | Closes this particular cross-request strict hazard and preserves the all-off path. But removes strict protection from staff writers and leaves R5 unresolved. It is a policy change, not an equivalent implementation. |

**Recommendation:** for this bounded repair, replace the two legacy status PATCHes with a small service-role status RPC that explicitly marks **this transaction as legacy**. The trigger should use:

1. atomic marker → enforce atomic refusal;
2. explicit legacy marker → preserve legacy warning behaviour;
3. otherwise → apply the existing staff strict policy.

This removes the second request’s global flags as authority over an already-committed legacy acceptance. Preserve the existing status/`accepted_at` write shape, and do not retry an uncertain RPC through an unmarked PATCH.

With all switches off, this can preserve the existing database effects and error-handling semantics, although the endpoint and deployment dependencies change. It **does not repair existing legacy splits or make legacy atomic**. Old in-flight handlers remain exposed until drained; a persistent rollout flag cannot prove their absence.

For complete document/run/status integrity, prefer **(a)** as the subsequent architectural change. That necessarily changes all-off failure and concurrency behaviour: separate commits become one commit/rollback, locks serialize work, and new RPC/snapshot failures can prevent acceptance. It cannot honestly be advertised as exact legacy parity.

Tests needed, but not run:

- Real handler tests for both whole-quote and run paths, injecting each flag-read/flip sequence above.
- PostgreSQL contract tests for partial→accepted **and won→partial/quoted**, with triple failure and explicit legacy/atomic/unmarked contexts.
- Prove legacy context cannot leak into the next operation or suppress atomic enforcement.
- Gap fixtures for partial-job refusal, surviving run row with superseded/declined document, old `p_since`, historical matching event, and failed run upsert.
- Lost-response tests before/after each legacy commit and atomic RPC commit; verify retry does not duplicate follow-up.
- All-switches-off parity, including failure behaviour; two-session tests if adopting the single acceptance RPC.

**Not verified:** runtime PostgreSQL behaviour, test results, live schema or deployment, production frequency, downstream invoice/send outcomes, or a complete staff-writer inventory. No files were edited; no build, install, tests, database or network operations were run.

Codex session ID: 01a1554a-d4c5-78c0-8c7f-7b990316d24d
Resume in Codex: codex resume 01a1554a-d4c5-78c0-8c7f-7b990316d24d
