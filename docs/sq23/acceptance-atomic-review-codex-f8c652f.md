# Codex adversarial review of acceptance-atomic-design.md at f8c652f

Saved 23:46 Perth, 19 Oct 2026. Task task-mvffcafe-2m280e. Static, read-only.

HEAD confirmed: `f8c652f043499d4d4e6451485a279d264efadd75`.
Branch: `sq23/acceptance-atomic`.

**Verdict: SOUND WITH CHANGES.** The transaction approach is sound. The design is not ready to enable.

Only local source reads were performed. No edits, builds, installs, tests, database or network calls.

**Must-fix, ranked**

1. **Move acceptance validation and status calculation inside the concurrency boundary.**

   R1 locks one document but accepts a status calculated from an earlier snapshot. Two different contacts can both calculate `partially_accepted`, then commit sequentially. Every document is accepted, but the job stays partial.

   Two sibling options for one contact can also pass the outside guard together. If the job stays partial, the expected-status set allows both RPCs.

   Serialize by job before locking documents. Recheck document eligibility, accepted siblings and party completion under that lock. Atomically supersede the same recipient’s whole-quote alternatives. Preserve the existing party rules exactly. Validate `p_job_status`, or derive it rather than trusting it.

2. **Separate confirmed rollback from unknown commit outcome.**

   A database refusal can safely return 503. A lost RPC response does not prove rollback. The transaction may have committed before the connection failed.

   Then R3 skips every downstream action. Retrying hits `Already accepted` at `index.ts:1607`. The customer gets neither normal confirmation nor a resumed invoice flow.

   Define a durable acceptance identity and repeat-call result. Reconcile uncertain outcomes. Any resumed invoice or notification work needs its own duplicate protection. “Timeout rolls back” is only true for an actual database cancellation before commit.

3. **Define exactly what “no record” means, and cover trigger bypasses.**

   R2 only addresses the triple-failure branch. Currently:

   - An unreadable supersede switch returns without a run record (`migration:360–369`).
   - A failed run insert followed by successful work can leave no run record. The settlement update matches no row.
   - Ungrouped jobs and non-won-to-non-won changes never invoke this trigger (`migration:499–504`).

   If the guarantee is “every acceptance has its accepted document”, R1 supplies that. If it means “every applicable supersession has durable accounting”, R2 needs stronger conditions. State the switch dependency and the treatment of unreadable configuration explicitly. R4’s review list also misses failures recorded only in `job_events`.

4. **Scope the GUC to the status statement, not merely the transaction.**

   `set_config(..., true)` normally ends at transaction completion. It does not ordinarily leak across pooled requests. But it remains visible to nested calls and later statements in the same transaction. Another SQL-capable writer can set the same custom GUC.

   Therefore it is a cooperative marker, not proof of RPC origin. `SECURITY DEFINER` and service-role-only execution protect the RPC entry, not the marker.

   Save and restore the previous value around the status update, including handled failures. Explicitly revoke default PUBLIC execution. Document the trusted-writer assumption. Otherwise “every other writer behaves exactly as today” is too strong.

5. **Specify the final raise and expected-status refusal precisely.**

   The raise belongs at the current final warning site (`migration:490–493`), outside all swallowing exception blocks. There it can propagate and roll back the document, job and trigger writes together. A raise inside the work block would be caught at line 469.

   The conditional job update must check that exactly one row changed. Zero rows must raise.

   `draft/quoted/partially_accepted` is a plausible admission set, but changes existing behaviour. Today the public path can accept a document after staff advanced the job. Define how that case is resolved instead of returning an endlessly retryable 503. The conditional update handles staff changes committed first; it cannot prevent a later staff transaction changing the status again.

**Should-fix and scope**

- External invoice, GHL and notification work should remain outside the transaction. Their failure leaves a committed acceptance with incomplete follow-through. That already happens today. The new unknown-response window makes it easier to skip *all* follow-through.
- Business evidence can still fail independently. The design must not describe the accepted document as proof that those events exist. A durable pending-action record would make recovery explicit.
- Whole-quote acceptance does not currently write `run_acceptances`. Preserve that distinction.
- Per-run exclusion is acceptable for a narrowly labelled whole-quote slice. It is **not** acceptable for the universal claim “an acceptance can never commit its status with no record”. Either narrow the release guarantee or cover per-run before claiming it.
- Switch-off behaviour need not change, but “byte-for-byte today” needs qualification: reading the new switch adds an operation. Missing or unreadable must select legacy behaviour. Keep RPC-only checks, status restrictions and retries out of that branch. Preserve jobless documents and per-run routing.

**Tests to add**

The six groups are useful but insufficient.

- Concurrent different-contact acceptances: final status is fully accepted.
- Concurrent same-contact sibling options: only one accepts, including when another party remains outstanding.
- Concurrent decline, supersession and staff status change, in both ordering directions.
- Zero-row job update, missing job, invalid target status and ineligible document.
- Run insertion failure with successful work; work failure with either surviving record; failure of both records.
- Supersede switch off, missing and unreadable; atomic switch independently on and off.
- Final raise propagation through real trigger nesting, with complete rollback.
- GUC restoration, nested calls, same-transaction later writes and pooled-connection reuse.
- Database cancellation versus committed RPC with lost response.
- Retry after commit, proving no duplicate invoice or notification.
- Failure after each downstream step, recording the exact surviving state.
- Switch-off and per-run parity, including customer response, call order and payloads.

