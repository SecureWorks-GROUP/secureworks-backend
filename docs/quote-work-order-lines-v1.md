# Work order lines from the accepted quote (v1)

Captain, 12 Oct 2026: "Quotes are always priced from a number of hours, not a random
figure: the quote has a cost breakdown section, and that breakdown should come through
on the work order as the allocation towards the trades." His answers on the plan:

1. No trade sees a dollar amount, the lead trade included: every trade sees hours (and
   quantities) only.
2. A variation joins the existing work order as a marked addendum (built in
   plan step 4: "Customer variations" in `docs/job-work-orders-v1.md`).
3. Fencing is shown as quoted, per metre, with hours only where the quote has hours.
4. The quote's own cost table is the one rate source.

Approved 13 Oct 2026 ("go"). This slice does four things:

- the "work order from the quote" builder (plan step 2);
- filling an untouched job work order draft (`docs/job-work-orders-v1.md`) from it when
  staff open it, when staff read it, and in the backfill's apply (part of plan step 3);
- the backfill fill for open jobs;
- the staff preview action `quote_work_order_lines`.

Not in this slice: retiring the old office create work order form (the crew
`create_work_order` path and its dashboard form) is a tracked follow-up of step 3. The
fence and patio quoting tool source fixes (step 1: every extra marked Labour or Material,
labour lines carrying hours and a cost per hour) are separate PRs. Customer variations
(step 4) are built separately ("Customer variations" in `docs/job-work-orders-v1.md`); the
screens are a later step.

Code:

- `supabase/functions/ops-api/quote_work_order_lines.ts`: the pure builder.
- `supabase/functions/ops-api/job_work_order_quote_fill.ts`: the reads and the one write.
- `job_work_orders.ts` calls the fill when staff open or read a draft, in the backfill, and
  in the automatic issue while it is switched on.

Tests: `quote_work_order_lines_test.ts`, `job_work_order_quote_fill_test.ts` and
`job_work_order_quote_fill_handler_test.ts`.

## Which quote

Only the accepted quote is read, never a revision frozen after acceptance and never the
job's live `pricing_json`. The rule is the one the expected-costs freeze uses
(`_shared/expected_costs/expected_costs_freeze.ts`):

- the revision recorded at acceptance (`jobs.expected_costs.scope_revision_id`), read whether
  it is still `frozen` or was `superseded` by a later revision (a re-quote after acceptance);
- without one, the latest revision, `frozen` or `superseded`, frozen at or before
  `jobs.accepted_at`;
- with neither a recorded revision nor an acceptance time, and only then (captain, 16 Oct
  2026): a job that has moved past quoted (it is in an open status,
  `JOB_WORK_ORDER_OPEN_STATUSES`) counts as accepted at its latest frozen quote, the newest
  revision still in status `frozen`, whenever it was frozen. A `superseded` revision never
  counts under this rule, so a re-quote fills from the current quote. A status change on the
  Ops screen to `accepted` stamps `jobs.accepted_at`; one straight to another open status
  (deposit, scheduled, ...) does not, so this is how those jobs' fence-tool or patio-tool
  quote counts.

Its pricing is read from `scope_revisions.pricing_canonical_text`. With no accepted revision
(no recorded revision, no acceptance time and no frozen revision, a recorded revision that
cannot be found, an acceptance time with only revisions frozen after it, or a job not in an
open status) the result is flagged `no_accepted_quote` and the draft is not filled
(`quote_fill.reason` `no_accepted_quote`); it stays empty for the approver to fill. An
accepted revision whose pricing cannot be read adds `frozen_quote_unreadable` and is never
replaced by another revision. Measured read-only on 16 Oct 2026: 55 of the 81 open fencing
and patio jobs have an accepted revision by this rule (18 recorded, 8 by acceptance time, 29
by the latest frozen quote: 5 fencing, 24 patio). The other 26 stay with the office to fill
by hand, as the captain accepted: older quotes from before the tools froze quotes and jobs
with no quote in the system. A quote saved with no labour figure is filled but held for the
office too (`agreed_labour_missing`, docs/job-work-orders-v1.md).

