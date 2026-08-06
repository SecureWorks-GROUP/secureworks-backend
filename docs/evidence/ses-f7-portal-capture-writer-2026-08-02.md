# F7 — the portal observer can now remember what it saw

2026-08-02. Branch `fm/ses-portal-capture-writer-v1`.

## What was wrong

The F7 observer could read a Prime share link and classify it correctly, and it
could not persist a single thing. Its argument parser exposed no write mode, its
own report said it planned but never called `record_ses_portal_capture_evidence`,
and a direct production count found **0 rows in
`makesafe_portal_capture_revisions` across the whole database**.

The reader was already built. `portalCapturesFromLedger`
(`supabase/functions/ops-api/makesafe_board_read_model.ts`) gates ledger evidence
on exact job, exact cycle, exact URL, typed role, builder reference, producer,
hashes and screenshot. So did the recorder
(`ses_portal_capture_evidence.ts`), the RPC and the CHECK constraint in
`20260728500000_makesafe_portal_capture_bridge_u4.sql`.

Everything except the last twenty metres of pipe existed. Nothing wrote.

That matters now because the captain's 2026-08-02 Docs Ready ruling names two
acceptable proofs for a roof report — a trade confirming the link, **or** the
deterministic portal reader observing the Prime form is filled out
(`data/decisions/2026-08-02-docs-ready-repair-restoration.md`). Without
persistence the second channel did not exist, so roof cards could not reach Docs
Ready on evidence. The live dry run found 9 portal reports genuinely submitted
and locked that we could not record.

## What was built

`scripts/ses-f7-prime-portal-observer.ts` gains a write path. Nothing else about
how it looks at a page changed.

| Property | How it is enforced |
|---|---|
| Off by default | `--commit` is a switch; every other invocation is `dry_run`. `--commit=false` is a usage error, not "off". |
| Cannot sweep | `--commit` **requires** `--job=<reference>`, so the writer can only be aimed at one named card. Capped further by `--max-writes` (default 1). |
| Writes only what was observed | `buildCaptureWriteRequest` refuses before any network call if job, cycle, typed role, HTTPS URL, source hash, builder reference, idempotency key, signal or screenshot is missing. The reason is recorded; no row is written. |
| Never writes a stage | `assertCaptureWriteAction` allows exactly one ops-api action, `record_ses_portal_capture_evidence`, at the single egress point. Every stage/substatus/status/placement writer is structurally unreachable. |
| Append-only | The observer only ever calls the recorder, which only ever calls `commit_makesafe_portal_capture_v1`. There is no update and no delete on this path. A later observation is a new `makesafe_fact_version`. |
| Cannot observe ≠ not done | An expired, unreachable, failed or unclassifiable page is `unreachable` → status `rejected`, carries no screenshot, and is refused outright if a caller attaches one. It is never `not_done`. |
| Idempotent | Two layers. The planner skips an unchanged observation before the network; the database unique index on `(job_id, attendance_cycle_id, role, capture_idempotency_key)` refuses a duplicate, and the observer reads that refusal as `idempotent_noop`, not an error. |
| Producer recorded | Every revision carries `capture_producer` (the approved contract) and `captured_by` (the concrete agent, `ses-prime-portal-observer/2026-08-02.4`). |

Counts in the manifest and report gained a `write_outcome` breakdown per named
population, and links left unwritten by the cap are reported as
`write_skipped_write_cap` rather than dropped silently.

## The reader was not loosened

The one reader change is behaviour-identical. `capture_producer !== SES_PORTAL_CAPTURE_PRODUCER`
became `!isTrustedSesPortalCaptureProducer(...)`, where
`SES_TRUSTED_PORTAL_CAPTURE_PRODUCERS` holds **exactly one member** — the same
value. It is a seam, not a widening, and `ses_portal_capture_writer_test.ts`
pins the membership so an accidental addition fails the suite. The same
substitution was made in `ses_assembler_input_adapter.ts` so there is one
predicate rather than three literals.

## Proof

`deno test supabase/functions/ops-api/ses_portal_capture_writer_test.ts` —
10 passed. It is end to end and offline: the observer's own request builder
feeds the **real** `recordSesPortalCaptureEvidence`, which commits through a
ledger double enforcing the migration's own CHECK constraint, unique index and
version sequence, and the persisted row is handed to the **real**
`portalCapturesFromLedger` and `buildCanonicalMakesafeRows`.

| Required behaviour | Test |
|---|---|
| A valid observation produces exactly one revision the existing read model accepts | `a valid observation produces exactly one revision the board read model accepts` — one row, `makesafe_fact_version` 1, reader returns it as `done`/`locked` with its screenshot key |
| A missing element produces no revision, with a reason | `a missing required element writes nothing and records why` — eight distinct elements, each refused with its own reason before any network; plus a server-side stale-cycle refusal |
| A partial capture cannot slip past the reader | `a partial capture the reader would trust is refused at the reader too` — six single-element mutations each drop the row |
| Re-running over unchanged state produces no duplicate | `re-running over unchanged state creates no duplicate` — one row after two identical records, one screenshot upload, planner no-op and database conflict both proved |
| A later observation appends rather than edits | `an appended later observation is a new revision, never an edit` — versions 1 and 2, earlier row untouched |
| Expired link is cannot-observe, not negative | `an expired link records cannot-observe, never not-done` — `unreachable`/`rejected`, no screenshot invented, reader reports `locked:false` |
| No card moves | see below |
| Producer trust is not decided here | `producer trust is a single-member seam the captain owns` |

