# Job budget v1 (ruling 17 step 1, backend half)

The job budget is what a sealed quote says the job will cost and make: every
material line by supplier, the labour, the other lanes (delivery, removal, skip
and tip, hire, buffer, other), commission and the totals. The Scope Engine
builds it at seal and freezes it as the top-level key `budget` of the
revision's pricing record (`scope_revisions.pricing_canonical_text`, covered by
`pricing_hash`), shape `budget.v1`. The job system stores it at acceptance.

Step 1 only records it. Nothing reads it for money yet: `jobs.expected_costs`
is written exactly as before and Job Profit is unchanged (step 5 switches
both). No operator share of profit is recorded anywhere.

## Where it comes from (B1, B11)

- Only the accepted revision the acceptance chain names
  (`readAcceptedQuoteCostSource` answers `bound`), read through
  `fetchNamedAcceptedRevision`, its pricing re-hashed against `pricing_hash`.
  Never `jobs.pricing_json`, which the tools may also carry a `budget` in.
- `bound` means the whole job is accepted (every party), every accepted
  document was released from one revision, and no variation is accepted. Any
  other answer stores nothing: an accepted variation means no budget (B11).
- A revision sealed before step 1 has no `budget` key: nothing is stored and
  today's path runs.

## What is stored

`supabase/migrations/20261113190000_job_budgets.sql`:

| Object | What it is |
| --- | --- |
| `job_budgets` | One row per accepted revision: the totals as columns, the taken option ids, the revision's `pricing_hash`, the whole budget as `budget` (jsonb). Version 1, 2, ... per job. Write-once (trigger refuses update, delete, truncate). |
| `job_budget_lines` | One row per line, every lane, unique on `(budget_id, key)` (B4). `line_id` where the tool sealed one. A materials line keeps its sealed `supplier_key` and `kind` (`item`, `delivery`, `cutting`); other lanes have neither. Write-once. |
| `record_job_budget(...)` | The one writer, service role only. Checks the revision is the job's, frozen, with that hash; refuses a third decimal (B7); same budget again is a replay, a different one for the same revision is `job_budget_conflict`. |
| `v_job_budget` | Each job's current version (lanes, `by_supplier`, totals, gaps), or `state = 'refused'` with `state_label = 'budget refused: <code>'` when the job has no stored budget and a refusal was recorded. Staff and service only. |

Money is dollars, `numeric(12,2)`, ex GST unless the name says inc. Percents
are `numeric(5,2)` for the commission rate (B10) and two decimals for the
profit percents. `total_inc_gst = sell_ex_gst + gst` and the profit sums are
table checks (B8). `staff_id` values are `public.users.id` (B9). `rule_id` is
free text (B10).

## At acceptance

`recordJobBudgetOnAcceptance` (`_shared/job_budget/record_job_budget.ts`) runs
at both send-quote acceptance sites, right after
`freezeExpectedCostsOnAcceptance`, in its own try/catch. It never blocks or
undoes an acceptance.

1. Read the bound revision and its `budget`.
2. Check the base budget adds up (`checkBudget`, `_shared/job_budget/budget_v1.ts`).
3. Add the options the customer took (`readTakenQuoteOptions`) by the contract's
   one formula (`budgetWithOptions`, B6), then check the result again.
4. When options were taken, the result's sell, GST and total must equal the
   acceptance record's accepted totals to the cent.
5. Store it through `record_job_budget`.

### A budget that does not add up (B2)

The acceptance stands. Nothing is stored. One `job_budget_refused` job event
records `{ code, at?, scope_revision_id }`. Job events are readable by trades,
so the event never carries money. `v_job_budget` shows
`budget refused: <code>`. Before the migration is applied the writer answers
`store_missing` and writes no event.

Codes come from `checkBudget` (`gst_mismatch`, `lane_total_mismatch`,
`supplier_lines_mismatch`, `supplier_delivery_mismatch`, `supplier_key_mismatch`,
`line_kind_invalid`, `supplier_total_mismatch`, `gross_profit_mismatch`, `commission_mismatch`,
`gap_not_named`, `key_not_unique`, `money_not_two_decimals`, ... one per
failed add-up), from the formula (`option_not_in_budget`, ...), and from the
writer: `pricing_hash_mismatch`, `budget_revision_mismatch`,
`quote_options_unreadable`, `option_sell_mismatch`, `budget_conflict`,
`budget_write_failed`.

