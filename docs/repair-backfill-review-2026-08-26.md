# Repair backfill — human review list (2026-08-26)

**Decision needed from Shaun.** Nothing on this page is claimed by any script.
The deterministic backfill (`scripts/backfill-repair-stage.sql`) touches exactly
three jobs and none of the rows below. These are the *candidates* a text sweep
turned up, and every one of them needs a human call before it could ever be
treated as repair-family work.

## Why a human has to do this

There is **no deterministic marker for historical repair work.**

| marker | jobs carrying it |
|---|---|
| `metadata.makesafe_job_family = 'repair'` | 1 |
| `metadata.ses_family = 'repair'` | 2 (and `ses_family` exists on only 2 rows in the entire database) |
| `makesafe_job_details.report_type = 'repair'` | 2 |
| **union of all three** | **3** |

The family taxonomy only started being written mid-2026 and has never assigned
`repair` to more than one job. Everything else is prose.

A naive `ILIKE '%repair%'` sweep across `notes`, `scope_json`, `metadata`,
`pricing_json`, `client_name` and `site_address` returns 69 rows out of 2571.
Two sources dominate the false positives:

1. **`"Makesafe/Emergency Repairs"`** — the SES *work-order category name*
   printed on genuine make-safe WOs (MLB and others). ~20 rows.
2. **`"Rapid Repair"`** — a *company name* in captured email signatures
   (Chantelle Nicholls / Lexi Johnson, Rapid Repair, PO Box 2143 Malaga).
   ~8 rows in `notes`/`metadata`, plus 2 as `client_name`.

Stripping both leaves the **35 rows** below. Even those are mostly genuine
make-safes whose scope narrative happens to mention a temporary repair
("make temporary repair to make water tight"). Those are make-safes, not
repair-family jobs.

## How to use this page

Mark each row. Only rows marked **YES** would be added to a follow-up,
hand-adjudicated backfill — and that backfill would still be additive metadata
only, exactly like the deterministic one. No retyping, no renumbering.

- **YES** — this is repair-family work and belongs on the Repairs board
- **NO** — this is a make-safe whose narrative mentions a repair
- **?** — needs the work order pulled up

## Already claimed deterministically (NOT for review — listed for completeness)

| job_number | type | status | suburb | marker |
|---|---|---|---|---|
| SWMS-261029 | makesafe | processing | Midland | `makesafe_job_family='repair'` |
| SWMS-261163 | makesafe | processing | Falcon | `ses_family='repair'` + `report_type='repair'` |
| SWMS-261192 | makesafe | processing | Boddington | `ses_family='repair'` + `report_type='repair'` |

Note the marker disagreement on SWMS-261163: `makesafe_job_family` says
`general_makesafe` while `ses_family` says `repair`. The two fields are not kept
in sync. The board reads them additively, so the card shows up either way.

## The 35 candidates

Sorted by creation date. `sealed` is the SES money seal — every row except
SWF-26952 already carries one, which is another reason nothing here gets retyped.

