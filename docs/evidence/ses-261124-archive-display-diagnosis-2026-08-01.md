# SWMS-261124 display stage: the overlay is bound, the board is down (2026-08-01)

Read-only diagnosis of the captain report "BWCWA-6648 was ruled STRAIGHT TO
ARCHIVE but the card renders in DOCS READY". Machine-readable evidence, including
the full before/after ledger JSON, is
`docs/evidence/ses-261124-archive-display-diagnosis-2026-08-01.json`. Board
screenshots are `ses-261124-board-docs-ready-2026-08-01.png` (full board, the
DOCS READY column cut off at the right edge) and
`ses-261124-board-docs-ready-column-2026-08-01.png` (the column in view, with the
"Failed to load jobs" toast visible bottom right).

No write of any kind was performed. Every database read went through the
Management API `/database/query` with `read_only: true`; the two edge reads were
`ops-api?action=makesafe_board` and its privileged `contract_version=v2`
comparison, both GETs.

## Verdict

Neither hypothesis in the brief holds. The display-ledger overlay is **not**
stale and the original row is **not** wrong.

- Ledger row 48 binds `report_ready -> archive` for this job.
- The card's current derived stage is `report_ready`.
- `source_status` therefore still equals the freshly derived stage, so
  `buildCanonicalMakesafeRows` applies the overlay.
- The canonical server board proves it: SWMS-261124 comes back with
  `declared_stage: "report_ready"`, `canonical_stage: "archive"`,
  `computed_status: "archive"`, in the `archive` column.

The card is archived on the read model that
`docs/makesafe-board-read-model-v1.md` makes authoritative. What the captain is
looking at is not that read model.

## What is actually broken

`ops-api?action=makesafe_board` returns **HTTP 500**:

```
intake source issue uniqueness violated for post AAMkADA3OWRlMzg2LTAyNzQt...
```

`ops.html` retries it once, then silently falls back to
`ops-api?action=makesafe_pipeline&type=makesafe`, which returns 200 and is what
the browser actually renders. That legacy board buckets cards with
`columns[enriched.board_stage]` and never reads `makesafe_board_status_current`,
so it is blind to the display ledger by construction. It shows the raw derived
stage — `report_ready` — which the UI labels **Docs Ready**.

Consequence beyond this one card: while `makesafe_board` is down, *every*
captain-applied display transition is invisible on the ops board, including the
2026-08-01 duplicate-survivor archive tranches. The canonical board currently
holds 303 cards in `archive`; the rendered fallback board does not agree with it.

### Root cause of the 500

`loadIntakeOperationalFacts`
(`supabase/functions/ops-api/makesafe_intake_operational_facts.ts`) requires at
most one issue-bearing `email_events_raw` row per `post_id` and throws on the
first violation. The `makesafe_board` ops projection awaits
`_loadIntakeExceptionProjection` in the same `Promise.all` as the canonical rows,
so one bad post takes the whole board down.

The offending post carries two issue rows, written three days apart by two
different subsystems:

| observed_at | change_type | exclusion_reason |
| --- | --- | --- |
| 2026-07-28T00:11:06Z | `intake_exception_lineage_quarantine` | `lineage_quarantine` |
| 2026-07-31T21:20:02Z | `intake_deferred_pdf_extraction_pending` | `pdf_extraction_pending` |

This is systemic, not a one-off: **113 posts** currently carry more than one
issue row, spanning 2026-07-27 to 2026-08-01, overwhelmingly the same
`lineage_quarantine` + `pdf_extraction_pending` pair (a quarantined source that
later also defers on PDF extraction). The uniqueness invariant and the intake's
actual behaviour disagree.

## Why the derived stage is `report_ready`

The backfill linked the historical Xero invoice to the card, exactly as
`docs/ses-adjudicated-job-recovery-2026-08-01.md` specifies:

- `xero_invoices` INV-0754, ACCREC, **AUTHORISED**, `job_id` = this job.
- `job_documents`, `job_assignments`, `job_service_reports` and
  `makesafe_report_packs` are all empty (captain-accepted legacy incomplete
  evidence).

