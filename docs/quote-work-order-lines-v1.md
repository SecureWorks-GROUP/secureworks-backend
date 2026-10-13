# Work order lines from the accepted quote (v1)

Captain, 12 Oct 2026: "Quotes are always priced from a number of hours, not a random
figure: the quote has a cost breakdown section, and that breakdown should come through
on the work order as the allocation towards the trades." His answers on the plan:

1. No trade sees a dollar amount, the lead trade included: every trade sees hours (and
   quantities) only.
2. A variation joins the existing work order as a marked addendum (later step).
3. Fencing is shown as quoted, per metre, with hours only where the quote has hours.
4. The quote's own cost table is the one rate source.

Approved 13 Oct 2026 ("go"). This slice is plan steps 2 and 3: the builder, and filling
each job work order draft (`docs/job-work-orders-v1.md`) from it. Variations and the
screens are later steps.

Code:

- `supabase/functions/ops-api/quote_work_order_lines.ts`: the pure builder.
- `supabase/functions/ops-api/job_work_order_quote_fill.ts`: the reads and the one write.
- `job_work_orders.ts` calls the fill when staff open or read a draft, and in the backfill.

Tests: `quote_work_order_lines_test.ts` and `job_work_order_quote_fill_test.ts`.

## Which quote

The accepted quote is the scope revision frozen at acceptance
(`jobs.expected_costs.scope_revision_id`, read from `scope_revisions.pricing_canonical_text`).
If that is missing, the newest frozen revision is used. If there is no frozen revision, the
job's live `pricing_json` is used, and the result is flagged `quote_not_frozen`, which puts
it in review.

## The lines

Each line is a `scope_items` entry of the job work order:

`{line_key, source:"quote", basis, description, qty, unit, hours, rate, rate_unit, total, counted, flags[], quote_cost_ex?}`

- **The trade view.** It keeps `description`, `qty` and `unit` only (`projectTradeJobWorkOrder`).
  A line priced by the hour carries its hours as `qty` with unit `hrs`, so trades see the time.
  Descriptions never carry a rate, amount, percent or money word, because the trade filter
  withholds a whole line that does. `rate`, `total`, `hours`, `counted`, `flags` and
  `quote_cost_ex` are office-only.
- **`counted` lines** add up to `agreed_labour_ex`. A line that is not counted stays on the
  work order for the trades to see, with flags saying why it was not counted.
- **`line_key`** is `<basis>:<index in pricing.line_items>`. Two exceptions: `plinths`
  (summed across rows) and `access` (derived).

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
(measured 13 Oct 2026). When the two differ, the result is flagged
`labour_differs_from_quote` and each install line is flagged `rates_differ_from_quote`.

Removal is counted, but the quote's cost breakdown files it under materials, so removal
lines carry `quote_counted_as_materials`. An asbestos removal is flagged
`licensed_removal`. The asbestos certificate fee is not a task, so it is left out.

### Labour lines and extras

These rules apply to any job type.

- **A `category: labour` row or a `kind: labour` row** is labour. Its hours come from
  `hours` / `labour_hours`, or from its quantity when its unit is hours. Its rate is
  `cost_per_hour` / `hourly_cost`, else `cost_price` per quoted unit. A labour row with no
  hours is flagged `hours_missing`, unless it is priced per metre, each or per sheet. A
  labour row with no cost is flagged `cost_missing` and is not counted.
- **A `custom` row priced in hours** is labour, whatever its kind. It is flagged
  `saved_as_material` when the fence tool saved it as material, or `kind_missing` when it
  has no kind. Example: "Root removal / hard digging, 2 hrs" at $80 an hour is 2 hours, $160.
- **Any other `custom` row** is not guessed at. It keeps its quantity, is not counted, and
  carries `quote_cost_ex` (what the quote's cost breakdown put against it) and
  `labour_or_material_unknown`. If its words mention hours ("3 hours 2 trades…"), it is
  also flagged `hours_in_words`, and those hours are never read as hours.
- **Patio:** the quote's labour rows ("Labour — 2 trades × 1.5 days", 24 hrs at $45) come
  through as hours. Their sum is compared with `labourCostEstimate`; on 81 patio quotes
  since 1 Aug 2026 it matched on every one.

### Result

`{schema:"quote-work-order-lines.v1", job_type, lines[], agreed_labour_ex, totals:{install_labour_ex, removal_ex, extras_labour_ex, uncertain_cost_ex}, quote_labour_ex, labour_matches_quote, needs_review, flags[]}`

- `agreed_labour_ex` is null when no line could be counted.
- `needs_review` is true when any flag other than `saved_as_material` or
  `quote_counted_as_materials` is present.

## Filling the job work order draft

`fillJobWorkOrderDraftFromQuote` writes only to a job work order (`kind = 'job'`) in
`draft`, and only while the draft is untouched: no `scope_items` and no
`agreed_labour_ex`.

- **An approved work order is never written.**
- **The write is guarded by the draft's `updated_at` as read.** If a save lands between the
  read and the fill, the save wins and the fill writes nothing (`draft_changed`).
- **What is written:** `scope_items` gets the lines, and `agreed_labour_ex` the counted
  total. When nothing could be counted, `agreed_labour_ex` is left empty for the approver to
  set.
- **The event:** `job_work_order_draft_filled_from_quote` carries ids and counts only, never
  an amount.

It runs at three points:

- `job_work_order` (and `job_detail`'s `job_work_order` block) fills an untouched draft on
  the staff read. Every draft is read by staff before it can be approved, because approval
  needs the draft's `updated_at` as read. This also covers drafts the database trigger
  opened when the job was accepted. The response carries
  `quote_fill: {filled, reason, scope_revision_id, needs_review, code?}`, or `null` when
  nothing was attempted.
- `create_work_order` with `kind:"job"` fills the draft it opens, unless the call brought
  its own `scope_items` or `agreed_labour_ex`. Response: `{created, work_order, quote_fill}`.
- `backfill_job_work_orders` with `apply: true` (still behind
  `job_work_order_backfill_v1`) fills untouched drafts after opening the missing ones, at
  most `fill_limit` per call, oldest first (default 100, at most 200). It adds
  `quote_fill: {dry_run, untouched_drafts, attempted, filled, not_filled:{reason:n}, remaining}`.
  A draft whose quote has no labour lines stays untouched and is tried again on the next
  run. A dry run fills nothing and counts `untouched_drafts`.

A fill failure never fails the open, the read or the backfill; the reason is reported
instead. An unreadable cost table or quote is a failure (`fill_failed` with
`code: cost_table_unreadable` / `quote_unreadable`), never a fill on missing rates.

## Preview

`GET ops-api?action=quote_work_order_lines&job_id=<uuid or job number>` (staff only).
It writes nothing and returns:

`{job:{id, job_number, type, status}, quote:{source, scope_revision_id, frozen_at, flags}, result}`

- 400 `job_id_required` when no job is named.
- 404 `job_not_found` for an unknown job.
