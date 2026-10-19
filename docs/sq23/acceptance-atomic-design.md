# SQ-23 remedy: an acceptance can never commit its status with no record

**Revision 7: the one current contract.** Earlier text (the original and revisions 2 to 6) is in `acceptance-atomic-design-history.md`, marked superseded, and is not operative.

Status: built on the isolated branch `sq23/acceptance-atomic` (base `sq23/quote-option-jobs` `996d234`). Not merged, not deployed, nothing live, no switch on. Provenance: routine Codex orchestration under standing scope. Requirement: CIO R1 to R5 (secureworks-projects `ctx/cio-20261019` `ef20d6f`). Design and build only; no approval of any merge, deploy, switch or send, and no residual accepted.

## 1. The gap
When a grouped fence job moves into a won status, the supersede trigger does three writes: the run record, the work, and a review event if the work fails. If all three fail, the status change commits with only warnings (Codex round 7 at `26619d6`, pinned by SQ-23 contract group 7 case c).

The trigger cannot simply refuse, because send-quote commits the customer's acceptance as separate requests and ignores the status write's errors:
- whole quote: `job_documents.accepted_at` (index.ts ~1716), then `jobs.status` (~1989)
- per run: `run_acceptances` upsert (~1838), then `jobs.status` (~1884)

Refusing would leave an accepted quote on an unaccepted job.

## 2. The guarantee (slice 1)
With `quote_accept_atomic_v1` on, **every committed public acceptance of a document with a job** has these in one transaction:
- its accepted document;
- the whole-quote sibling supersession, or the run acceptance;
- its job status, written as today;
- its whole-quote `quote_accepted` job_event;
- its attempt row.

The supersede trigger runs inside that transaction. If its run record, work and review event all fail, it raises `quote_option_unrecorded` and everything rolls back. The customer gets the existing retry page (503) with nothing committed.

Outside the guarantee, behaving exactly as today: jobless documents; every other status writer (unless the strict switch below is on); every acceptance while the switch is off.

What a "record" means: the review list is unsettled run rows **plus** `quote_option_review_needed` events. With the supersede switch off, missing or unreadable, the trigger writes nothing by design. Ungrouped jobs never run it. A failed run insert followed by successful work leaves marks and events but no run row.

## 3. Switches (all seeded off)
| Switch | Read by | On means |
|---|---|---|
| `quote_option_supersede_v1` | the SQ-23 trigger | accepting a grouped option marks its siblings |
| `quote_option_ops_reader_v1` | the Ops reader (PR 1091), not this branch | Ops reads the marks |
| `quote_accept_atomic_v1` | send-quote, every acceptance, uncached | the atomic path |
| `quote_option_strict_record_v1` | the trigger's final site only | **every** writer is refused when nothing can be recorded |

Only a readable `true` turns any of them on. Off, missing or unreadable is off.

**Compatible switch-on order** (for the owning review): `quote_accept_atomic_v1` first, so the split writes end while the trigger is still silent. Then `quote_option_ops_reader_v1`, once the readers are verified. Then `quote_option_supersede_v1`.

**`quote_option_strict_record_v1` is an owning-review decision, not settled.** Once on, a staff status change (ops-api `update_job_status`, staff screens, crons, any of the 40 writers) could be refused whenever the trigger cannot record. It should never go on before the atomic path.