### Materials as the tool seals them (contract draft 3)

- Each materials line carries the `supplier_key` of the `by_supplier` entry it
  adds to, and a `kind`. The checks read that key, never work it out again,
  and it must be the line's supplier's (its id, `name:<name>`, or `none`).
- An entry's `lines_ex_gst` is its counted `item` and `cutting` lines; its
  `delivery_ex_gst` is its counted `delivery` lines; its total is lines plus
  surcharge plus delivery, each counted once.
- One figure for all materials (T1): `priced_by_line: false`, one counted line
  (`cost_from: one_figure`, no supplier id) in the `one_figure` entry. The order
  lines ride along under their own suppliers with `in_total: false` and no
  cost, are not gaps, and those suppliers' entries may be all zeros.
- The fixings allowance (T2): one counted line, `cost_from: allowance`, in the
  `none` entry ("No supplier order"), not a gap.
- `job.scope_revision_id` is null on a local seal; when it is set it must be
  the accepted revision's id (`budget_revision_mismatch` otherwise).

## The options formula (B6)

`budgetWithOptions(base, takenIds)`: in whole cents, half away from zero, no
division by 1.1. Each taken option adds one line keyed `option:<id>` to the
lane it lands in (a supplier's `by_supplier` entry, a new one with delivery 0
when the supplier is new; labour and the work order amount; or an other lane,
created when missing, crew-paid adding to the work order amount). A taken
option with no cost makes its lane `null` and adds a `no_cost` gap. Totals,
commission (0 when gross profit is zero or less) and both percents are worked
again, the way the tool's `finish` adds a budget up. The result records
`taken_option_ids` in sealed options order (contract section 5 step 4), the
same list stored in the row; nothing taken leaves the base unchanged, with no
`taken_option_ids`. The tool's own shared examples
(`verify/r17-budget/options-examples.json`, copied verbatim to
`_shared/job_budget/fixtures/options-examples.json`) and the examples in
`_shared/job_budget/budget_examples.ts` pass to the cent.

## Who can see it (merge condition)

The budget carries commission and the salesperson. It is staff and service
only. Every read that hands pricing to a customer, a trade or a crew document:

| Read | Audience | What happens to `budget` |
| --- | --- | --- |
| send-quote `view`, run quote page (`buildRunQuotePage`) | customer | `withoutBudget` on the job's pricing before the page is built; the page prints named fields only. |
| send-quote `view`, client page (`buildClientPage`) | customer | The job read selects no pricing. |
| send-quote `model` (customer 3D page) | customer | Reads scope artifacts only, no pricing. |
| send-quote customer emails (send, send-runs, acceptance, decline) | customer | Built from named totals; no pricing record is attached or embedded. |
| ops-api `my_jobs` | trade | `pricing_json` deleted from every card (existing). |
| ops-api `trade_job_detail` | trade | `pricing_json` dropped from the payload (existing); the quote packer gets `withoutBudget(pricing)`; `scope_json` goes through `redactTradeScopeQuote`, whose `TRADE_SCOPE_QUOTE_KEYS` now drops `budget` at any depth. |
| ops-api `trade_quote_extract` | trade | Built from the trade pack, which picks quote lines and terms only; `pricing_json` is on its refused keys. |
| Crew scope of works, work orders (`my_work_orders`, `my_job_work_order`) | crew | Built from the redacted scope and the quote fill's lines (descriptions, no money). |

Staff reads (`get_scope_revision_for_viewer`, `read_job_record`, the scoping
tools through ghl-proxy, reporting) are unchanged and may show it. Proof:
`ops-api/job_budget_strip_test.ts`.

## Dispatch lines carry cost (step 3)

Ruling 17 step 3: a Dispatch material line takes its unit cost and line cost
from the job budget, and an order line over its budget line, or a line not in
the budget, goes out only with a named person's reason recorded. Never
silently $0, never silently over. Migration
`20261114020000_dispatch_line_budget_cost.sql`; the rule is one module,
`ops-api/dispatch_v2_budget_cost.ts`; the store is `ops-api/dispatch_v2_store.ts`.

Switch: `feature_flags.dispatch_budget_cost_v1`, seeded off. Off, missing or
unreadable: Dispatch fills, makes and sends exactly as before. On, for a job
with a stored budget (the newest `job_budgets` version):

