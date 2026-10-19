# SQ-23 acceptance-atomic design: history (superseded)

**Superseded by `acceptance-atomic-design.md` revision 7. Nothing below is operative.** Kept for provenance: the original design and revisions 2 to 6, each written after a Codex re-review (f8c652f, 7f41354, 9e2da34, 9694135, 31b2603, bb7b6b7).

## SQ-23 remedy design: an acceptance can never commit its status with no record

Status: design, on an isolated branch `sq23/acceptance-atomic` (base `sq23/quote-option-jobs` `996d234`). Not built, not merged, nothing live. Provenance: Codex orchestration under standing user authority, on Marnin's direction of 19 Oct 23:41 (via the coordinator). Not human approval of any merge, deploy, switch or send.

## The gap (Codex round 7 at `26619d6`)
When a grouped fence job moves into a won status, the supersede trigger does three independent writes:
1. it inserts a run record
2. it does the work
3. it writes a review event if the work fails

If all three fail, the status change still commits with only warnings. The trigger cannot fail the status change instead, because send-quote's public acceptance commits the customer's document acceptance first and the job status after, as separate requests, and ignores the status write's errors:
- `supabase/functions/send-quote/index.ts` ~1716: `job_documents.accepted_at`
- ~1884 and ~1989: `jobs.status`

Failing the status change would therefore leave an accepted quote on an unaccepted job.

## Current semantics to keep (until the owning review decides)
- Every status writer other than the new atomic path behaves exactly as today. This covers ops-api `update_job_status`, crons, staff screens and the per-run path. The status stands, and the residual stays pinned (contract group 7).
- What the customer sees on success is unchanged. A failed read before acceptance already shows `quoteViewRetryPage()` (503) and writes nothing. The new path uses that same page for the new failure case.

## Remedy: one transaction for the acceptance and the job status, behind a switch

**R1. A database function `accept_quote_document_atomic(p_document_id, p_accepted_at, p_job_status)`.** It is SECURITY DEFINER, has a fixed search_path and is callable by the service role only. In one transaction it:
1. locks the document row, and refuses if it is already accepted or declined;
2. sets `job_documents.accepted_at`;
3. sets `jobs.status` (and `accepted_at` when the status is `accepted`) only if the job is still in an expected status (`draft`, `quoted`, `partially_accepted`). Otherwise it refuses, and nothing is written;
4. sets a transaction-local marker, `set_config('sw.quote_accept_atomic', 'on', true)`, before step 3.

**R2. The supersede trigger, in the atomic context only.** If it finds the marker set and its run record, work and review event have all failed, it raises `quote_option_unrecorded` instead of warning. The whole acceptance transaction then rolls back:
- no `accepted_at`
- no status change
- no marks

The customer gets the retry page and can accept again. Without the marker (every other writer), it keeps today's behaviour.

**R3. send-quote, behind `quote_accept_atomic_v1` (seeded off).** On the whole-quote acceptance path (`sourceRunLabel === null`, the ~1716 and ~1989 writes), send-quote calls R1 in place of the two separate writes. A refusal or error from R1 returns `quoteViewRetryPage()` (503) before any later step:
- sibling supersession
- evidence
- invoice
- GHL push
- notifications

With the switch off, the code path is byte-for-byte today's. The per-run (`run_label`) path is out of scope for this slice. It keeps today's writes and is listed as a follow-up.

**R4. Recovery for anything already committed.** No backfill. `quote_option_settle_runs` rows that are unsettled and unresolved remain the review list. The warning-only residual cannot occur on the atomic path.

## What this does not change
- What the customer sees on a successful acceptance.
- Any quote, email, SMS or invoice content.
- The 25 existing duplicate sets, and the 283 parked texts.
- Live switches: `quote_option_supersede_v1`, `quote_option_ops_reader_v1`, `fence_same_site_guard_v1` and the new `quote_accept_atomic_v1` all stay off.