In `_deriveMakesafeBoardStage`, an active AUTHORISED invoice sets `invoiceDone`;
the card is not verified-sent and every close-out doc is missing, so the hard
doc gate holds it in `report_ready`. That is correct behaviour for the derived
stage, and it is precisely the stage the overlay is bound to.

## Why re-applying the archive is not the fix

`apply_makesafe_board_status` only accepts a transition when
`COALESCE(latest.after_status, i.source_status) = i.before_status`. For this job
the latest `after_status` at `source_status = 'report_ready'` is already
`archive`, so a fresh `report_ready -> archive` row is ineligible and the guarded
apply raises `guarded apply rejected one or more transitions`. The ledger is
append-only and correct; a second row would be duplicate authority even if it
were accepted. The before and after ledger states in the JSON are identical by
design, with `changed: false`.

## Ledger provenance note

Row 48 records `source_status`/`before_status` of `report_ready`, while
`archiveHistoricalBackfillDisplay` on `main` (and in deployed ops-api v947, whose
body was fetched and read) sends the literals `'new'`/`'new'` and guards on
`row.canonical_stage !== 'new'`. The build that ran at 06:34:36Z therefore
differed from `main` in that one respect. Its own post-apply read-back verified
`canonical_stage === 'archive'` (it throws otherwise) and the
`makesafe_captain_historical_backfill` job event was written at 06:34:51Z, so the
row bound correctly when written and still binds now. Flagged rather than
guessed at; it does not change the verdict.

## SWMS-261123 (Cottesloe roof report)

Correct. Canonical board: `ses_family: "ordinary_roof_portal"`,
`ses_family_label: "Roof Report"`, `canonical_stage: "report_ready"`. The browser
renders it in DOCS READY as a ROOF REPORT card, "Cottesloe / 12 Princes Street,
Cottesloe", `BUILDER MLB-27309`, `OUR # SWMS-261123`. Right column, right type.

## What would close this out

Restoring `makesafe_board` to 200 is the only thing that moves SWMS-261124 out of
Docs Ready in the browser, and it is a board-wide production decision rather than
a change to this card:

1. **Relax the guard** so multiple distinct issue reasons per post are accounted
   rather than fatal (they are already deduplicated per reason downstream). This
   is a change to intake source-issue accounting semantics.
2. **Decouple the projection** so `_loadIntakeExceptionProjection` degrades to an
   empty intake-exception payload instead of taking the whole board down, keeping
   the guard as an alarm. Restores board truth without deciding the semantics.
3. **Correct the data** for all 113 posts. `email_events_raw` is append-only
   evidence, so this is the destructive option and does not stop recurrence.

## Ruling and what shipped

Captain ruling, 2026-08-01: **option 2 now**, no data edits to
`email_events_raw`. Option 1 is filed as its own task and remains the durable
fix.

`makesafeBoardAction` no longer calls `loadIntakeExceptionProjection` directly.
It goes through `_loadIntakeExceptionProjectionForBoard`, which catches, logs
`[ops-api] ALARM makesafe_board intake exception projection degraded (board
still served)` with the guard's own message verbatim, and returns
`degradedIntakeExceptionProjection(...)`. The uniqueness guard is untouched and
now serves as the alarm rather than a board-wide outage.

Two properties hold the change up, both covered by
`makesafe_board_intake_exception_degrade_test.ts`:

- **The empty desk announces itself.** The degraded payload carries
  `degraded: { reason: "projection_read_failed", error, failed_at }`, and a
  healthy projection states `degraded: null` rather than omitting the field. Zero
  exception cards is never readable as a clean intake — this repo's
  "a wrong column name reads as no data" failure mode, avoided by construction.
- **Only the board degrades.** `makesafe_intake_exception_read` still throws on
  the same failure, because serving those cards is its entire purpose.

The end-to-end regression test drives `makesafeBoardAction` against a fixture
carrying the exact two-issue-rows-on-one-post shape plus a ledger overlay, and
asserts HTTP 200 with `declared_stage: report_ready` /
`canonical_stage: archive`. It fails without the fix (the throw escapes the
action's `Promise.all`) and passes with it.

Post-deploy browser verification of SWMS-261124 rendering under Archive is the
remaining step; it cannot run until this merges and the Edge Function workflow
deploys `ops-api`.
