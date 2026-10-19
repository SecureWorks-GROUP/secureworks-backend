# SQ-23 remedy design: an acceptance can never commit its status with no record

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