## Adversarial tests to write (migration contract plus send-quote unit)
1. R1 commits both writes, or neither, in each of these cases:
   - a forced failure on the document update
   - a forced failure on the job update
   - an unexpected job status
   - a document that is already accepted
   - two concurrent calls on one document (one wins, the other refuses)
2. With the marker set and all three trigger writes failing, R1 rolls back fully: the document is not accepted, the status is unchanged, and there are no marks.
3. Without the marker, the same failure keeps today's behaviour (contract group 7, unchanged).
4. send-quote with the switch off makes exactly today's calls, in today's order. This test fails if any call changes.
5. send-quote with the switch on:
   - an R1 refusal or error returns 503 and runs no later step, which the test checks by counting intercepted calls;
   - a later retry succeeds.
6. A cancel or timeout inside R1 rolls back both writes.

## Owners
- send-quote code owner: **not recorded**. Neither the register, `ORG.md` nor `architecture/edge-functions.md` names one. The business owners of the quote stage are Khairo (fencing sales) and Nithin (patio sales) (`ORG.md` lines 13 and 14).
- Builder: the Sales SQ-23 thread. Reviewers: Codex (second model) and the independent check.

## Open questions for the owning review
- Should a failed atomic acceptance show the retry page, or a "we received your acceptance, we'll confirm" page with a durable intent row? The second needs a new customer-facing page, so it needs Sales and Marnin.
- Does the per-run (neighbour) acceptance path need the same treatment before the switch goes on?

## Revision 2, after the Codex adversarial review (`acceptance-atomic-review-codex-f8c652f.md`)

Verdict: **sound with changes, not ready to enable.** The design changes as follows, before any build.

1. **Serialize by job, decide inside the lock.** R1 takes the job id and the document id. It works in this order:
   1. lock the job row first;
   2. lock the job's quote documents in id order;
   3. re-check that the document is eligible (not accepted, declined or superseded);
   4. re-check the accepted siblings and the parties, under the lock;
   5. supersede the same recipient's other whole-quote options in the same transaction;
   6. **derive** the new status (`accepted` or `partially_accepted`) with today's party rules, ported exactly, rather than taking it from the caller.

   The job update must change exactly one row. Zero rows raises.
2. **Unknown commit outcome is not rollback.** Each acceptance carries a durable identity: a new `quote_acceptance_attempts` row keyed by the document and a request id from the page. A repeat call with the same identity returns the committed result instead of "Already accepted". A lost response is then reconciled by repeating the call.

   Downstream steps (invoice, GHL, notifications, evidence) stay outside the transaction, as today. Each one runs once per attempt, behind its own idempotency key. Where one is unproven, it is listed, not claimed.
3. **What "a record" means.** The guarantee is narrow: **every committed whole-quote acceptance has its accepted document and its job status in the same transaction.** It is not "every supersession has durable accounting". Those are separate:
   - When the supersede switch is off, missing or unreadable, the trigger writes nothing by design.
   - Jobs that are not grouped never run the trigger.
   - A failed run insert followed by successful work leaves marks and events but no run row.

   The review list is unsettled run rows **plus** `quote_option_review_needed` events.
4. **The marker is cooperative.** The status statement saves the previous value of `sw.quote_accept_atomic` and restores it, including when a failure is handled. The trigger reads it only at its final raise site, which sits outside every swallowing block (the current warning site). The design states the trusted-writer assumption: any SQL-capable writer could set the marker. EXECUTE is revoked from PUBLIC explicitly.
5. **A job that staff have already advanced.** If the job is no longer `draft`, `quoted` or `partially_accepted` when the customer accepts, the document is still accepted (as today) and the status is left alone. The page shows today's success. A `quote_option_review_needed` event (reason `accepted_after_status_moved`) is written in the same transaction. This avoids a 503 that could be retried forever.
6. **Scope.** This is a whole-quote slice only. The release note must not claim that per-run (neighbour) acceptances are covered. Per-run is a follow-up, and it must land before any universal claim.
7. **Switch off.** Today's code path, plus one switch read. A missing or unreadable switch selects the legacy path. Jobless documents and per-run routing are unchanged.

