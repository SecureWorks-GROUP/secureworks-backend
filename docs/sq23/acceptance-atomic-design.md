# SQ-23 remedy: an acceptance can never commit its status with no record

**Revision 10: the one current contract** (after the Codex reviews of `2a09949`, `1d41398` and `ad95394`, saved beside this file, and the independent check at `2a09949`). Earlier text (the original and revisions 2 to 6; revision 7 is replaced in place) is in `acceptance-atomic-design-history.md`, marked superseded, and is not operative.

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

**`quote_option_strict_record_v1` is an owning-review decision, not settled.** Once on, a staff status change (ops-api `update_job_status`, staff screens, crons, any of the 40 writers) could be refused whenever the trigger cannot record. It should never go on before the atomic path. The order is compatible but not a full safety proof: if `quote_accept_atomic_v1` later reads unreadable while supersede is on, send-quote falls back to the split writes, and with strict on that again commits a document acceptance before refusing its status. Switch-off order is the reverse of switch-on.

**An unreadable strict switch is off** (a timeout, cancel, permission or any other error while reading it), exactly like a missing row: the status change is kept with today's warning, plus a distinct warning `strict switch unreadable (SQLSTATE), treated as off`. So with the strict switch on, a read timeout silently keeps a status change that would otherwise be refused. This is predictable and logged, and it is a decision for the owning review. The alternative, unreadable means refuse, would block staff status changes whenever the switch read times out. The atomic path never depends on this read: the marker is checked first, and the independent check confirmed the full rollback even when the strict read fails or hangs.

