# SQ-23 remedy: an acceptance can never commit its status with no record

**Revision 15: the one current contract** (after the Codex reviews of `2a09949`, `1d41398`, `ad95394`, `3f80a7a`, `9230af9` and `fb11da4`, CIO's static review of `7999537` at `ctx/cio-20261019` `9738b65`, Codex at `25df33f`, saved beside this file; the independent checks at `2a09949` and `60df50f`; and CIO's consumer review of `1d41398` at secureworks-projects `ctx/cio-20261019` `debaa44`). Earlier text (the original and revisions 2 to 6; later revisions are replaced in place) is in `acceptance-atomic-design-history.md`, marked superseded, and is not operative.

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
- its acceptance event: `quote_accepted` (whole quote) or `quote_run_accepted` (run), with `detail_json.accepted_at` set to the acceptance instant by the database (CIO condition 1); the after-commit business event `quote.run_accepted` also carries the acceptance instant on this path;
- its attempt row.

The supersede trigger runs inside that transaction. If its run record, work and review event all fail, it raises `quote_option_unrecorded` and everything rolls back. The customer gets the existing retry page (503) with nothing committed.

Outside the guarantee, behaving exactly as today: jobless documents; every other status writer (unless the strict switch below is on); every acceptance while the switch is off. Those are not refused, but the gap read now lists what they can leave behind (a won job with no acceptance event, an accepted document on a job not won, a winner still marked superseded).

**R5 is open.** CIO's requirement is that no other writer can commit a status without its event. As built, that is refused only on the atomic path. The strict switch, if the owner turns it on, refuses other writers only at the trigger's final site: a grouped option's transition into a won status whose run record, work and review event all fail. It does **not** refuse an ungrouped job, or any status write that is merely missing its acceptance event. Everything else is made visible by the gap read, not prevented. CIO does not accept this staged scope (reviews at `1d41398` and `7999537`). It is an open requirement for the owner, not settled by design; the residual risk is stated in §2a.

## 2a. R5 residual risk (owner decision for Marnin, separate from the engineering work)
**What can still happen.** Any writer other than the atomic acceptance can move a job into a won status with no acceptance event of its own: staff screens and ops-api `update_job_status` (a phone or email acceptance recorded by staff, or a mistaken click), crons, the legacy send-quote path while `quote_accept_atomic_v1` is off, and any direct SQL. Nothing refuses it, except the narrow strict case in §3.

**How often.** Not measured, and no number is claimed. Untested hypothesis, to be checked by CIO's one read-only sizing on production-shaped data: staff moving jobs into won statuses is routine, much of it legitimate (an acceptance taken outside the share link), and a status with no acceptance behind it at all is the smaller, harmful part.

**How it surfaces, and its limits.** `quote_acceptance_gaps` lists a won job as `won_without_acceptance_event` when no acceptance event carries the job's own `accepted_at`. It is condition-based, never hidden by a resolution. It is visible to a reader, not prevented. It does **not** catch everything:
- a re-win that leaves `accepted_at` unchanged, with a matching earlier event, is hidden;
- `p_since` excludes jobs whose non-NULL `accepted_at` is older than the bound;
- a legacy acceptance whose separate clock reads happen to coincide looks recorded.
On grouped jobs, sibling kinds add evidence only in their own conditions: `won_with_open_sibling` needs the supersede switch to read true and an open, unmarked sibling; `more_than_one_won` needs two winners. Expect noise from legacy and staff wins, so `p_since` and a scope choice are needed before anyone reads it daily. Context has no read access yet.

**Accept or fix.**
- *Accept the staged scope:* removes R5 as a blocker for the atomic path only. Every other recorded gate still applies (the PG17 proof, the Ops reader joint proof, the strict and history decisions, Context access). Someone must own reading the gap list, and Context must treat a listed job as uncertain chronology. Cost: a reading routine, and the noise.
- *Fix (a), record on every won transition:* a database trigger writes a `status_won_recorded` event (writer, previous status, instant) whenever any writer moves a job into a won status without an acceptance event. Nothing is blocked. The status then always has a record, but the record says "a status change", not "the customer accepted". Cost: a small migration and its review; Context must still distinguish the two.
- *Fix (b), refuse:* refuse any won transition without an acceptance event, and give staff a "record acceptance" action. Cost: changes to the status-writer paths (40 counted in the SQ-23 writer flag-read receipt of 19 Oct, not re-inventoried here; not necessarily 40 code changes), and staff are blocked until they use it.
Choosing among these is Marnin's call. The builder does not pick one.

