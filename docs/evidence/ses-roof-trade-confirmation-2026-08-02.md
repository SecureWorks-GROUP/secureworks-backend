# Trade roof-report confirmation — backend, 2026-08-02

Captain ruling being implemented: `data/decisions/2026-08-02-portal-producer-and-voice-notes.md`
section 1, read with the Docs Ready ruling
(`2026-08-02-docs-ready-repair-restoration.md` section 1) and the portal-capture
delegation (`2026-08-02-card-identity-and-portal-capture.md` section 2).

> "for a roof report job with a prime link it should already know that and it
> should just ask a question like is this roof report done and then when you
> tick that then it goes over."

## Scope of THIS delivery

**Backend only.** The trade app is the `securedash` repo (this repo carries
`dashboard/` as a submodule pointer with no working tree), so the button itself
is a separate, separately-counted change. What ships here is everything the
server owns:

- the action a trade calls, `confirm_roof_report_done`;
- the evidence it records;
- the published per-card flag that tells the trade app whether to render the
  control, and for which viewer.

**Follow-up, not shipped here:** the trade-app control in `securedash` that
renders `roof_report_confirmation.question` when `can_confirm` is true and POSTs
`confirm_roof_report_done`. It needs no new field: everything it must know is on
the card it already renders.

## The contract

| | |
|---|---|
| Action | `confirm_roof_report_done` (POST) |
| Auth | Trade JWT (`authTrade`), plus a non-cancelled `job_assignments` row for that user on that exact job |
| Request | `{ "job_id": "<uuid>" }` — nothing else is read |
| Writes | one row on `makesafe_portal_capture_revisions` via `commit_makesafe_portal_capture_v1`, plus a `job_events` audit row |
| Producer | `trade_portal_confirmation/v1` |
| Never writes | `canonical_stage`, `makesafe_job_details.substatus`, `jobs.status`, any invoice, any send |

Code: `supabase/functions/ops-api/ses_trade_portal_confirmation.ts` (pure
predicates), `ses_trade_portal_confirmation_action.ts` (the write),
`ses_portal_capture_contract.ts` (the second producer), and
`supabase/migrations/20260802030000_makesafe_trade_portal_confirmation.sql`.

### One question, and the card answers everything else

The ruling's second half is the one that is easy to get wrong: the trade must
not be asked to classify anything. So the request body carries a job id, and
role, portal URL, builder reference, attendance cycle and timestamp are all
derived server-side from the card. A body that supplies `role`, `source_url`,
`attendance_cycle_id`, `captured_by`, `builder_reference` or `capture_result` is
ignored in full — pinned by
`the request body cannot supply role, url, cycle or confirming identity`.

The question itself is a constant, `SES_TRADE_PORTAL_CONFIRMATION_QUESTION`.

### Two producers, one fact

The deterministic reader and the trade tick write the same kind of row to the
same append-only ledger. They differ in exactly one way, and the migration
enforces it:

- `capture_portal_evidence.py/v1` renders the Prime page, so it MUST carry the
  stored screenshot that proves what it saw.
- `trade_portal_confirmation/v1` renders nothing. Its proof is the named
  authenticated confirmer in `captured_by`, so it carries NO screenshot, and it
  is confined to `role = 'roof_report'` and `capture_result = 'done'`.

`source_content_hash` is producer-specific in meaning and identical in shape: the
reader fingerprints rendered content, the attestation fingerprints the
attestation (job, cycle, role, link, reference, confirming user, timestamp,
question, answer). Both column comments now say so.

Downstream, the split is deliberate:

- the **board read model** and **M1 report-in** accept either producer — a
  screenshot-less capture counts only when it carries `attested_producer`, which
  `portalCapturesFromLedger` sets from a validated ledger row and nothing else.
  Card-derived capture entries are stripped of the key, so a legacy
  `portal_verified_signal` blob cannot forge it.
- the **U4 docket assembler** still selects only the screenshot-bearing reader,
  because the docket needs the picture. It is excluded at the CANDIDATE step,
  not at validation: a newer attestation must not out-rank a good reader capture
  by fact version and turn a valid docket invalid. Pinned by
  `a newer trade attestation never shadows the reader capture U4 needs`.

Whether an attestation can ever stand in for the docket screenshot is a separate
release, not a side effect of this one.

### Idempotence

The idempotency key is `trade-portal-confirmation:v1:<attendance_cycle_id>` —
deliberately excluding the confirming user, so a second trade collides with the
first instead of appending a rival record. Three layers:

1. If completion evidence already exists for the cycle (this trade, another
   trade, or the reader), the action returns `already_confirmed: true` and never
   calls the RPC.
2. The RPC's advisory lock plus existing-row check serialises a genuine race;
   the loser's 23505 is caught, the ledger re-read, and the winner's row
   returned.