## 4. Database (`20261019230000_quote_accept_atomic.sql`)
- **`accept_quote_document_atomic(document, accepted_at, job_status, fingerprint, run_label, accept_event)`**: SECURITY DEFINER, fixed search_path, service role only. It runs in this order:
  1. lock the job, then the job's quote documents in id order;
  2. **replay**: if an attempt row exists for the document, return it and write nothing (before any eligibility check);
  3. **stale**: if `quote_acceptance_fingerprint(job)` differs from the caller's, write nothing;
  4. refuse an unsent, accepted, declined or superseded document, or an accepted same-recipient sibling;
  5. check the status: whole quote `accepted`/`partially_accepted`; run also `quoted`;
  6. write the document, then the sibling supersession (whole quote) or the run acceptance upsert (run, contact present; with no contact, today's upsert fails silently, so none is written here either);
  7. write the job status exactly as today (overwrite), with the marker `sw.quote_accept_atomic='on'` set around that one statement only. The previous value is saved and restored, and a zero-row update raises;
  8. if staff had already moved the job past `draft`, `quoted`, `partially_accepted` or `accepted`, write a `quote_acceptance_review_needed` event (`accepted_after_status_moved`). Today's overwrite is kept;
  9. write the acceptance event (whole quote) and the attempt row, with `downstream_started_at` set at commit.
- **Party rules stay in send-quote.** The function does not re-derive the status. send-quote reads the fingerprint (everything the rules read: the job's quote documents, run acceptances and run line items, timestamps as epoch numbers) **before** its own reads. The function compares it under the lock. Any change after that first read gives `stale`, and the customer retries. This replaces "decide inside the lock" without porting the rules to SQL.
- **The trigger's final site** (SQ-23 migration, outside every swallowing block) raises only if the marker is on **or** the strict switch reads true. Otherwise it warns as today.
- **The marker is cooperative, not proof of origin.** Any SQL writer that sets it gets the raise. This is a trusted-writer assumption: EXECUTE is revoked from PUBLIC, anon and authenticated.
- **`quote_acceptance_attempts`**: one row per document (unique). The service role may only read it and set `resolved_at`/`resolved_by`.
- **`quote_acceptance_finish_downstream(document, outcome)`**: sets `downstream_completed_at` once.
- **`quote_acceptance_gaps(grace)`** (R3), read-only, ids, codes and instants only:
  - `settle_run_unsettled`
  - `won_with_open_sibling`: a status written without its trigger, or a lost record (meaningful while the supersede switch is on)
  - `acceptance_downstream_unfinished`

## 5. send-quote (`index.ts`, `quote_accept_atomic.ts`)
- Switch off, missing or unreadable: today's code path. Every legacy write is unchanged, behind `atomicDocId === null`. The only addition is one uncached switch read per acceptance with a job.
- Switch on:
  1. read the fingerprint, then re-read the document and compare its key fields (retry page on any failure or difference);
  2. run today's guards and snapshot unchanged;
  3. compute the status with today's rules;
  4. for a whole quote, read the job and contacts and build today's `quote_accepted` detail;
  5. call the function.
- Outcomes:
  - `replay`: today's "Already accepted";
  - `refused`: today's page for that reason;
  - `stale` or a confirmed failure: the retry page with nothing written;
  - transport error: read the attempt row back. It counts as this request's commit only if `accepted_at` matches this request's instant; otherwise the retry page.
- After commit the legacy writes are skipped, and the follow-up work runs as today, in this request only. `finishAtomicAcceptance` runs before each of the three acceptance responses. A crash in between leaves the attempt for a person (`acceptance_downstream_unfinished`), never a re-run. A replay never runs follow-up work.

## 6. Proof (none run locally: the Mac's heavy-work hold)
Migration contract `supabase/tests/migration-contracts/20261019230000_quote_accept_atomic/`:
- switches seeded off; privileges; definer and search_path
- **R4**: the triple failure through the function rolls back fully (no accepted document, status, marks, events or attempt), the marker does not outlive the call, and the gap read lists nothing; positive control
- **parity**: the same failure from a plain status UPDATE (what all 40 writers send) stands with the strict switch false, NULL, missing, or unreadable (57014, 42501, 55P03, 42P01, P0001, P0004); with it on it is refused; the marker however set raises
- **combinations**: supersede (false, missing, unreadable, true) × path (plain, RPC) × triple failure (off, on), 16 cases, each rolled back
- whole quote, replay, stale, fingerprint inputs and TimeZone independence, bad inputs, staff-advanced overwrite, run path with and without contact, finish-once, gap read, and a trigger bypass listed by R3
- rollback contract and break contract (the break removes the marker; R4 must fail)

send-quote unit test `quote_accept_atomic_test.ts`: the switch is on only for a readable true; a fingerprint read failure gives null; the outcome mapping and the arguments passed; a database error with no attempt row is never accepted; lost-response recovery for this request only; finishing is a no-op on legacy and never throws.

**Not proven here:** two-session concurrency (the runner is single-session); a full send-quote handler parity run with the switch off (index.ts has no handler harness; the legacy writes are untouched and guarded). Both go to the independent check.

## 7. Slice 2 (designed, not built): a per-step ledger for the follow-up work
This replaces the single at-most-once window with resumable steps. It fixes the three bb7b6b7 findings.

- **Table `quote_acceptance_steps`**: rows are seeded at commit. States are `pending`, `running`, `done`, `failed_retry_safe`, `failed` and `unknown`. Each row holds its frozen payload, `claim_token`, `lease_until`, `dispatch_started_at` and `result`.
- **Worker transitions:**
  - The claim is the only write without a token condition: `pending`/`failed_retry_safe`, or `running` with an expired lease and no dispatch, moves to `running` with a fresh token. Exactly one claimer wins.
  - Every later worker write is fenced by `claim_token = :mine AND lease_until > now()`.
  - The external call is made only after `dispatch_started_at` is written under that fence.
- **Expiry sweep (its own transition, not a worker write):** `UPDATE ... SET state='unknown', swept_at=now() WHERE state='running' AND lease_until <= now() AND dispatch_started_at IS NOT NULL`. No token is needed, because an expired worker can no longer write (its fence needs `lease_until > now()`), so the sweep and any worker write are disjoint in time. A running step with an expired lease and no dispatch is not swept; it is re-claimable.
- **Human reconciliation (its own transition):** a service-role function moves `unknown` to `done` or `failed`. It requires `WHERE state='unknown'`, a named person (`reconciled_by`), `reconciled_at` and a note. It never touches `running` rows, and it is never automatic.
- **Dependencies bind results:** `neighbour_note:<contact>` depends on `neighbour_contact:<contact>` (it reads `contactId` from that step's stored `{contactId, opportunityId}`) **and** on `neighbour_contact_link:<contact>` (ordering only). It starts only when both are `done`, and its payload's contact id comes from the creation step's result, never from a placeholder.
- **Business success, not HTTP:** a step is `done` only on a 2xx response whose body has the step's success field. Send and money steps (`client_update`, `deposit_invoice`, `council_email`, `ghl_stage`, `neighbour_contact`) are at-most-once; any doubt after dispatch is `unknown`, never auto-retried, and reconciled with the Sent Items rule used in the containment work.

## 8. Owners and open questions
- send-quote code owner: **not recorded** (register, `ORG.md` and `architecture/edge-functions.md` name none). Business owners of the quote stage are Khairo (fencing) and Nithin (patio) (`ORG.md` lines 13 and 14). Builder: this Sales thread. Reviewers: Codex (second model) and the independent check.
- For the owning review:
  1. the strict switch (raise for every writer), given the staff-block risk;
  2. the switch-on order above;
  3. whether a failed atomic acceptance should keep showing the retry page, or a "received, we will confirm" page (a new customer-facing page; Sales and Marnin);
  4. slice 2 before any switch-on.