## The lines

Each line is a `scope_items` entry of the job work order:

`{line_key, source:"quote", basis, description, qty, unit, hours, rate, rate_unit, total, counted, flags[], needs_review, quote_cost_ex?}`

- **The trade view.** It keeps `description`, `qty`, `unit` and `hours` only
  (`projectTradeJobWorkOrder`; `hours` is null on a line priced per metre or each).
  A line priced by the hour carries its hours as `qty` with unit `hrs`, so trades see the time.
  Descriptions never carry a rate, amount, percent or money word, because the trade filter
  withholds a whole line that does. `rate`, `total`, `counted`, `flags`,
  `needs_review` and `quote_cost_ex` are office-only.
- **`agreed_labour_ex` is the quote's own labour figure** (`labourCostEstimate`, else
  `internal.labour`), never a sum re-priced from today's cost table. A quote with no labour
  figure gives no agreed labour (`quote_labour_missing`): the draft is filled with lines only.
- **`counted` lines** are the lines the quote's labour figure is made of, so they add up to
  it. A line that is not counted stays on the work order for the trades to see, with at
  least one flag saying why it was not counted.
- **`needs_review`** is true on a line carrying any flag other than `saved_as_material` or
  `quote_counted_as_materials`, so the approver can see which lines to check.
- **`line_key`** is `<prefix>:<index in pricing.line_items>`, the prefix being `install:`
  (`fence_install`), `gate:` (`fence_gate`), `removal:` (`removal`), `labour:` (a
  `category: labour` row or any `kind: labour` row) or `extra:` (any other `custom`
  row). Two keys carry no index: `plinths` (summed across rows) and
  `access` (derived).

### Fencing

The fence tool's own labour formula is split into tasks, using the scoping tool's cost
table (`scope_tool_defaults`, `scope_tool = 'fence-designer'`), the table the tool prices
from:

| basis | from | rate key |
| --- | --- | --- |
| `fence_install` | each `category: fencing` row, metres | `base-labour` ($/m) |
| `fence_plinths` | plinth rows in `materials`, count | `plinth-install` |
| `fence_gate` | each `gates` row | `gate-labour-pedestrian`, or `gate-labour-double` for double and sliding gates |
| `fence_access` | the quote's own `Access surcharge (N%)` row | N% of the install subtotal |
| `removal` | each `removal` row | `remove-hardie-cost`, `remove-timber-cost`, `remove-colorbond-cost`, `remove-asbestos-cost`, `veg-clear-cost` |

The rebuilt install split (install, plinths, gates and access) is compared with the
quote's `labourCostEstimate`. It matched exactly on all 140 fencing quotes since 1 Aug 2026
(measured 13 Oct 2026). The split counts only when it reproduces that figure from rates the
quote used. When it cannot be verified, none of it counts and every split line (install,
plinths, gates, access) is flagged `labour_split_unverified` and in review
(`needs_review: true`). It cannot be verified when:

- a cost table row a split line uses was changed after the accepted revision was frozen
  (`scope_tool_defaults.last_updated_at` after `frozen_at`, or no time to compare): only the
  lines that use that row are also flagged `rates_changed_since_quote`, and so is the result;
- a split rate is missing: that line is also flagged `rate_missing`;
- the split differs from the quote's labour figure: the result and every line priced from the
  table, removal included, are also flagged `labour_differs_from_quote`;
- the quote has no labour figure (`quote_labour_missing`).

A removal line is affected only by its own rate row: it is flagged `rates_changed_since_quote`
when that row changed.

Removal is never part of the quote's labour figure (its cost breakdown files removal under
materials), so removal lines are never counted and carry `quote_counted_as_materials`. An
asbestos removal is flagged `licensed_removal`. The asbestos certificate fee is not a task,
so it is left out.

