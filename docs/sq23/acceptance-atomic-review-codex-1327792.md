**SOUND WITH CHANGES**

The marked RPC fixes the strict-induced split when both database changes are installed and the RPC is reachable. The submitted proof has blockers, and the gap detector and parity claims need correction.

Verified branch `sq23/acceptance-atomic-c4`, HEAD `132779293aa07397ecb75164a8e1844862dd8460`. Static review only.

References:

- **M**: `supabase/migrations/20261019230000_quote_accept_atomic.sql`
- **T**: `supabase/migrations/20261019210000_fence_quote_option_jobs.sql`
- **C**: `supabase/tests/migration-contracts/20261019230000_quote_accept_atomic/contract.sql`
- **A**: `supabase/functions/send-quote/quote_accept_atomic.ts`
- **I**: `supabase/functions/send-quote/index.ts`
- **H**: `supabase/functions/send-quote/accept_atomic_handler_test.ts`
- **D**: `docs/sq23/acceptance-atomic-design.md`

**Must-fix, ranked**

1. **High — C:352: the C4 contract stops before exercising the transitions.**  
   C:99–100 already created A1’s original, live, **unaccepted** quote document. C:342 adds two accepted run documents without retiring that original. Consequently M:523’s `bool_and(d.accepted_at IS NOT NULL)` is false for A1. The assertion expects two listed jobs but gets only A2.

   This also demonstrates a real detector mismatch: the handler ignores a contactless whole-job quote when contact-specific parties exist; this SQL counts it. Isolate the C4 fixtures or temporarily retire and subsequently restore the original document. Do not simply weaken the assertion.

2. **High — M:513–524: “every party accepted” is not the handler’s predicate.**  
   It counts documents, not parties, and requires every non-superseded, non-declined document to be accepted.

   Concrete misses include:

   - The inherited contactless quote above.
   - An unsent alternative for an already accepted whole-quote party.
   - An older, unaccepted run revision that remains unmarked while the current revision is accepted.
   - A superseded historical decline: M:518–521 excludes the entire job indefinitely.
   - A single-party job left partial after its only acceptance: `count(*) >= 2` excludes it.

   Conversely, two accepted documents do not establish two accepted parties or satisfaction of required parties represented only by `run_acceptances`. The detector can report a legitimately partial job as fully accepted.

   Either make this match the acceptance decision, with explicit parity fixtures, or name and document it as a narrower document-condition heuristic. The present “final party’s status did not land” interpretation is too strong.

3. **Medium — C:370: invalid ordinary SQL string escaping.**  
   ` '... last contact\'s ...' ` uses a backslash inside an ordinary string. With PostgreSQL’s normal `standard_conforming_strings=on`, this does not escape the apostrophe. Use `contact''s`. Fixing the earlier assertion alone will expose this subsequent failure.

4. **Medium — A:238–239; D:49–52,79: the fallback preserves an unmarked acceptance path.**  
   `PGRST202` can mean a stale PostgREST schema cache, not just an unapplied or rolled-back migration. With strict and atomic stored true, a handler selecting legacy can receive that error and send the unmarked PATCH, reproducing the original strict split.

   The fallback is compatible with the requested legacy behaviour, but the guarantee must explicitly exclude fallback operation. Deployment instructions must require RPC visibility through PostgREST before strict activation, and strict-off protection during rollback or compatibility fallback. “Both migrations live” alone is insufficient.

**Should-fix, ranked**

1. **Medium — D:55–60: qualify exact parity and timing.**  
   The write payload and logical clock-read position match `d98903c`; elapsed timing and all failure outcomes cannot be identical:

   - Missing RPC adds a round trip before the PATCH.
   - Its `accepted_at` is captured **before** that failed RPC and reused, not recaptured immediately before the PATCH.
   - Later event timestamps, cost-freeze execution and deposit requests consequently occur later.
   - RPC availability/permissions/cache introduce failure modes that the previous PATCH did not have.
   - Relative to local `main`, the atomic feature-flag read already adds an awaited request before acceptance, even when off.

   Say “same intended mutations, payload rules and sequencing when the corresponding requests succeed,” rather than identical timing or guaranteed status delivery.

2. **Medium — H:295–376: strengthen the claimed parity proof.**  
   These tests establish routing and selected outcomes, not exact event, cost-freeze and deposit timing parity. The timestamp assertion at H:323 only checks that it is a string. There are no new controls for `42883`, a returned transport error, or a thrown/lost RPC response. Add those, plus ordering and payload assertions, before claiming those properties are proved.

3. **Low — M:530–565: document remaining gap boundaries and add discriminating controls.**
   - `accepted_run_document_without_run_acceptance` checks only document pointer plus accepted status, not matching job/contact/run coordinates.
   - `run_acceptance_document_not_live` uses an inner join: a null/missing document pointer is invisible. It also ignores `p_since`.
   - SQL run-label classification does not reproduce the TypeScript normalisation of empty/whitespace labels.
   - The whole-quote sibling kind deliberately includes unsent older documents and excludes later-created documents; it diagnoses a condition, not proof that supersession failed.

