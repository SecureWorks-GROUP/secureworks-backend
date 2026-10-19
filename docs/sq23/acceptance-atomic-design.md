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