| # | job_number | type | status | created | sealed | matched text | call |
|---|---|---|---|---|---|---|---|
| 1 | SWF-26952 | fencing | archived | 2025-05-19 | no | Fence post repair (dividing fence, 4 posts) - quote accepted via email | |
| 2 | SWMS-26416 | makesafe | archived | 2026-06-03 | yes | *(metadata only)* | |
| 3 | SWMS-26504 | makesafe | cancelled | 2026-06-07 | yes | garage door came off. Make safe and repair works scheduled. | |
| 4 | SWMS-26505 | makesafe | cancelled | 2026-06-07 | yes | Assessment and quote for repair work. | |
| 5 | SWMS-26606 | makesafe | archived | 2026-06-12 | yes | make temporary repair to make water tight | |
| 6 | SWMS-26630 | makesafe | complete | 2026-06-15 | yes | make temporary repair to make water tight | |
| 7 | SWMS-26631 | makesafe | cancelled | 2026-06-15 | yes | Make safe repairs to valley gutter ... | |
| 8 | SWMS-26707 | makesafe | processing | 2026-06-20 | yes | *(metadata only)* | |
| 9 | SWMS-26716 | makesafe | cancelled | 2026-06-21 | yes | flooring and cupboard inspection/repair | |
| 10 | SWMS-26725 | makesafe | processing | 2026-06-21 | yes | Water damage assessment and repair following leaking pipe ... | |
| 11 | SWMS-26739 | makesafe | processing | 2026-06-22 | yes | Initial assessment and repair of 3 damaged door canopies | |
| 12 | SWMS-26744 | makesafe | processing | 2026-06-22 | yes | Storm damage assessment and repairs. Kitchen ceiling cracking ... | |
| 13 | SWMS-26750 | makesafe | processing | 2026-06-22 | yes | Assessment and quote for insurance claim repair | |
| 14 | SWMS-26757 | makesafe | processing | 2026-06-23 | yes | Repair double gates, damaged fly screen ... | |
| 15 | SWMS-26766 | makesafe | processing | 2026-06-23 | yes | Contractor inspection and quote for repair/replacement | |
| 16 | SWMS-26769 | makesafe | processing | 2026-06-23 | yes | fence and gate damage assessment and repair | |
| 17 | SWMS-26772 | makesafe | processing | 2026-06-23 | yes | Initial assessment and quote for fence repair at rear of property, ~25lm | |
| 18 | SWMS-26776 | makesafe | processing | 2026-06-24 | yes | protect public on footpath during repairs | |
| 19 | SWMS-26788 | makesafe | processing | 2026-06-24 | yes | Assessment and quote for storm damage repair: gate and dividing fence ... | |
| 20 | SWMS-26792 | makesafe | processing | 2026-06-24 | yes | Make safe roof repair required to address water entry ... | |
| 21 | SWMS-26810 | makesafe | processing | 2026-06-25 | yes | Roof leak has been repaired but ceiling and eaves still damaged | |
| 22 | SWMS-26816 | makesafe | processing | 2026-06-25 | yes | rear pool fence (make-safe/emergency repair) | |
| 23 | SWMS-26825 | makesafe | processing | 2026-06-26 | yes | *(metadata only)* | |
| 24 | SWMS-26931 | **insurance** | processing | 2026-07-08 | yes | temporary removal of pavers to facilitate repairs ... | |
| 25 | SWMS-26932 | **insurance** | processing | 2026-07-08 | yes | *(metadata only)* | |
| 26 | SWMS-26936 | **insurance** | processing | 2026-07-08 | yes | *(metadata only)* | |
| 27 | SWMS-26949 | makesafe | complete | 2026-07-09 | yes | install plywood in its place until repairs are completed | |
| 28 | SWMS-26978 | **insurance** | processing | 2026-07-14 | yes | *(metadata only)* | |
| 29 | SWMS-261031 | makesafe | processing | 2026-07-21 | yes | *(metadata only)* | |
| 30 | SWMS-261049 | makesafe | scheduled | 2026-07-23 | yes | roof repairer has already attended and fixed; client seeking painting ... | |
| 31 | SWMS-261059 | makesafe | complete | 2026-07-24 | yes | identify water entry, temporary watertight repair | |
| 32 | SWMS-261065 | makesafe | accepted | 2026-07-27 | yes | remove solar panels and store onsite to facilitate fencing repairs | |
| 33 | SWMS-261067 | makesafe | processing | 2026-07-27 | yes | undertake make safe repairs to the valley gutter ... | |
| 34 | SWMS-261118 | makesafe | processing | 2026-07-31 | yes | attend site and remove solar panels ... to facilitate repairs | |
| 35 | SWMS-261179 | makesafe | scheduled | 2026-08-10 | yes | make temporary repair to make water tight | |

## The four bolded rows deserve their own look

Rows 24, 25, 26 and 28 (SWMS-26931 / 26932 / 26936 / 26978) are `type='insurance'`
carrying `SWMS-` job numbers **and** live `makesafe_job_details` rows. That
combination is only possible because a `jobs.type` change is completely
unguarded: `ensure_makesafe_job_details_job_type` fires on the details row's
INSERT / `UPDATE OF job_id` and never on `jobs.type`. These four are standing
evidence that a type-flip backfill passes silently and leaves the MakeSafe
board's read-model desynced — which is exactly why this pipeline's backfill is
metadata-only.

Whatever is decided about their repair status, someone should decide separately
whether they belong back on the make-safe board.

## The narrower reading

If a first pass is wanted, the subset that reads as actual repair or
quote-for-repair work — rather than a make-safe that mentions a repair — is
roughly rows 1, 4, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19, 21, 30, 32 plus the
four `insurance`-typed ones: **on the order of 15-19 rows.** Every one still
needs the call made.