Tests: Codex's list in the review replaces the six above. Build follows only after this revision is re-reviewed.

## Revision 3, after the Codex re-review at `7f41354`

The re-review marked items 1, 3 and 4 resolved. Items 2 and 5 were partly resolved. This revision closes both.

**Item 5 (staff-advanced jobs): today's semantics are kept, so no owner decision is needed.** Revision 2's point 5 is withdrawn.
- On the atomic path the job status is written exactly as today, overwriting whatever status it holds.
- "Exactly one row" therefore holds whenever the job exists. A missing job raises and rolls back.
- When the overwrite replaces a status other than `draft`, `quoted` or `partially_accepted`, the same transaction also writes a `quote_option_review_needed` event (reason `accepted_after_status_moved`) recording the old status. This adds information and changes no behaviour.

**Item 2 (acceptance identity, replay and downstream recovery):**
- **Identity is the document.** A document can be accepted at most once, so the identity is `job_documents.id`. This survives reloads, retries and new tabs, and needs no client-generated id. A new table `quote_acceptance_attempts` has one row per document (unique `document_id`), inserted **in the same transaction** as `accepted_at` and the job status. It holds the derived status, the previous job status and `committed_at`.
- **Replay before rejection.** send-quote, on the atomic path only, checks for an attempt row before the "Already accepted" check. If it finds one, it returns today's success page and resumes the steps below. "Already accepted" without an attempt row keeps today's response (legacy acceptances).
- **Downstream steps ledger.** A table `quote_acceptance_steps` has one row per attempt and step, unique on (attempt, step). The steps are the sibling-option supersession (now inside the transaction, so not a step), evidence, the invoice, the GHL push and the notifications. Each step runs as follows:
  1. claim the row (`pending` to `running`, with a lease);
  2. do the work;
  3. mark the outcome `done` or `failed`, or `unknown` when a send may have happened.

  A replay re-runs only `pending` steps, `failed` steps whose own result says retry-safe, and `running` steps with an expired lease that never started their external call. A step marked `unknown` is never re-run automatically; it waits for a person to reconcile it, using the same Sent Items rule as the containment work. External calls carry an idempotency key, `<attempt id>:<step>`, where the provider supports one. Where it does not, the step is listed as at-most-once with the `unknown` hold.
- **Lost response.** If the RPC response is lost, the customer's retry or reload finds the attempt row and resumes. If the transaction did not commit, there is no attempt row, the document is not accepted, and the retry runs the full acceptance again.

**The guarantee, stated once.** On the whole-quote atomic path, every committed acceptance has its accepted document, its job status and its attempt row in one transaction. Every downstream step has a ledger row whose state is `done`, `failed`, `unknown` or resumable. Per-run (neighbour) acceptances, legacy acceptances and every other status writer are outside this guarantee and behave as today.

**Tests:** Codex's list in the review, plus:
- a replay after a committed attempt with each step in each state;
- an expired lease, both before and after the external call;
- the `unknown` hold, which must never auto-resend;
- a staff-advanced overwrite writing its review event.

## Revision 4, after the Codex re-review at `9e2da34`

Item 2 (staff-advanced jobs) is resolved. Item 1 (replay and recovery) has four remaining points, and each is answered below.

**1. Replay inside the lock.** R1 runs these steps under the job and document locks, in this order:
1. Look up the attempt row for the document. If one exists, return its stored result: the derived status and the step list. Stop there, with no overwrite, no new event and no eligibility check.
2. Otherwise apply the eligibility rules. Accepted, declined or superseded with no attempt row returns today's refusal.
3. Otherwise accept.

send-quote's earlier check only saves a round trip; the RPC is the authority.

