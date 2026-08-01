# board-duplicate-survivors-v1

Adjudication and planned dry run for the captain's duplicate-survivor ruling
(2026-08-01). Full reasoning, per-group evidence and the five skips are in
`docs/evidence/makesafe-duplicate-survivors-2026-08-01.md`.

## `dry-run-plan.json`

The historical fixture covers four re-verified groups. It is superseded for
apply decisions by the three-group ruling in the evidence document below.

```
SWMS-26998   allocated     -> archive   pointer SWMS-26736    (MLB-25625 roof, PO-54007)
SWMS-26791   report_ready  -> archive   pointer SWMS-26787    (MLB-26189, PO-54425)
SWMS-26920   allocated     -> archive   pointer SWMS-26845    (MLB-23067, PO-54811)
SWMS-261118  new           -> archive   pointer SWMS-261065   (MLB-26344, PO-57087)
```

**Scope of this artefact.** Job ids, job states, activity counts, PO sets and
PDF-declared instruction types are all read from production. The `before_status`
values are *derived* — `board_stage` is computed at request time inside `ops-api`
and is not a stored column, so it was reproduced from `_deriveMakesafeBoardStage`
against each card's live status, substatus, assignment, invoice and document
facts rather than read back from a live endpoint.

No production write has been made and no live `ops-api` dry run has been run:
the migration is not applied yet, and `ops-api` may only be deployed from the
authorized release worktree. The authoritative dry run is step 3 of the release
sequence in the evidence doc, and its response — not this file — is what gates
the live apply. If that dry run reports a different `before_status`, the planner
is reading live truth and this file is the stale one.

## This file is superseded — read it as fixture data, not as the plan

Two things landed after it was written, both in
`docs/evidence/makesafe-duplicate-survivors-2026-08-01.md`:

- **It is known-stale.** It derived `before_status` from raw card facts and never
  read `makesafe_board_status_applications`. Five of the eight cards already
  carry a display overlay from the 2026-07-24 cutover and the 2026-07-28 U7 runs.
- **MLB-23067 is excluded by captain ruling.** Both its cards already display
  `archive`, so the ruled outcome already holds and the planner's guard is
  correctly refusing. The row for `SWMS-26920` above is therefore **not** part of
  the apply set.

The apply set is the three groups `mlb-25625-roof`, `mlb-26189-assessment` and
`mlb-26344-makesafe`, gated on three archives and zero skips. The live dry-run
and apply responses are recorded separately under `scripts/` in the apply-ledger
PR, following the `board-safe-fixes-v1` pattern.