What a "record" means: the review list is unsettled run rows **plus** `quote_option_review_needed` events. With the supersede switch off, missing or unreadable, the trigger writes nothing by design. Ungrouped jobs never run it. A failed run insert followed by successful work leaves marks and events but no run row.

## 3. Switches (all seeded off)
| Switch | Read by | On means |
|---|---|---|
| `quote_option_supersede_v1` | the SQ-23 trigger | accepting a grouped option marks its siblings |
| `quote_option_ops_reader_v1` | the Ops reader (PR 1091), not this branch | Ops reads the marks |
| `quote_accept_atomic_v1` | send-quote, every acceptance, uncached | the atomic path |
| `quote_option_strict_record_v1` | the trigger's final site only | any writer is refused when a grouped option's won transition could record nothing (not ungrouped jobs, not a status merely missing its event) |

Only a readable `true` turns any of them on. Off, missing or unreadable is off.

**Compatible switch-on order** (for the owning review): `quote_accept_atomic_v1` first, so the split writes end while the trigger is still silent. Then `quote_option_ops_reader_v1`, once the readers are verified. Then `quote_option_supersede_v1`.

**`quote_option_strict_record_v1` is an owning-review decision, not settled.** Once on, a staff status change (ops-api `update_job_status`, staff screens, crons, any of the 40 writers) could be refused whenever the trigger cannot record.