**2. Steps are seeded at commit.** The same transaction that writes the attempt row inserts every step row this acceptance needs, in state `pending`. Which steps apply (job type, contacts, deposit configuration) is computed under the lock from the same snapshot. A crash after commit therefore always leaves a complete list of resumable steps. Steps are never rebuilt afterwards.

**3. Lease fencing and the point of no return.**
- Each claim is a compare-and-set: `pending`/`failed_retry_safe` → `running` with a fresh `claim_token` and `lease_until`, and the claimer keeps the token.
- Every later write by that worker is conditioned on the token, so a worker whose lease has expired cannot write.
- Before any external call the worker sets `dispatch_started_at` under its token. That is the durable "may have started" marker.
- A step found `running` with an expired lease:
  - **no** `dispatch_started_at`: goes back to `pending`;
  - **with** `dispatch_started_at` and no outcome: becomes `unknown`. This also covers a crash before the outcome was saved.
- `unknown` is never retried automatically.

**4. Effects, keys and reconciliation, per step.** These are taken from the whole-quote path in `send-quote/index.ts` (~2000 to 2290 at `9e2da34`). Each step holds one external effect. The payload is frozen into the step row at commit, and a replay sends the frozen payload.

| Step | Effect | Stable key | Provider idempotency | Reconciliation if `unknown` |
|---|---|---|---|---|
| `expected_costs` | `freezeExpectedCostsOnAcceptance` (internal, write-once) | job id | Write-once in our database | Re-read the frozen row. Internal, so it is safe to retry. |
| `job_event` | `job_events` insert (`quote_accepted`) | `<attempt>:job_event`, stored in the event | Our database: unique key | Re-read. Safe to retry. |
| `ghl_stage` | ghl-proxy `move_stage` to accepted | `<attempt>:ghl_stage` | None known | Read the opportunity's stage in GHL. "Already at accepted" counts as done. Stage moves are idempotent by target, so a retry is safe once the stage has been read. |
| `client_update` | ops-api `send_client_update` (customer message) | `<attempt>:client_update` | Not verified | Customer send: never resend automatically. A person checks the message log (GHL conversation or Sent Items). |
| `ghl_note` | GHL contact note (and neighbour contact create plus note) | `<attempt>:ghl_note[:contact]` | None | Read the contact's notes for the key text. Low harm. A person decides. |
| `deposit_invoice` | ops-api `send_acceptance_invoice` (creates and sends an invoice) | `<attempt>:deposit_invoice[:contact]`, passed to ops-api | ops-api's own idempotency must be confirmed; not assumed | Money and a customer send: never resend automatically. A person checks Xero and the send record. |
| `council_submission` | ops-api `create_council_submission` | `<attempt>:council` | Not verified | A person checks the council submissions list. |
| `council_email` | Resend email "Next Steps & House Plans", plus the GHL log and the `po_communications` row | `<attempt>:council_email`, sent as the Resend `Idempotency-Key` | Resend supports an idempotency key (to be confirmed for this account) | Customer send: never resend automatically. A person checks Resend's log or Sent Items. |

Steps whose provider idempotency is unproven run **at most once**: claim, mark dispatch started, call, record the outcome. Any doubt leaves them `unknown`. This is the same rule the containment work uses, extended past Sent Items to Xero, GHL and the council list as the table shows.

**Unchanged by this revision:** the switch is off by default; per-run and legacy paths behave as today; what the customer sees is unchanged.

## Revision 5, after the Codex re-review at `9694135`

**Lease fencing (was partly resolved).**
- A claim and every later write are compare-and-sets on both conditions: `claim_token = :mine AND lease_until > now()`.
- `dispatch_started_at` is written by such a compare-and-set. The external call is made **only after** that write is confirmed to have changed one row.
- A worker whose lease has run out cannot record dispatch, so it never calls.
- Outcome writes use the same condition. If an outcome write fails because the lease ran out after dispatch, the step is left for the expiry rule, which makes it `unknown`.