3. `uq_makesafe_trade_portal_confirmation` is the database guard: one
   attestation per `(job_id, attendance_cycle_id, role)`, independent of how the
   key is derived.

### Authorisation

"Any trade that's on the job" is enforced as a non-cancelled `job_assignments`
row for the authenticated user on that exact job. Being an admin is explicitly
not a qualification — the ruling names the trade who did the work — and the
action is absent from `ROUTINE_ALLOWED_ACTIONS`, so the automation routine
cannot reach it. Authorisation runs BEFORE any card fact is resolved, so a
refusal leaks nothing about the card.

## PR 229 anti-regression

The control's visibility is decided by **evidence, never by substatus**. A roof
card sitting at `ready_to_invoice`, `admin_to_send_report` or `complete` with
nothing behind it still offers the tick — that is the population this channel
exists to unblock, and hiding the control there is precisely the inverse bug PR
229 fixed. Pinned by
`substatus is not proof: an unverified ready_to_invoice roof card still offers the tick`.

The control disappears only where a done roof capture exists for the CURRENT
cycle. A prior-cycle capture does not carry over.

## Measured against production (read-only)

`scripts/ses-roof-trade-confirmation-measure.ts`, Management API,
`read_only: true`, SELECT-only, no client-identifying column selected. It imports
the shipped predicate rather than restating it. Committed artifact:
`scripts/ses-roof-trade-confirmation-measure-v1.json` (2026-08-02, 3 queries,
board population `ses-board-population/active-v1`, 407 cards).

| | |
|---|---|
| Roof cards on the active board | 60 |
| Already carrying current-cycle completion evidence | 9 |
| **Control offered** | **27** |
| Not offered: card not live (archived) | 9 |
| Not offered: no attendance cycle | 6 |
| Not offered: no portal roof link | 6 |
| Not offered: two rival roof links | 3 |

### The named cohort

Live roof cards that look done by substatus with no verification behind them:
**19** — the same 19 in the brief. **The control now appears on 13 of them.**

The other **6** are all at `ready_to_invoice` with `attendance_cycle_id IS NULL`
(SWMS-261079, -261081, -261113, -261114, -261116, -261123, re-verified directly).
Every capture on this ledger binds to an attendance cycle, so there is nothing to
bind a confirmation to. The control is correctly absent rather than writing an
unbound row, and opening a cycle for them would be a state write and a backfill —
both out of bounds here. Closing that six is a separate, adjudicated change.

Of the 9 cards at `ready_to_invoice` with zero verification named in the brief,
the control appears on 3; the other 6 are exactly the no-attendance-cycle set
above.

## No card moves

`scripts/ses-stage-parity-harness.ts` run against live production on the base
commit and on this branch, same `--now`, both 407 cards:

```
moved: 0   m1_changed: 0   v2_changed: 0   missing: 0
```

`canonical_stage` is unchanged for every active card, and so are M1's pure status
and the shadow v2 post-overlay stage. That is what "records evidence, not a
stage" means in practice: the board column is the legacy ladder plus the overlay
resolver, and neither reads portal evidence.

A unit test proves the same thing at the row level — projecting a card with and
without an attestation leaves `canonical_stage`, `declared_stage`, `substatus`
and `job_state` identical.

## Known gap, deliberately not closed here

`externalPortalRoles` in `makesafe_computed_status.ts` types a card's links by
their declared `kind`, and `builder_portal` is not a roof role there. On a card
whose link is generically typed — the common production shape — M1's roof
report-in predicate is unsatisfiable whatever evidence exists. That is
PRE-EXISTING and identical for the deterministic reader's screenshot capture; it
is not introduced here, and widening the link typing would move M1 output on live
cards, which is a separate counted change. Pinned, so it stays visible, by
`KNOWN GAP: a generically-typed builder_portal link records evidence but does not satisfy M1 report-in`.

The tick still records evidence, and the control still appears and disappears
correctly, which is what this delivery is scoped to.

## Deploy order

Apply `20260802030000_makesafe_trade_portal_confirmation.sql` BEFORE the matching
`ops-api`. The runtime writes rows the old CHECK constraint would reject.
Requirements are declared in `scripts/edge-function-schema-requirements.txt`
(`uq_makesafe_trade_portal_confirmation` and the widened
`makesafe_portal_capture_bridge_shape`), so the schema gate refuses the deploy
until the migration is in the live ledger. Rollback twin:
`supabase/rollbacks/20260802030000_makesafe_trade_portal_confirmation_down.sql`
— it fails loudly if any attestation has already been written rather than
stranding recorded evidence.

The money seal is untouched: a completion tick is not an invoice action and this
path reads or writes nothing in the SES money mirror.