**Strict after atomic is enforced in code** (CIO condition 4, revision 14). The trigger reads both switch rows in one statement, and strict takes effect only if `quote_option_strict_record_v1` **and** `quote_accept_atomic_v1` are both present and true. Strict on with atomic off, missing, NULL, duplicated with a false or NULL value, or unreadable has no effect (contract cases). This fixes the dependency **within the trigger's own read** only. **Residual, not closed:** send-quote reads `quote_accept_atomic_v1` in a separate request. If both switches are stored true and that handler read fails transiently (or the switch is turned on between the two reads), the handler takes the split writes, the document acceptance commits, and the trigger's later read can see both true and refuse the status, leaving `accepted_document_job_not_won` (listed by the gap read). Closing it end to end would need the decision tied to the acceptance itself (for example, send-quote's split path never writing a status that strict could refuse); not built. Switch-off order is the reverse of switch-on.

**An unreadable switch read here is off** (a timeout, cancel, permission or any other error reading either row), exactly like a missing row: the status change is kept with today's warning, plus `strict or atomic switch unreadable (SQLSTATE), strict treated as off`, and the gap read lists the status (`won_without_acceptance_event`; `won_with_open_sibling` while supersede reads true). The atomic path never depends on this read: the marker is checked first, on its own.
- *Chosen: unreadable is off* (an availability choice with an integrity residual, not guaranteed safety; Codex at `25df33f` would also keep it). Reasons: (1) strict's precondition is that the atomic switch reads reliably; an unreadable switch row means it does not, so send-quote **may** itself be on the split writes; (2) on that path the document acceptance has already committed, so refusing its status would **create** the split state (`accepted_document_job_not_won`) rather than prevent one; (3) it keeps the all-switches-off and unreadable behaviour identical to today, which the 81-combination matrix pins; (4) the outcome is logged, and usually listed by the gap read; neither is a durable record of the status change itself.
- *Rejected: unreadable is refuse.* It blocks staff status changes during the very database fault that made the read fail, and on the split-write path it turns a recorded-later status into a committed acceptance with no status.
- *Rejected: cache the last readable value.* There is no safe place to keep it inside a trigger, and a stale "on" would refuse writes after the owner had turned strict off.

**Simultaneous winners stay live (CIO's accepted direction, 12:23Z).** If two options of one group are accepted at the same time in separate sessions, both end up won. The trigger writes a `more_than_one_option_won` review event, clears any marks, and settles its runs. The independent check at `2a09949`, with two real sessions, saw exactly this every time, with nothing unrecorded. The gap read lists the group as `more_than_one_won` until a person resolves it. That matches the direction; nothing here picks a winner.

## 4. Database (`20261019230000_quote_accept_atomic.sql`)
- **Snapshot protocol.** The party rules stay in send-quote and are not ported to SQL.
  - `quote_acceptance_snapshot(job, run_label)` returns the decision inputs (the job's quote documents with the party-rule columns and `share_token`, its run acceptances, its run line items in id order, and the run's neighbour chosen the legacy way) **and** their fingerprint from one statement, so all describe one database snapshot. A change between separate reads (A to B to A) cannot split them.
  - The fingerprint is structured and NULL-preserving (jsonb with explicit nulls, timestamps as epoch numbers, independent of TimeZone and DateStyle). It covers every field the guards and party rules read: documents (ids, contact, raw and snapshot run label, sent flag, token, version, send, claim, accept, decline, supersede and create instants), run acceptances (including status and decline instant), run line items.
  - `accept_quote_document_atomic` locks the job, then its quote documents, run acceptances and run line items, each in id order, and recomputes the fingerprint. Equal means the locked state is the state the decision was made from. Rows another writer inserts after the lock are ordered after this acceptance (stated limit).
- **`accept_quote_document_atomic(document, share_token, request_id, accepted_at, job_status, fingerprint, run_label, run_neighbour, accept_event)`**: SECURITY DEFINER, fixed search_path, service role only. For a run, `run_neighbour` must be a value the legacy selection could return in the locked state: a line item's contact, NULL when a NULL-contact item exists, or NULL when the run has no items. In order:
  1. take the locks above;
  2. **replay**: an attempt row for the document returns its stored result, including the request that committed it, and writes nothing (before any eligibility check);
  3. refuse a token that is not the document's current one; `stale` if the fingerprint differs;
  4. refuse an unsent, accepted, declined or superseded document, or an accepted same-recipient sibling;
  5. check the status vocabulary (whole quote `accepted`/`partially_accepted`; run also `quoted`), and that every acceptance (whole quote and run) carries its acceptance event;
  6. write the document, then the sibling supersession (whole quote) or the run acceptance upsert (run, contact present; with no contact today's upsert fails silently, so none here either);
  7. write the job status exactly as today (overwrite), with the marker `sw.quote_accept_atomic='on'` set around that one statement only (saved and restored; a zero-row update raises);
  8. staff-advanced job (past `draft`, `quoted`, `partially_accepted`, `accepted`): a `quote_acceptance_review_needed` event, today's overwrite kept;
  9. the acceptance event and the attempt row, with `request_id`.
- **Trusted caller.** The database does not re-derive the status or the run label: it trusts the service-role caller's party rules, which are bound to the fingerprinted snapshot. The guarantee is narrowed to that.
- **The trigger's final site** (SQ-23 migration, outside every swallowing block) reads the marker first, on its own; only if it is off does it read both the strict and the atomic switch rows, in one statement in its own caught block, and refuses only if both are present and true (and only at this final site: a grouped won transition whose run record, work and review event all failed). An unreadable switch can never cancel the atomic raise.
- **The marker is cooperative, not proof of origin.** Any SQL writer that sets it gets the raise (trusted-writer assumption; EXECUTE revoked from PUBLIC, anon and authenticated).
- **`quote_acceptance_attempts`**: one row per document and per request (both unique). `handler_finished_at` means **the handler reached its customer response, not that follow-up work succeeded**: those steps keep today's best-effort handling until slice 2 records them.
- **`quote_acceptance_handler_finished(document, request_id, issues)`**: only the committing request, once. `issues` names any follow-up write that failed after the commit (today the post-commit `quote.run_accepted` business event); it is stored on the attempt and listed, so it is never swallowed on the atomic path.
- **`quote_acceptance_gaps(grace, since)`** (R3), read-only, ids, codes and instants only. A row disappears when what it reports stops being true (a run settles, a handler finishes, a condition is corrected), or, for the four resolvable kinds only (`review_needed`, `settle_run_unsettled`, `acceptance_handler_unfinished`, `acceptance_follow_up_issue`), when its own `(kind, ref)` is in `quote_acceptance_gap_resolutions` (service role may insert and read, never change or delete) or the run's or attempt's `resolved_at` is set. Nothing else suppresses it; the six condition kinds (`won_with_open_sibling`, `more_than_one_won`, `won_without_acceptance_event`, `accepted_document_job_not_won`, `won_while_superseded`, `supersede_switch_unreadable`) cannot be resolved. `since` bounds only `won_without_acceptance_event` and `accepted_document_job_not_won`, by acceptance instant; it is not a change cursor.
  - `settle_run_unsettled`
  - `review_needed`: every `quote_option_review_needed` and `quote_acceptance_review_needed` event, so review-only failures and staff-advanced acceptances are listed
  - `won_with_open_sibling`: one row per (winner, open sibling), ref `winner>sibling`. **Condition-based**: listed for as long as the condition holds and **never suppressed by a resolution**, because no row-level value is a durable occurrence id (row versions repeat within a transaction and wrap). A reopened sibling is therefore always listed again. A person clears it by changing the data through the normal paths. `more_than_one_won` is condition-based the same way. `won_with_open_sibling` alone is listed only while the supersede switch reads true (open siblings are by design when marking is off); `more_than_one_won` is listed whatever the switch; an unreadable switch, for the same errors the trigger catches (including 57014 and P0004), is off and the rest is still listed. The resolution table accepts only the four resolvable kinds
  - `more_than_one_won`: two or more won options in a group, marked superseded or not
  - `won_without_acceptance_event`: a won job with no `quote_accepted` or `quote_run_accepted` event carrying **its own** acceptance instant (`detail_json.accepted_at` equal to `jobs.accepted_at`; the atomic path writes both from one value). An older event does not count, so an earlier run event cannot hide a later unrecorded win (Codex `fb11da4` must-fix 1). Lists any writer, every legacy acceptance (held uncertain: the legacy event and status read the clock separately), and every won job with no `accepted_at`. Condition-based. Expect noise from operational and completed work in the shared won vocabulary; `p_since` bounds the history. Known limit: a re-win that leaves `accepted_at` unchanged looks like the original acceptance
  - `accepted_document_job_not_won`: a live accepted quote document on a job neither won nor partially accepted (a split write whose status never landed, including strict on with the atomic path off, or a job moved back or lost afterwards). **Condition-based** (Codex `fb11da4` must-fix 2): a job can become inconsistent again after it was corrected, so a resolution by document id would hide the reopen; it clears only when the data is corrected
  - `acceptance_follow_up_issue`: the committing request reached its response but reported a failed follow-up write; resolvable by document id (one attempt per document)
  - `won_while_superseded`: a won job still marked superseded (only a write that skipped the trigger can leave it); condition-based
  - `supersede_switch_unreadable`: one row when the reader could not read the supersede switch, so an empty answer is never read as clean (CIO reader rule)
  - `acceptance_handler_unfinished`

## 5. send-quote (`index.ts`, `quote_accept_atomic.ts`)
- Switch off, missing or unreadable: today's code path. Every legacy write is unchanged, behind `atomicDocId === null`, and today's three pre-reads run as before. The additions are one uncached switch read per acceptance with a job, a request id generated per acceptance, and finish calls that do nothing on this path.
- Switch on:
  1. read the snapshot; the token-read document must equal its snapshot row in every guard and party-rule field, including the current token (retry page otherwise);
  2. today's guards still run, then run again on the snapshot with the same query filters; the party rules run on the snapshot. The run neighbour comes from the snapshot statement itself, chosen the legacy way (`LIMIT 1`, no order), so it belongs to the same snapshot as the fingerprint; the database also checks, under the lock, that it is still one of the run's line item contacts (NULL is valid when a NULL-contact item exists or the run has no items);
  3. build the acceptance event: for a whole quote, read the job and contacts and build today's `quote_accepted` detail; for a run, the contact and the share-link source (the database adds document, instant, run label and status);
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
- **parity**: the same failure from a plain status UPDATE (what every status writer sends) stands with the strict switch false, NULL, missing, or unreadable (57014, 42501, 55P03, 42P01, P0001, P0004); stands with strict on and atomic off, missing, NULL, duplicated with false or NULL, or unreadable (each fault counted at the gate's read); with both on (including duplicate true rows) it is refused; the marker however set raises
- **combinations**: supersede (false, missing, unreadable, true) x path (plain, RPC) x triple failure (off, on), 16 cases, each rolled back, with table-specific fault injectors
- snapshot and fingerprint agree; these fingerprint inputs each change it and undoing restores it (a tested subset, not every field): decline, an instant moved between accept and decline, raw and snapshot run label, version, sent flag, token, send claim, supersession, run acceptance and its status, run line item; TimeZone independence
- wrong token, missing whole-quote event, bad status, missing document, unsent document; whole quote; replay returns the committing request; staff-advanced overwrite; run path with and without contact
- run neighbour: NULL accepted with a NULL-contact item, on an all-NULL run and on an empty run; refused when every item has a contact; a contact not on the run refused; the run's contact accepted; the snapshot returns the legacy choice
- handler-finished only by the committing request, once; gap read: unfinished handler, review events listed, a resolution suppresses exactly its own row, open-sibling gaps cannot be resolved and come back when a sibling reopens, trigger bypass, supersede-off gating, two winners, a review-only failure listed with its open sibling
- R4 and R3 together: the strict-off plain-UPDATE triple failure is listed by the gap read (CIO condition 3); a won job with no event, an accepted document on a job not won (also after it is lost; not resolvable; listed again after its job is won and reopened), a win whose earlier run event carries another instant (and listed again after a reopen and re-win), a follow-up issue listed and resolvable, a staff-won job with no quote, `p_since` bounds, a superseded option won without the trigger (checker b3x), an unreadable switch reported as a row
- rollback contract and break contract (the break removes the marker; R4 must fail). The rollback contract also kills the checker's seven surviving mutants: the trigger and the other switches must remain unchanged, `jobs.accepted_at` must remain, an acceptance committed before the down (a setup fixture) must survive it, and no relation or function of this migration may remain in `public`, found by escaped name prefix and by the `SQ-23 remedy:` comment every owned object carries (so a renamed one is found); the supersede trigger must stay enabled and bound to its function

send-quote unit test `quote_accept_atomic_test.ts`: the switch read; snapshot read failures; the document-to-snapshot match (the token, instants in another format, and a mutation of each of seven fields); the guards on the snapshot; the snapshot's run neighbour and its arguments; outcome mapping and arguments; a SQLSTATE error is never recovered; lost-response recovery by request id (same instant, other request is a replay; nothing found is unknown after one re-read); finishing.

Each mutation in the contract runs in its own statement (or its own PL/pgSQL assignment) and is verified in the next, since a statement's own subqueries cannot see writes made by a function it calls.

**Coverage limits:** the fingerprint and document-match cases mutate the main fields one at a time, not every field. Timestamps are compared to the millisecond, as the party rules already order them.

send-quote handler test `accept_atomic_handler_test.ts` drives the real exported `sendQuoteHandler` through a partial-fence (run) acceptance with a fake client, a stepping clock (every clock read advances one second) and a deferred RPC:
- atomic path: one RPC carrying its run label, the snapshot's neighbour and its event; none of the split writes and no `job_events` insert outside the transaction; every follow-up call made after the commit; the business event at the acceptance instant while `recorded_at` has moved on; the finish mark for the same request;
- faults injected inside the transaction (the acceptance event write, the status write, the run insert, each as the SQLSTATE error the database returns) and a lost uncommitted response: the retry page (503), no write outside the transaction, no business event, no finish mark;
- a lost response after the commit: recovered by request id, follow-up runs once at the acceptance instant;
- the post-commit business event failing: the acceptance stands and the failure is reported on the finish mark (`acceptance_follow_up_issue`), not swallowed;
- switch off: today's writes and no RPC; today's swallowing of a failed business event is recorded unchanged.
Limit: the fake proves the handler's wiring and failure handling, not database semantics; the in-transaction half is the contract suite's.

**Not proven here:** two-session concurrency in this runner (the independent check ran nine two-session probes at `60df50f`); all three switches integrated (the Ops reader switch is not on this branch). These stay with the independent check and the reader's own review.

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

## 7a. Context's reader rule (CIO condition 7, restated, not implemented here)
For a reader such as Context (`ctx/cio-20261019`): a failed or partial read of `quote_acceptance_gaps` is "unknown", never "no gaps"; a `supersede_switch_unreadable` row makes the whole answer uncertain; a legacy acceptance (no event carrying its own instant) is uncertain chronology, never proof of when or whether the customer accepted; each gap is identified by `(kind, ref)`, and `job_id` may be NULL; condition kinds are re-read, never cached as resolved. The service-role read Context would need is an access change: not granted and not asked for here.

## 8. Owners and open questions
- send-quote code owner: **not recorded** (register, `ORG.md` and `architecture/edge-functions.md` name none). Business owners of the quote stage are Khairo (fencing) and Nithin (patio) (`ORG.md` lines 13 and 14). Builder: this Sales thread. Reviewers: Codex (second model) and the independent check.
- The Ops reader is built (`ebf87bd`, PR 1091, Marnin's correction to CIO's "not built"); only its new joint proof with this branch is outstanding.
- For the owning review:
  1. the strict switch (raise for every writer), given the staff-block risk;
  2. the switch-on order above;
  3. whether a failed atomic acceptance should keep showing the retry page, or a "received, we will confirm" page (a new customer-facing page; Sales and Marnin);
  4. slice 2 before any switch-on;
  5. R5: whether the staged scope is acceptable, or the strict switch (or another refusal) is required before switch-on. CIO does not accept the staged scope;
  6. an unreadable switch read is off for strict (chosen in §3 with reasons; open to the owning review to overrule).