### Labour lines and extras

These rules apply to any job type.

- **A `category: labour` row or a `kind: labour` row** is labour. Its hours come from
  `hours`, or from its quantity when its unit is hours. Its rate is `cost_per_hour`, else
  `cost_price` per quoted unit. These are the quoting tools' own field names: the fence tool
  writes `kind`, `hours`, `cost_per_hour` and `total_cost`; the patio tool writes `kind`,
  `hours` and `cost_per_hour`. A labour row with no
  hours is flagged `hours_missing`, unless it is priced per metre, each or per sheet. A
  labour row with no cost is flagged `cost_missing` and is not counted.
- **A custom labour or hours line counts only when it is part of the quote's labour
  figure:** when the install split (fencing) or the labour rows (patio) plus those lines
  reproduce `labourCostEstimate`, as the quoting tools' new format does. When the split (or
  the patio labour rows) reproduces the figure without it, it stays on the work order
  uncounted and flagged `outside_quote_labour` for the approver to decide. When that could
  not be checked (split unverified, no labour figure, or a mismatch), it is uncounted and
  flagged `labour_unverified`: it may already be inside the agreed labour.
- **A `custom` row priced in hours** is labour, whatever its kind. It is flagged
  `saved_as_material` when the fence tool saved it as material, or `kind_missing` when it
  has no kind. Example: "Root removal / hard digging, 2 hrs" at $80 an hour is 2 hours, $160.
- **Any other `custom` row** is not guessed at. It keeps its quantity, is not counted, and
  carries `quote_cost_ex` (what the quote's cost breakdown put against it) and
  `labour_or_material_unknown`. If its words mention hours ("3 hours 2 trades…"), it is
  also flagged `hours_in_words`, and those hours are never read as hours.
- **Patio:** the quote's labour rows ("Labour — 2 trades × 1.5 days", 24 hrs at $45) come
  through as hours and count when their sum equals `labourCostEstimate`; on 81 patio quotes
  since 1 Aug 2026 it matched on every one. When it does not, they are flagged
  `labour_differs_from_quote` and `labour_split_unverified` and not counted.

### Result

`{schema:"quote-work-order-lines.v1", job_type, lines[], agreed_labour_ex, totals:{install_labour_ex, removal_ex, extras_labour_ex, uncertain_cost_ex}, quote_labour_ex, labour_matches_quote, needs_review, flags[]}`

- `agreed_labour_ex` is the quote's labour figure, null when the quote has none.
- `totals` are the line totals by group, counted or not (an office breakdown).
- `labour_matches_quote` is true when the counted lines reproduce the quote's labour figure,
  false when they cannot, and null when nothing could be compared (no labour figure, a rate
  missing or changed since the quote).
- `needs_review` is true when any flag other than `saved_as_material` or
  `quote_counted_as_materials` is present.
- **Review flags ride on every line.** The result's flags (`quote_labour_missing`,
  `unsupported_job_type`) and the quote's (`frozen_quote_unreadable`) are added to each
  line's `flags`, with `needs_review: true`, so they stay on the stored draft after the one
  call that filled it. `rates_changed_since_quote` and `labour_differs_from_quote` stay on
  the lines they concern only: a line carries `rates_changed_since_quote` only when a cost
  table row it uses changed, and `labour_differs_from_quote` marks every line priced from
  the table. `flags` and `needs_review` are office-only: trades never see them.

## Issuing a draft with flagged lines