### No card moves

> **Superseded in part by Release 12 (2026-08-06).** The WRITE guarantee below
> still holds and is still enforced: recording a capture commits evidence and
> issues no stage or substatus write, so no raw board state changes. The READ
> half no longer holds — the evidence engine now places the board, so an
> accepted current-cycle capture moves the derived column as far as it proves
> (and no further); a refused capture still moves nothing. Current invariant:
> AGENTS.md "The Corrected Stage Engine Is The Placement Authority (Release
> 12)"; regressions: `ses_portal_capture_writer_test.ts`. The measurements
> below are the 2026-08-02 record and are not restated.

Three independent proofs, because the cheap one alone is not enough.

1. **Structural.** `_deriveMakesafeBoardStage` — the legacy ladder that places
   every card — takes `(job, detail, assignments, report, invoice, nowIso, docs,
   packSent, pack)`. There is no capture parameter, so a ledger row is not an
   input it could read. `canonical_stage` in `buildCanonicalMakesafeRows` is
   `base.board_stage` plus the status-application overlay; captures enter only
   `statusInput`, which feeds M1's advisory `computed_status`. Asserted in
   `no board stage can move because a capture exists`.
2. **Behavioural.** The same test injects an accepted revision on a card in
   every one of the `OPS_MAKESAFE_STAGES` × five substatuses and asserts
   `canonical_stage`, `declared_stage`, `substatus` and `job_state` are
   unchanged in all of them.
3. **Production, 407 cards.** `scripts/ses-stage-parity-harness.ts` was run
   read-only before and after the change:

   - before `2026-08-02T09:20:37Z`, after `2026-08-02T09:33:03Z`
   - population `ses-board-population/active-v1`, 407 cards both runs
   - **moved 0 of 407**, missing 0, added 0
   - columns identical both runs: archive 303, new 35, allocated 30,
     report_ready 24, trade_report_in 13, completed 2

   Denominator caveat, per the population contract: `active-v1` is a default,
   not a ruling, and excludes the 33 cancelled cards pending captain decision
   C.5. This is not a whole-board claim.

## Production access, stated exactly

**Zero production writes were performed.** Every database read used the Supabase
Management API with `read_only: true`. `SW_API_KEY` was not present in this
environment, so the ops-api write path could not be called even by accident —
and per the task's own instruction, a proof that does not need a production
write is the better proof. The write path is exercised end to end against the
real recorder and the real reader in the test suite above.

No backfill, no sweep, no bulk capture. No existing production capture was
turned on. The money seal was neither bypassed nor touched.

## OPEN — for the captain, not for us

### Producer authority is unsealed

**Who is allowed to assert that a portal report was completed?** This observer,
the trade app, a named service account? It has not been ruled on, and this
branch deliberately does not decide it.

The state of play the captain should know before ruling:

- The ledger has **one** producer slot, and the value pinned in the database
  CHECK constraint is the string `capture_portal_evidence.py/v1`. That names a
  Python producer from the original U4 design. **The implementation that
  actually observes Prime pages is TypeScript**, `ses-prime-portal-observer`.
- So today the observer writes `capture_producer = 'capture_portal_evidence.py/v1'`
  (the approved producer *contract*, which is what the column and the reader
  gate on) and records its own concrete identity in `captured_by`
  (`ses-prime-portal-observer/2026-08-02.4`). Attribution is complete on every
  row; what is unresolved is whether the contract name should be corrected to
  match the implementation, and whether a second producer should ever be
  trusted.
- Widening trust is deliberately **not** a code edit. It needs a migration (the
  CHECK constraint) *and* a membership change in
  `SES_TRUSTED_PORTAL_CAPTURE_PRODUCERS`. The seam is in one place so a ruling is
  cheap to apply; the two locks mean nobody can apply one by accident.

Three questions the captain may want to answer together:

1. Should the producer contract be renamed to name the real implementation, or
   should the observer keep asserting the legacy contract string?
2. May the trade app write to this ledger as a second producer, or does the
   trade channel stay entirely separate (a button, not a capture)?
3. Does a capture from a trusted producer count as Docs Ready evidence on its
   own, or only alongside the trade confirmation?

### Backfill is a separate, captain-gated operation

The live dry run found 9 submitted-and-locked portal reports we can now record
and have not recorded. Recording them is a backfill across the board, which this
task explicitly excludes. It needs its own adjudicated card list and its own
ruling.

## Also in this branch

`supabase/functions/ops-api/ses_stage_engine_v2_test.ts` had a type error that
made `deno task test:ops-api` fail to compile at all on `main`, so no suite in
this repo could be run green. The test deliberately passes `42` as an off-type
advisory stage to prove the gate blocks it; the fix is a cast that keeps the
hostile case and does not widen `SesStageGateRow`. Unrelated to portal capture,
and called out here rather than buried.

With that fixed, the suite is **2767 passed / 18 failed**. The same 18 fail on
`main` with only that compile fix applied (2758 passed / 18 failed before this
branch's 9 new tests) — they are pre-existing and none touch portal capture. The
list is `send_pack`/`resume`/`recheck queue`/`trade invoice` and similar.