| Step | What happens |
| --- | --- |
| Fill (`dispatch_v2_suggest_draft`) | Lines come from the budget's materials lines, each naming its budget line (`job_material_lines.budget_id` + `budget_line_key`). The budget must be for the job's current frozen revision, else `budget_not_current_revision`. A line's `note_to_supplier` rides as its detail (over 300 characters refuses `supplier_note_too_long`). Delivery and cutting lines, and lines that never go on a supplier order (tek screws, removal, labour), stay on the budget and are named in the fill notes. Taken options are already in the budget, so they are not added again. Standing lines are unchanged. |
| Read (`dispatch_materials`) | Each line carries `cost` (basis, unit cost, line cost, needs a reason or not); the reply carries `budget` (state, version, totals by supplier, how many open lines need a reason). A budget read fault answers `budget: {state: 'unreadable'}`, never "no budget". |
| Make the email | Every orderable line must be costed or carry a covering reason, else 409 `line_cost_needs_reason` naming the lines. The email row stores `order_cost` (`dispatch-order-cost.v1`: each line's basis and cost, the total, the supplier's budget). |
| Send | Refuses `order_cost_missing` if the email was made without its cost, `budget_changed` if a newer budget was stored since, and `line_cost_needs_reason` if a line moved. |
| Reason (`dispatch_v2_line_cost_reason`) | `job_id`, `line_id`, `reason` (3 to 500 characters), `expected_updated_at`, and `unit_cost_ex_gst` only where the budget has none. Signed-in staff only: the ops key is refused `named_person_required`, so every reason names who. |

How a line is costed:

| Basis | When | Needs |
| --- | --- | --- |
| `budget` | Linked, same unit, at or under the budget quantity | Nothing. Line cost = budget unit cost x quantity, whole cents half up. |
| `one_figure` | A one-figure budget's line at or under quantity | Nothing. No per-line dollars: the job has one materials figure. |
| `over_budget` | Over the budget quantity | A reason for that quantity and unit. The budget unit cost still applies (a one-figure line also needs a unit cost). |
| `unit_changed` | Unit differs from the budget line | A reason and a unit cost. |
| `no_budget_cost` | The budget line has no unit cost | A reason and a unit cost. |
| `not_in_budget` | Typed in, or from an older budget | A reason and a unit cost. |
| `quantity_missing` | No quantity | Never ordered, never costed. |

With the switch on, a budget that cannot be read refuses the fill, the email,
the send and a reason with 503 `budget_unreadable`, never treated as no budget.

A reason covers the quantity and unit as they stood; a later rise needs a new
one. Reasons are append-only (`dispatch_line_cost_reasons`, service role read
and add only, RLS on); the line names its current one (`cost_reason_id`), and
the database refuses a line naming another line's reason.

What it never does: print a dollar on the supplier email (the body is built
from the line text only; the director decides any change), cost the v1
purchase order path or an order recorded from Outlook, or write a job event
with money. Tests: `ops-api/dispatch_v2_budget_cost_test.ts` (the rule, on the
tool's native budgets), the `budget ...` cases in
`ops-api/dispatch_v2_store_test.ts`, and the migration contract
`supabase/tests/migration-contracts/20261114020000_dispatch_line_budget_cost/`.

Rollout: apply the migration before the matching `ops-api`; turn the switch on
only on the owner's word. The rollback refuses while any line link, reason or
order cost is recorded (turn the switch off instead).

## Tests

- `_shared/job_budget/budget_v1_test.ts`: the formula, the tool's shared
  examples and A to D (with `taken_option_ids`), every add-up code, gaps,
  supplier delivery lines, the exact native one-figure patio and allowance
  entry, the native sealed budgets of both trades
  (`fixtures/native-budgets.json`), money to two decimals, the strip.
- `_shared/job_budget/record_job_budget_test.ts`: the acceptance writer.
- `ops-api/job_budget_strip_test.ts`: every read in the table above.
- `supabase/tests/migration-contracts/20261113190000_job_budgets/`: privileges,
  the writer, replay, conflict, revision and decimal refusals, write-once, the
  view and the refused state; break and rollback proofs.

## Rollout

Apply `20261113190000_job_budgets.sql` before or with the matching
`send-quote` deploy (the writer skips with `store_missing` until it is
applied). The rollback (`supabase/rollbacks/20261113190000_job_budgets_down.sql`)
drops the writer, the view and the guard and keeps every stored budget.
