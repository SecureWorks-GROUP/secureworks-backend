# Never-miss-a-repair reconciliation

`scripts/repair-intake-reconciliation.sql` — **read-only**, run by hand, daily.

```sh
psql "$DATABASE_URL" -f scripts/repair-intake-reconciliation.sql
```

Nothing schedules it and nothing automates it. It is a saved check, not a job.

## Why it exists

Every alarm that exists today proves the *mechanism* works — the intake watchdog
watches scan liveness, the draft heartbeat watches for a stalled pipeline, the
migration contract and the test suites prove the code does what it says.

**None of them can tell you a repair was missed, because a missed repair is a
correctly-executed make-safe.** The card looks completely normal. No test fails,
no alarm fires, nothing is red.

The only thing that catches it is comparing the repair signal that came *in*
against the repair family that came *out*.

## How to read the output

Four result sets.

| Section | What it is | What you want |
|---|---|---|
| **A** | Work orders in the last 48h carrying an explicit repair signal | a short list, usually empty |
| **B** | Repair-family jobs actually created in the same 48h | `repair_jobs_created` >= the row count of A |
| **C** | Exception cases needing a human decision | read them; nothing here produced a job |
| **D** | Drafts still unapproved | watch `older_than_7d` and `oldest` |

### The alarm is: A has more rows than B has jobs

That means a work order arrived carrying a repair signal and did not become a
repair card. Take the row from A, find the job it became, and correct it (see
BUILD-REPORT.md §7 and the correction notes in OPEN RISKS).

On 90-day historical volumes section A returns roughly **two rows a quarter**, so
an empty A on most days is the expected reading, not a broken query.

### Section B's split matters

- `true_repair_type` — minted through the repair route, `type='repair'`, `SWR-`.
- `legacy_marker_only` — carries a repair marker but is still `type='makesafe'`
  with an `SWMS-` number. These are corrections applied after the fact. A
  persistently non-zero `legacy_marker_only` with a zero `true_repair_type`
  means the classifier is not routing and every repair is being corrected by
  hand.

### Section D

There is no staleness alarm for an unapproved draft anywhere in the system, and
the board's own INTAKE list is capped at 50 rows. If `open_drafts` is above 50,
the board is not showing you all of them.

## What section A deliberately does not look for

MLB's `Makesafe/Emergency Repairs` work-order category — 242 of the last 90 days'
headers. The classifier maps it to make-safe on purpose, and whether that label
should mean repair is **a captain decision that has not been taken**. Adding it
here would return ~240 rows a quarter and drown the signal that works.

Same for scope prose. Prose is not a marker: the false-positive analysis in
`docs/repair-backfill-review-2026-08-26.md` shows why (`"Rapid Repair"` is also a
company name in email signatures, and `"make temporary repair to make water
tight"` is a genuine make-safe).

## Known limitation

Section A reads `makesafe_intake_drafts.body_preview`, not the full body, and the
labelled dispatch line can fall outside the preview on a long email. The PDF lane
(`pdf_declared_repair`) has no such limit. If a repair is missed that A did not
flag, check whether the dispatch line was past the preview cut.