**Simultaneous winners stay live (CIO's accepted direction, 12:23Z).** If two options of one group are accepted at the same time in separate sessions, both end up won. The trigger writes a `more_than_one_option_won` review event, clears any marks, and settles its runs. The independent check at `2a09949`, with two real sessions, saw exactly this every time, with nothing unrecorded. The gap read lists the group as `more_than_one_won` until a person resolves it. That matches the direction; nothing here picks a winner.

## 4. Database (`20261019230000_quote_accept_atomic.sql`)
- **Snapshot protocol.** The party rules stay in send-quote and are not ported to SQL.
  - `quote_acceptance_snapshot(job)` returns the decision inputs (the job's quote documents with the party-rule columns and `share_token`, its run acceptances, its run line items in id order) **and** their fingerprint from one statement, so both describe one database snapshot. A change between separate reads (A to B to A) cannot split them.
  - The fingerprint is structured and NULL-preserving (jsonb with explicit nulls, timestamps as epoch numbers, independent of TimeZone and DateStyle). It covers every field the guards and party rules read: documents (ids, contact, raw and snapshot run label, sent flag, token, version, send, claim, accept, decline, supersede and create instants), run acceptances (including status and decline instant), run line items.
  - `accept_quote_document_atomic` locks the job, then its quote documents, run acceptances and run line items, each in id order, and recomputes the fingerprint. Equal means the locked state is the state the decision was made from. Rows another writer inserts after the lock are ordered after this acceptance (stated limit).
- **`accept_quote_document_atomic(document, share_token, request_id, accepted_at, job_status, fingerprint, run_label, accept_event)`**: SECURITY DEFINER, fixed search_path, service role only. In order:
  1. take the locks above;
  2. **replay**: an attempt row for the document returns its stored result, including the request that committed it, and writes nothing (before any eligibility check);
  3. refuse a token that is not the document's current one; `stale` if the fingerprint differs;
  4. refuse an unsent, accepted, declined or superseded document, or an accepted same-recipient sibling;
  5. check the status vocabulary (whole quote `accepted`/`partially_accepted`; run also `quoted`), and that a whole quote carries its acceptance event;
  6. write the document, then the sibling supersession (whole quote) or the run acceptance upsert (run, contact present; with no contact today's upsert fails silently, so none here either);
  7. write the job status exactly as today (overwrite), with the marker `sw.quote_accept_atomic='on'` set around that one statement only (saved and restored; a zero-row update raises);
  8. staff-advanced job (past `draft`, `quoted`, `partially_accepted`, `accepted`): a `quote_acceptance_review_needed` event, today's overwrite kept;
  9. the acceptance event and the attempt row, with `request_id`.
- **Trusted caller.** The database does not re-derive the status or the run label: it trusts the service-role caller's party rules, which are bound to the fingerprinted snapshot. The guarantee is narrowed to that.
- **The trigger's final site** (SQ-23 migration, outside every swallowing block) reads the marker first, on its own; only if it is off does it read the strict switch (in its own caught block). An unreadable strict switch can never cancel the atomic raise.
- **The marker is cooperative, not proof of origin.** Any SQL writer that sets it gets the raise (trusted-writer assumption; EXECUTE revoked from PUBLIC, anon and authenticated).
- **`quote_acceptance_attempts`**: one row per document and per request (both unique). `handler_finished_at` means **the handler reached its customer response, not that follow-up work succeeded**: those steps keep today's best-effort handling until slice 2 records them.
- **`quote_acceptance_handler_finished(document, request_id)`**: only the committing request, once.
- **`quote_acceptance_gaps(grace)`** (R3), read-only, ids, codes and instants only. A row disappears only when its own `(kind, ref)` is in `quote_acceptance_gap_resolutions` (service role may insert and read, never change or delete), or for runs and attempts their `resolved_at` is set. Nothing else suppresses it.
  - `settle_run_unsettled`
  - `review_needed`: every `quote_option_review_needed` and `quote_acceptance_review_needed` event, so review-only failures and staff-advanced acceptances are listed
  - `won_with_open_sibling`: one row per (winner, open sibling); its ref names both jobs and both rows' current versions (`xmin`, which changes with every update of a row), so resolving one sibling never hides another, and any re-win, reopening (for example cancelled then quoted, which runs no trigger and writes no event) or other change to either job is listed again. An unrelated edit to either job also re-lists it: the safe direction. `more_than_one_won` refs carry the members' row versions the same way. Listed only while the supersede switch reads true (open siblings are by design when marking is off); an unreadable switch, for the same errors the trigger catches (including 57014 and P0004), is off and the rest is still listed
  - `more_than_one_won`
  - `acceptance_handler_unfinished`

## 5. send-quote (`index.ts`, `quote_accept_atomic.ts`)
- Switch off, missing or unreadable: today's code path. Every legacy write is unchanged, behind `atomicDocId === null`, and today's three pre-reads run as before. The only addition is one uncached switch read per acceptance with a job.
- Switch on:
  1. read the snapshot; the token-read document must equal its snapshot row in every guard and party-rule field, including the current token (retry page otherwise);
  2. today's guards still run, then run again on the snapshot with the same query filters; the party rules run on the snapshot. The run neighbour comes from the snapshot statement itself, chosen the legacy way (`LIMIT 1`, no order), so it belongs to the same snapshot as the fingerprint; the database also checks, under the lock, that it is still one of the run's line item contacts (or that the run has none when it is NULL);
  3. for a whole quote, read the job and contacts and build today's `quote_accepted` detail;
  4. call the function with a fresh request id.
- Outcomes:
  - `replay`: today's "Already accepted";
  - `refused`: today's page for that reason;
  - `stale`, or a database error (a SQLSTATE): a confirmed rollback, the retry page;
  - a lost or unreadable response: the attempt row is read back by **request id** (one re-read after a short wait). This request's row is its commit; another request's row is a replay; nothing found or an unreadable read is `unknown`, which shows the retry page. If it did commit, its attempt is listed as `acceptance_handler_unfinished` and a retry gets "Already accepted".
- After commit the legacy writes are skipped and the follow-up work runs as today, in the committing request only. `finishAtomicAcceptance` runs before each of the three acceptance responses.

## 6. Proof (none run locally: the Mac's heavy-work hold)
Migration contract `supabase/tests/migration-contracts/20261019230000_quote_accept_atomic/`:
- switches seeded off; privileges (five functions, the attempt and resolution tables); definer and search_path
- **R4**: the triple failure through the function rolls back fully (no accepted document, status, marks, events or attempt), the marker does not outlive the call, the gap read lists nothing; the same with the strict switch unreadable (57014, P0001); positive control
- **parity**: the same failure from a plain status UPDATE (what all 40 writers send) stands with the strict switch false, NULL, missing, or unreadable (57014, 42501, 55P03, 42P01, P0001, P0004); with it on it is refused; the marker however set raises
- **combinations**: supersede (false, missing, unreadable, true) x path (plain, RPC) x triple failure (off, on), 16 cases, each rolled back, with table-specific fault injectors
- snapshot and fingerprint agree; every fingerprint input changes it and undoing restores it (decline, an instant moved between accept and decline, raw and snapshot run label, version, sent flag, token, send claim, supersession, run acceptance and its status, run line item); TimeZone independence
- wrong token, missing whole-quote event, bad status, missing document, unsent document; whole quote; replay returns the committing request; staff-advanced overwrite; run path with and without contact
- handler-finished only by the committing request, once; gap read: unfinished handler, review events listed, a resolution suppresses exactly its own row, trigger bypass, supersede-off gating, two winners, a review-only failure listed with its open sibling
- rollback contract and break contract (the break removes the marker; R4 must fail)

send-quote unit test `quote_accept_atomic_test.ts`: the switch read; snapshot read failures; the document-to-snapshot match (the token, instants in another format, and a mutation of each of seven fields); the guards on the snapshot; the snapshot's run neighbour and its arguments; outcome mapping and arguments; a SQLSTATE error is never recovered; lost-response recovery by request id (same instant, other request is a replay; nothing found is unknown after one re-read); finishing.

Each mutation in the contract runs in its own statement (or its own PL/pgSQL assignment) and is verified in the next, since a statement's own subqueries cannot see writes made by a function it calls. Row-version cases run their change in a subtransaction, because inside one transaction every write shares one `xmin`.

**Coverage limits:** the fingerprint and document-match cases mutate the main fields one at a time, not every field. Timestamps are compared to the millisecond, as the party rules already order them.

**Not proven here:** two-session concurrency (single-session runner); a full send-quote handler run (no handler harness in index.ts; the legacy writes are untouched and guarded); all three switches integrated (the Ops reader switch is not on this branch). These go to the independent check and the reader's own review. Universal R5 is **not met by design** while every other writer keeps warning-only behaviour; it needs the owning review's decision on the strict switch.

## 7. Slice 2 (designed, not built): a per-step ledger for the follow-up work
This replaces the single at-most-once window with resumable steps. It fixes the three bb7b6b7 findings.

- **Table `quote_acceptance_steps`**: rows are seeded at commit. States are `pending`, `running`, `done`, `failed_retry_safe`, `failed` and `unknown`. Each row holds its frozen payload, `claim_token`, `lease_until`, `dispatch_started_at` and `result`.
- **Clock and transaction boundary:** every lease comparison uses `clock_timestamp()`, and each worker write is its own short transaction, so a stale transaction cannot carry an old `now()` past a sweep.
- **Worker transitions:**
  - The claim is the only write without a token condition: `pending`/`failed_retry_safe`, or `running` with an expired lease and no dispatch, moves to `running` with a fresh token. Exactly one claimer wins.
  - Every later worker write is fenced by `state = 'running' AND claim_token = :mine AND lease_until > clock_timestamp()`.
  - The external call is made only after `dispatch_started_at` is written under that fence.
- **Expiry sweep (its own transition, not a worker write):** `UPDATE ... SET state='unknown', claim_token=NULL, swept_at=clock_timestamp() WHERE state='running' AND lease_until <= clock_timestamp() AND dispatch_started_at IS NOT NULL`. It clears the token, and worker writes also require `state='running'`, so after a sweep no worker write can match, whatever that worker's transaction thinks the time is. A running step with an expired lease and no dispatch is not swept; it is re-claimable.
- **Human reconciliation (its own transition):** a service-role function moves `unknown` to `done` or `failed`. It requires `WHERE state='unknown'` (so it never races a worker, whose writes need `state='running'`), clears any token, and records a named person (`reconciled_by`), `reconciled_at` and a note. It never touches `running` rows, and it is never automatic.
- **Dependencies bind results:** `neighbour_note:<contact>` depends on `neighbour_contact:<contact>` (it reads `contactId` from that step's stored `{contactId, opportunityId}`) **and** on `neighbour_contact_link:<contact>` (ordering only). It starts only when both are `done`, and its payload's contact id comes from the creation step's result, never from a placeholder.
- **Business success, not HTTP:** a step is `done` only on a 2xx response whose body has the step's success field. Send and money steps (`client_update`, `deposit_invoice`, `council_email`, `ghl_stage`, `neighbour_contact`) are at-most-once; any doubt after dispatch is `unknown`, never auto-retried, and reconciled with the Sent Items rule used in the containment work.

## 8. Owners and open questions
- send-quote code owner: **not recorded** (register, `ORG.md` and `architecture/edge-functions.md` name none). Business owners of the quote stage are Khairo (fencing) and Nithin (patio) (`ORG.md` lines 13 and 14). Builder: this Sales thread. Reviewers: Codex (second model) and the independent check.
- For the owning review:
  1. the strict switch (raise for every writer), given the staff-block risk;
  2. the switch-on order above;
  3. whether a failed atomic acceptance should keep showing the retry page, or a "received, we will confirm" page (a new customer-facing page; Sales and Marnin);
  4. slice 2 before any switch-on.
