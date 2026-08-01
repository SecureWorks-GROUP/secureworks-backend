# SWMS-26692 MakeSafe family backfill (2026-08-01)

## What was wrong

The round-2 board correction names this card's fix exactly, in
`scripts/board-fixes-round2-field.fixture.txt`:

```
SWMS-26692 | jobs.metadata.makesafe_job_family | NULL | temp_fence_makesafe |
  declared Make Safe plus temporary-fence scope; board kind unchanged
```

The round-2 run skipped it (`scripts/board-fixes-round2-v1.apply-ledger.json`,
`field_fixes.skipped[0]`) with:

```json
{ "card": "SWMS-26692", "eligible": false, "reason": "handled_by_temp_fence_class" }
```

That reason is a claim that another pass picks the card up. It does not:
SWMS-26692 is **absent** from `board-fixes-round2-temp-fence.fixture.txt`, so
nothing applied it and the family stayed `NULL`. The certification diff found it
still `NULL`.

This is bookkeeping, not adjudication. The only captain hold in that class is
**SWMS-26894**, a different card, which is `general_makesafe` and stays exactly
as it is.

## Root cause, and the fix that stops it recurring

`evaluateField` in `scripts/apply-board-fixes-round2-v1.ts` excluded *every*
`temp_fence_makesafe` target from the safe-field pass, labelling each one
`handled_by_temp_fence_class` without ever checking whether the temp-fence class
actually contained it. A fixture row could therefore be silently dropped while
the ledger reported it as handled elsewhere.

The safe-field pass now passes the set of cards the temp-fence class covers. A
deferred target that is **not** in that set gets the honest reason
`temp_fence_target_not_in_class`, so the next certification diff surfaces the gap
instead of reading a skip as work done somewhere else. The captain hold still
outranks it, and a genuinely covered card keeps the original deferral. Pinned by
`scripts/test/apply-board-fixes-round2-v1_test.ts`.

Note this changes reporting only. It does not make the safe-field pass start
writing temp-fence values, and the round-2 apply ledger is history and is not
rewritten.

## The backfill

`scripts/apply-swms-26692-family-backfill-v1.ts`, dry-run / apply / verify,
reusing the round-2 `evaluateField` and `buildFieldUpdateSql` rather than
reimplementing their guards. It writes exactly one JSON field on one card:

- the job must match by id **and** job_number;
- the current value must still be exactly the expected `NULL`
  (`IS NOT DISTINCT FROM NULL` compare-and-set, `FOR UPDATE`);
- the board kind must be identical before and after — `evaluateField` refuses
  with `board_kind_would_change` otherwise;
- the fixture row is re-read from the round-2 file and the script refuses if it
  is not still the adjudicated `NULL -> temp_fence_makesafe` transition, so a
  fixture edit cannot silently retarget it;
- SWMS-26894 is read on every mode and recorded, never written.

Result: `board_kind_before` and `board_kind_after` both `physical_makesafe`,
one row updated, verify reads back `temp_fence_makesafe`. Confirmed read-only
afterwards: `status` still `archived`, `substatus` still `complete`, assignments
0, board-status ledger rows 0, `job_events` unchanged at 2 with none since, and
SWMS-26894 still `general_makesafe`.

Evidence: `scripts/swms-26692-family-backfill-v1.{dry-run,apply-ledger,verify}.json`.

## Deliberately not done

`makesafe_job_family_label` is still `NULL` on this card, where SWMS-26894 has
`MakeSafe`. The round-2 fixture names only `makesafe_job_family`, so that is the
whole adjudicated correction and the label is out of scope here. Whether the
label should be backfilled across cards is a separate question, not a silent
add-on to a one-field fix.