**Answers to the remaining questions**

**1. Strict, marker lifetime and atomic precedence**

The two `/accept` job-status writes are covered at I:2028 and I:2137. I found no additional job-status write in that acceptance branch. Variation acceptance and decline are separate paths.

M:624–630 sets the marker locally and restores its previous value. An uncaught error rolls the statement back, including its marker change. T:508–513 checks atomic first, so legacy cannot suppress atomic refusal. The exemption covers both directions across the won boundary.

This closes c4a–c4e **through strict on the marked path**, not through the compatibility PATCH, old in-flight handlers, or an old trigger body. Ordinary legacy failures remain possible.

The fallback does not double-write a committed status: `PGRST202` does not execute the RPC; `42883` is a PostgreSQL error that aborts that statement. Other returned errors cause no PATCH, and thrown errors propagate without fallback. However, `42883` can originate inside a function, so the comment “nothing ran” should say “no transaction committed.”

**2. Database parity**

Against `d98903c`, successful legacy calls preserve:

- Status selection.
- Whether `accepted_at` is written; partial/quoted writes retain its previous value.
- The JavaScript clock-read position.
- Document/run writes, event construction, cost-freeze conditions and deposit-request conditions/order.
- Continued follow-up after a returned status error.

Atomic acceptance is unchanged by these handler edits. Missing-job writes remain successful no-ops. Invalid values remain errors.

The changes are the RPC endpoint, transaction-local marker, deployment dependency, added gap outputs, compatibility round trip and associated timing/failure differences described above. Local `main` is `efb28a57…`; it also lacks the preceding atomic-switch read. This is not verification of current remote main or production.

**3–4. Fixtures and final-site reachability**

After fixing the blocking fixture and string issues, the transition cases do reach the final site:

| Transition | Work failure actually exercised |
|---|---|
| A1 partial → accepted, A2 partial | Review insertion for the partial sibling |
| A2 partial → accepted, A1 accepted | Multiple-winner review insertion |
| A1 accepted → partial, A2 accepted | Review insertion for partial A1 |
| A1 accepted → quoted, A2 accepted | Setting A1’s superseded mark |
| Both markers, A1 quoted → accepted | Multiple-winner review insertion |

The run insert and subsequent failure-review insert are also forced to fail. Thus the partial cases reach the gate through **review failure**, not the mark injector as their comment suggests.

The A1/A2 reset at C:396–404 is appropriate for subsequent cases: it restores quoted/unmarked/null acceptance timestamps and deletes the added contacts/documents/run rows without invoking the trigger. If fixture repair changes the original document, its reset must restore that too.

The run-missing and superseded/declined-document fixtures discriminate their stated conditions. The sibling fixture’s first assertion alone does not exclude the newer sibling, but its subsequent zero-row assertion does. The decline fixture discriminates the document-decline exclusion, but uses three documents of the same party and does not test a declined run row, historical superseded decline, unsent document or single-party boundary.

**5. Handler fakes**

The c4c/c4d fakes appear valid for their asserted paths:

- c4c combines `ACC_N` with the pending acceptance; both parties qualify. `PRICING_RUN` resolves and supplies positive shares, and both contacts exist, so two deposit requests are expected.
- c4d has distinct contacts; the accepted sibling does not block this party. The pending acceptance completes both parties, producing `accepted` and the direct HTTP 200 response.

These are not vacuous because they assert one legacy RPC with status `accepted`. However, the fake never persists that RPC’s result: it proves the requested status, not that the database status lands. HTTP status alone also does not verify page content.

**6. Deployment coupling**

The stated ordering and in-flight warning are correct, subject to finding 4. Also state that editing an already-applied migration will not install its changed body: any environment already carrying these versions needs an explicit reviewed upgrade. Seed-off ordering is sufficient only for a genuinely fresh application.

**7. Ignored-status-error residual**

D:81 is accurate when read as **attempted follow-up after a returned error**. It does not mean invoices or messages necessarily succeed. Thrown errors instead reach the handler’s outer error response. Cost freeze remains conditional on the intended accepted status; run deposits remain conditional on the run decision. This fix preserves that residual.

**Not verified:** execution of contracts or handler tests, PostgreSQL runtime behaviour, live schema/cache/grants, deployment state, concurrency, actual invoices/messages, or current remote main. No files were edited and no build, installation, tests, database or network operations were run.

Codex session ID: 01a15558-97ca-7040-a32c-33c9ece3bf7d
Resume in Codex: codex resume 01a15558-97ca-7040-a32c-33c9ece3bf7d