While `job_work_order_auto_issue_v1` is on (`docs/job-work-orders-v1.md`, "Automatic
issue"), a filled draft nobody has edited goes to the trades without an approval, flagged
lines included: the flags stay on the sealed lines and reach the office as the
`needs_checking` note, never the trades. The fill stamps `quote_filled_at` on the draft it
writes (not on a draft someone already edited by hand), which is what the automatic issue
requires. What follows applies while the switch is off, or to a draft held for the approver.

## Approving a draft with flagged lines

Approval (`approve_work_order`, `docs/job-work-orders-v1.md`) does not refuse a draft whose
lines carry flags. A flagged draft can be approved and sealed as it is: the captain approves
each work order, and the flags on its lines are there for him to read first. A line that is
not counted (for example an old "Root removal, 1 job" extra, `labour_or_material_unknown`,
a custom hours line outside the quote's labour, `outside_quote_labour`, or one that could
not be checked against it, `labour_unverified`) adds nothing to
`agreed_labour_ex` unless the approver edits the draft before approving.

## Filling the job work order draft

`fillJobWorkOrderDraftFromQuote` writes only to a job work order (`kind = 'job'`) in
`draft`, and only while the draft is untouched: no `scope_items` and no
`agreed_labour_ex`.

- **An approved work order is never written.**
- **The write is guarded by the draft's `updated_at` as read.** If a save lands between the
  read and the fill, the save wins and the fill writes nothing (`draft_changed`).
- **What is written:** `scope_items` gets the lines, and `agreed_labour_ex` the quote's own
  labour figure. When the quote has none, `agreed_labour_ex` is left empty for the approver
  to set.
- **The event:** `job_work_order_draft_filled_from_quote` carries ids and counts only, never
  an amount.

It runs at four points:

- `job_work_order` (and `job_detail`'s `job_work_order` block) fills an untouched draft on
  the staff read: a signed-in admin, owner or ops manager, or the ops server key. A read
  with the make-safe routine key (`job_detail` is on its allow-list, which stays
  writes-free) never fills or writes anything. Every draft is read by staff before it can be
  approved, because approval needs the draft's `updated_at` as read. This also covers drafts the database trigger
  opened when the job was accepted. The response (and `job_detail`'s block) carries
  `quote_fill: {filled, reason, scope_revision_id, needs_review, code?}`, or `null` when
  nothing was attempted.
- `create_work_order` with `kind:"job"` fills the draft it opens, unless the call brought
  its own `scope_items` or `agreed_labour_ex`. Response: `{created, work_order, quote_fill}`.
- `backfill_job_work_orders` with `apply: true` (still behind
  `job_work_order_backfill_v1`) fills untouched drafts after opening the missing ones, at
  most `fill_limit` per call, oldest first (default 100, at most 200). It adds
  `quote_fill: {dry_run, untouched_drafts, attempted, filled, not_filled:{reason:n}, remaining}`.
  A draft is left untouched, and tried again on the next run, only when its quote gives no
  work order lines or the job has no accepted quote. A quote with lines but no labour figure
  is filled with lines only. A dry run fills nothing and counts `untouched_drafts`.
- The automatic issue (`auto_issue_job_work_orders` and the `update_job_status` hook), only
  while `job_work_order_auto_issue_v1` is on, fills an untouched draft nobody has edited by
  hand before issuing it (`docs/job-work-orders-v1.md`, "Automatic issue").

A fill failure never fails the open, the read, the backfill or the automatic issue; the reason is reported
instead. An unreadable cost table or quote is a failure (`fill_failed` with
`code: cost_table_unreadable` / `quote_unreadable`), never a fill on missing rates.

## Preview

`GET ops-api?action=quote_work_order_lines&job_id=<job id>` (staff only). It writes nothing
and returns:

`{job:{id, job_number, type, status}, quote:{source, scope_revision_id, frozen_at, flags}, result}`

`quote.source` is `accepted_revision`, `revision_at_acceptance`,
`latest_frozen_revision`, or null when the job has no accepted revision (`flags` then holds `no_accepted_quote`).

- 400 `job_id_required`, before any query, when `job_id` is missing or is not a job id
  (uuid). A job number is not accepted.
- 404 `job_not_found` for an unknown job.