**Compound steps are split into single-effect steps, with dependencies.** A step can name the step it depends on and read that step's stored result. A dependent step starts only after the step it depends on is `done`.

| Step | Depends on | Effect | Stored result |
|---|---|---|---|
| `neighbour_contact:<contact>` | none | ghl-proxy `create_contact_and_opportunity` for a neighbour with no GHL contact | `{contactId}` |
| `neighbour_contact_link:<contact>` | `neighbour_contact` | `job_contacts.ghl_contact_id` write (internal; compare-and-set from NULL) | none |
| `neighbour_note:<contact>` | `neighbour_contact` | GHL note on that contact. The payload is frozen at commit with a placeholder; the contact id is taken from the result of the step it depends on. | none |
| `ghl_note` | none | GHL note on the main contact | none |
| `council_email` | none | Resend email | `{providerMessageId}` |
| `council_email_ghl_log` | `council_email` | GHL conversation log | none |
| `council_email_record` | `council_email` | `po_communications` row (internal, unique key) | none |

The other steps from revision 4 are single-effect already. `deposit_invoice` stays one step because ops-api creates and sends the invoice in one call. Its recovery is ops-api's own: the step passes `<attempt>:deposit_invoice[:contact]`. Until ops-api is shown to honour that key, the step is at-most-once and lands in `unknown` on any doubt.

**Success means the business result, not just HTTP.** A step is `done` only when **both** of these hold:
- the response is 2xx;
- the response body has the step's success field (`success:true`, or the id the step stores).

A 2xx with an error or unknown body is `unknown` for send and money steps, and `failed` for the rest. A non-2xx follows the same classifier as the containment work: an explicit unknown, 408, 429, 5xx, an unreadable body or a transport error is `unknown`. Only a reply that says it is retry-safe makes the step retryable.

**GHL stage reconciliation.** "The opportunity is already at accepted" counts as done only if the step had recorded no dispatch, or if the opportunity's stage history shows the move at or after `dispatch_started_at`. Otherwise the step is `unknown`, for a person to check. The move is idempotent by target, so the risk is only that nothing gets recorded, never a duplicate.

## Revision 6, after the Codex re-review at `31b2603`

**Claim versus fencing.** These are two separate statements.
- **The claim** is the only write without a token condition: `UPDATE ... SET state='running', claim_token=:fresh, lease_until=now()+:lease WHERE id=:step AND (state IN ('pending','failed_retry_safe') OR (state='running' AND lease_until <= now() AND dispatch_started_at IS NULL)) RETURNING claim_token`. Exactly one claimer can win it.
- **Every write after the claim** is fenced by both conditions: `claim_token=:mine AND lease_until > now()`.
- A `running` step with an expired lease **and** `dispatch_started_at` set can never be claimed again. The expiry sweep moves it to `unknown`.

**Neighbour note waits for the link.** `neighbour_note:<contact>` depends on `neighbour_contact_link:<contact>`, not only on `neighbour_contact`. The note goes out only after the link to `job_contacts` is recorded.

**Contact and opportunity creation stays one external call, treated as one effect.** ghl-proxy `create_contact_and_opportunity` creates both inside one server call, and send-quote cannot split it. Rules for the step:
- It is at-most-once.
- Its stored result is `{contactId, opportunityId}`.
- If its outcome is uncertain, the step is `unknown`. A person checks GHL by the neighbour's phone or email. ghl-proxy's own contact de-duplication by phone or email limits the harm to a possible extra opportunity, never an extra contact.

This is listed as a known limit, not claimed as atomic.

**GHL stage: the timing heuristic is withdrawn.** The stage history cannot attribute a move to this attempt. So the `ghl_stage` step is:
- at-most-once: claim, record dispatch, call, record the outcome;
- on any doubt after dispatch, `unknown`. A person checks the opportunity and marks the step done or failed.

A move to the same target stage is harmless if repeated, but no automatic resolution is claimed.
