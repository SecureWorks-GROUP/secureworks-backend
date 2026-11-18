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
`gap_not_named`, `key_not_unique`, `money_not_two_decimals`,
`labour_hourly_invalid`, `labour_hourly_mismatch`, ... one per
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
| ops-api `trade_job_detail` | trade | `pricing_json` dropped from the payload (existing); the quote packer gets `withoutBudget(pricing)`; `scope_json` goes through `redactTradeScopeQuote`, whose `TRADE_SCOPE_QUOTE_KEYS` now drops `budget` at any depth, and `tradeScopePrivateKey` drops every key naming commission or the salesperson (`commissionBasis`, `commissionFrom`, ...) at any depth (ruling 17a). The whole answer then goes through `stripTradePrivateCarriers` for every tier, the office and a division manager included: they keep the quote figures but never a `budget`, commission or salesperson key. |
| ops-api `trade_quote_extract` | trade | Built from the trade pack, which picks quote lines and terms only; `pricing_json` is on its refused keys. |
| Crew scope of works, work orders (`my_work_orders`, `my_job_work_order`) | crew | Built from the redacted scope and the quote fill's lines (descriptions, no money). |

Staff reads (`get_scope_revision_for_viewer`, `read_job_record`, the scoping
tools through ghl-proxy, reporting) are unchanged and may show it. Proof:
`ops-api/job_budget_strip_test.ts`.

## Commission (step 2)

`supabase/migrations/20261113230000_job_commissions.sql`, module
`supabase/functions/ops-api/job_commission.ts`.

### The rate

One rate per trade, of the budget's gross profit, 0 on a loss: fence 15,
patio 8 (the owner's rule, 13 Nov 2026). There is no typed rate per job.

| Object | What it is |
| --- | --- |
| `commission_rates` | Append-only: a change is a new row (trade, `rule_id`, percent, `basis = gross_profit`, who, why, when). Seeded `fence_gross_profit_rate` 15.00 and `patio_gross_profit_rate` 8.00. |
| `v_commission_rates` | The current rate per trade. Staff (admin, owner, ops_manager, estimator) read it under their own sign-in, the same rule as the staff-only scope tool defaults. Trades and customers read nothing. |
| `commission_rate_settings` | One row, `editor_user_ids` (`public.users.id`). Ships empty. |
| `set_commission_rate(trade, percent, reason, actor)` | The one writer, service role only. Refuses anyone not in `editor_user_ids` (`commission_rate_editor_only`). Keeps the trade's rule id. |

The scoping tool reads `v_commission_rates` at seal. That replaces the old staff-only
`commission-pct` row in `scope_tool_defaults`, which is no longer the rate.
A sealed revision keeps what it sealed, including an older typed rate.

Go-live (the owner's word): write the owner's `users.id` into
`commission_rate_settings.editor_user_ids`. Until then nobody can change a rate
and the two seeded rates stand.

### The record

`job_commissions`: one row per stored budget, written by a trigger on
`job_budgets` the moment the budget is stored at acceptance. Budgets stored
before the migration are backfilled. Write-once. Columns: job, budget, version,
trade, the sealed salesperson id, the salesperson (`public.users.id`, only when
that id is a person of the job's company), the state, rule, percent, gross
profit and the expected amount.

| State | Meaning | Who may claim |
| --- | --- | --- |
| `named` | A person of the company and an amount (0 on a loss). | That person, up to the amount. |
| `no_amount` | A person, but the budget has no commission figure. | Nobody (`commission_amount_unknown`). |
| `salesperson_not_found` | The sealed id is not a person of the job's company. | Nobody. |
| `no_salesperson` | The budget names nobody. | Nobody. |

The job's current record is its newest version (`v_job_commission`, service
only, with `claimed_ex_gst` and `remaining_ex_gst`).

### The cap

On a job with a record, a commission line is accepted only on the named
salesperson's invoice, and only while the job's counted commission stays
within the expected amount. A job with no record keeps the rules from before step 2.

- What counts: commission lines on the job, on an invoice that is neither a
  draft nor `ops-reject`, that the office has not rejected, plus the invoice
  being written.
- A draft does not hold the amount: it is checked when it stops being a draft.
- Triggers on `trade_invoice_lines` (insert, or a change to type, amount, job,
  invoice or office review) and on `trade_invoices` (status or owner) hold every
  write path. The record row is locked, so two invoices on one job are checked
  one after the other.
- `generate_trade_invoice` runs the same rule before it writes anything and
  answers 409 with `commission_not_salesperson`, `commission_amount_unknown` or
  `commission_over_amount`. If a write loses a race, the database refuses it
  under the same code. A failed read of the records is a 503 (`commission_unreadable`), never a pass.
- On a job with a record the creator, manager and invoice-any-job rules no
  longer open commission. Only the named salesperson may claim it
  (`commission_named_salesperson`). `my_hours`' `can_claim_commission` says the same.
- Refusals carry codes and job numbers, never money.

Not capped: a line a lead overrides in the crew review (`override_amount`), and
a commission line that names a job number with no job id. The database cap
needs the job id; the invoice route checks resolved jobs.

### Doors and the AI command

| Action | Who | What |
| --- | --- | --- |
| `commission_rates` (GET) | staff or server key | The current rate per trade. |
| `set_commission_rate` (POST) | the signed-in editor only; the server key is refused | `{trade, percent, reason}`; the writer gets the session's own id. |
| `job_commission` (GET) | staff or server key, inside the caller's company | One job's record, the salesperson's name, what counts and what is left. The AI command. |

Tests: `ops-api/job_commission_test.ts`,
`ops-api/trade_invoice_extra_job_authority_test.ts` (the cap through the
invoice route), `ops-api/trade_invoice_mode_test.ts`, and the migration
contract `supabase/tests/migration-contracts/20261113230000_job_commissions/`.

Rollout: apply `20261113230000_job_commissions.sql` after `20261113190000`
and before or with the matching `ops-api`. Until it is applied the reads find
no records and the rules from before step 2 run. The rollback
(`supabase/rollbacks/20261113230000_job_commissions_down.sql`) takes away the
cap, the trigger, the writer and the reads and keeps every row.

## Dispatch lines carry cost (step 3)

Ruling 17 step 3: a Dispatch material line takes its unit cost and line cost
from the job budget, and an order line over its budget line, or a line not in
the budget, goes out only with a named person's reason recorded. Never
silently $0, never silently over. Migration
`20261114020000_dispatch_line_budget_cost.sql`; the rule is one module,
`ops-api/dispatch_v2_budget_cost.ts`; the store is `ops-api/dispatch_v2_store.ts`.

Switch: `feature_flags.dispatch_budget_cost_v1`, seeded off. Off or missing:
Dispatch fills, makes and sends exactly as before. Unreadable (the flag read
fails): the fill, the email, the send and a reason refuse with 503
`budget_switch_unreadable` and change nothing (try again), and the read answers
`budget: {state: 'switch_unreadable'}`; an unreadable switch is never read as
off, so an uncosted order cannot reach Send. On, for a job with a stored budget
(the newest `job_budgets` version):

| Step | What happens |
| --- | --- |
| Fill (`dispatch_v2_suggest_draft`) | Lines come from the sealed order list (ruling 17b-1, below), never from the budget's words: each `order` row is one line, in its order, and takes only its unit and line cost from the budget line whose `key` is the row's `id` (`job_material_lines.budget_id` + `budget_line_key`). The budget must be for the job's current frozen revision, else `budget_not_current_revision`. A line's detail prints what the supplier copy prints, from the row only: `Code: <supplier_code>`, `Length: <stock_length_mm>` (or `Stock length: supplier to confirm` when `stock_to_confirm`), `Cuts: <qty> x <length_mm>, ...` (else the row's `cut` words), `Variant`, `Finish`, `Gauge`, `Girth`, then its `note_to_supplier`; `profile` and `colour` fill the line's own fields. A zero or missing measure prints nothing. A note over 300 characters holds `supplier_note_too_long`; a detail over 300, or a profile or colour over 80, holds `order_detail_too_long` (never cut short). Delivery and cutting rows the supplier copy prints are lines like any other. A quote option's rows are filled only when the customer took that option. Standing lines are unchanged. |
| Read (`dispatch_materials`) | Each line carries `cost` (basis, unit cost, line cost, needs a reason or not); the reply carries `budget` (state, version, totals by supplier, how many open lines need a reason). A budget read fault answers `budget: {state: 'unreadable'}`, never "no budget". |
| Make the email | Every orderable line must be costed or carry a covering reason, else 409 `line_cost_needs_reason` naming the lines. The email row stores `order_cost` (`dispatch-order-cost.v1`: each line's basis and cost, the total, the supplier's budget). |
| Send | Refuses `order_cost_missing` if the email was made without its cost, `budget_changed` if a newer budget was stored since, and `line_cost_needs_reason` if a line moved. |
| Reason (`dispatch_v2_line_cost_reason`) | `job_id`, `line_id`, `reason` (3 to 500 characters), `expected_updated_at`, and `unit_cost_ex_gst` only where the budget has none. Signed-in staff only: the ops key is refused `named_person_required`, so every reason names who. |

The sealed order list (ruling 17b-1): at seal the quote tool saves `order`
(`order.v1`) inside the sealed revision's hashed pricing bytes, beside
`budget`: one row per row the supplier copies print, from the one function
behind the supplier copy, the draft order cards and the budget. A row is `id`
(the budget materials line's `key`), `scope_line_id`, `option_id` (null, or the
quote option it belongs to), `kind` (`item`, `delivery`, `cutting`),
`supplier` (`{id, name}` or null), `supplier_code`, `description`, `quantity`,
`unit`, `stock_length_mm`, `stock_to_confirm`, `cuts`, `cut`, `profile`,
`colour`, `variant`, `finish`, `gauge_mm`, `girth_mm`, `note_to_supplier` and
`cost_by` (`line`, `one_figure`, `allowance`). No dollars. Dispatch reads it
from `scope_revisions.pricing_canonical_text` and re-hashes it: the hash must
equal the revision's `pricing_hash` and the stored budget's, else 409
`order_unreadable` (reason `order_pricing_hash_mismatch`; an unknown version or
a bad row is `order_version_unknown` / `order_row_unreadable`). A revision
sealed before order.v1 has no `order`: Dispatch keeps today's path (no budget
costing) and the read answers `budget: {state: 'no_order'}`; nobody rebuilds an
order from a live scope. The fill is held whole, 409 `order_held` with one
reason code per row or budget line, and the read shows `budget.order.state:
'held'`, when: a `cost_by: line` row has no budget line
(`order_row_no_budget_line`), its line has no cost (`order_row_no_cost`), or
the row and its line count it in different units (`order_row_unit_mismatch`;
one unit on both, no conversion between units) or different quantities
(`order_row_quantity_mismatch`), so an unchanged sealed order never asks a
person for a reason; a
budget item line is on no row (`budget_line_no_order_row`; the one-figure
aggregate and the fixings allowance are exempt); two budget lines share a key
(`budget_key_duplicated`) or two rows an id (`order_row_duplicated`); a
`one_figure` or `allowance` row has nothing to cover it
(`order_row_no_one_figure`, `order_row_no_allowance`). A `one_figure` or
`allowance` row is not held: it is ordered with no dollars of its own (basis
`one_figure` or `allowance`), and the order's total says what covers it. A
delivery on no supplier copy stays a budget line only. `withoutBudget` strips
`order` with `budget`, and both Trade App boundaries (`redactTradeScopeQuote`
and the every-tier `stripTradePrivateCarriers`) drop an order list wherever the
scope carries it, a fence revision pack included, as an object or as JSON text
(`tradeSealedOrderList`: an `order` whose `version` reads `order.<n>` or that
has `rows`); a number or plain words under `order` stay. So it is shown nowhere
new.

How a line is costed:

| Basis | When | Needs |
| --- | --- | --- |
| `budget` | Linked, same unit, at or under the budget quantity | Nothing. At the budget quantity, line cost = the budget line's sealed cost exactly. Under it, that cost shared by quantity (sealed cost / sealed quantity, unrounded) and rounded once, whole cents half up. The shown unit cost (to the cent) is never multiplied back up, and the budget is never changed. |
| `one_figure` | A one-figure budget's line at or under quantity | Nothing. No per-line dollars: the job has one materials figure. |
| `allowance` | A fixings row covered by the fixings allowance | Nothing. No per-line dollars: the allowance covers it. |
| `over_budget` | Over the budget quantity | A reason for that quantity and unit. The sealed cost shared by quantity still applies, unless the person gives a unit cost (a one-figure line also needs a unit cost). |
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

## Labour: pay mode and the hourly cap (step 4)

Ruling 17 sections 4 and 5. The budget's `labour.pay` says how the crew is
paid: `group_work_order` (the default: one agreed amount) or `hourly_capped`
(a rate and maximum hours, `labour.hourly`). Everything below runs only while
`feature_flags.job_labour_budget_v1` is on (seeded off; a missing row is off,
and a switch that cannot be read is never off: the cap refuses 503 and the
work order fill holds). While it is off, invoicing, the cap and the work
order fill are exactly as before.

- **What the budget must say.** On `hourly_capped`, `hourly.max_ex_gst` is
  `rate_ex_gst x max_hours` to the cent and the tool's own labour lines add
  up to it. A crew option the customer took (the options formula's labour
  line, key `option:<id>`, on the taken list) is labour on top:
  `labour.amount_ex_gst` and the work order amount are the maximum plus those
  options, and the rate and hours are never changed for them (70 x 40 = 2800
  plus a 250 crew option stores 3050). On `group_work_order`, `hourly` is
  null. Otherwise `checkBudget` refuses `labour_hourly_invalid` or
  `labour_hourly_mismatch` and nothing is stored.
- **The work order.** The job work order's `agreed_labour_ex` is the budget's
  `labour.work_order_amount_ex_gst` (taken crew options and every counted
  line in another lane paid to the crew, such as a removal, already in it), read
  from the newest stored budget when it is for the same accepted revision the
  fill reads (`job_work_order_quote_fill.ts`). A budget for another revision
  leaves the quote's figure. An unreadable budget, or one with no amount,
  holds the draft for the approver (`job_budget_unreadable`,
  `job_budget_labour_missing`); one with no amount leaves `agreed_labour_ex`
  empty for the office, never the quote's estimate (P1-05.5). Group mode keeps today's rule: billing equals
  the agreed amount.
- **How the trade invoices.** A job whose newest budget is `hourly_capped` is
  invoiced by the hour (`invoice_mode` `hourly`, reason `hourly_capped`),
  after a live group work order only (`trade_invoice_mode.ts`). An unreadable
  budget fails the mode read; it never reads as "no cap".
- **The cap (ruling 17c).** A job has one labour cap check, the live work
  order cap's: `_assertWithinWorkOrderTotal` (`work_order_total_cap.ts`) at
  `generate_trade_invoice`, `submit_work_order_invoice` and a lead's
  `review_crew_charge` adjust, before anything is written. There is no
  second refusal path: no database guard and no second code. On a
  work-order job the limit stays its agreed labour plus approved customer
  variations (the fill above puts the budget's labour into
  `agreed_labour_ex`). On an `hourly_capped` job the limit is
  `job_labour_cap_state(job)`'s `cap_ex_gst`: what the work order promises
  the crew (ruling 18 B), the budget's `labour.work_order_amount_ex_gst`
  (`work_order_ex_gst`: the sealed `max_hours` times the sealed
  `rate_ex_gst`, plus any crew option the customer took,
  `crew_options_ex_gst`, plus every counted line in another lane paid to the
  crew, `crew_lines_ex_gst`, a removal for one) plus the approver's raises on
  that budget. So the printed work order, Cost review, the fill and the cap
  agree to the cent: 70 x 40 plus a 250 crew removal caps at 3050. The count is the work order cap's for both: every line on a
  billed invoice except commission (deductions come off), plus this
  invoice's. The cap is in dollars: a trade's own rate on a job above the
  sealed rate never raises it; the job stops at the maximum until the
  approver raises it.
- **The refusal.** Over: 409 `work_order_total_over_agreed`, nothing saved.
  On an hourly job the job entry carries `limit: "hourly_maximum"` and
  `hourly_maximum_ex` (that whole limit), and the message names the most the
  work order pays the crew and the most this invoice may still bill (never
  another trade's figure). A maximum that
  cannot be read is `capped_unreadable` with a zero limit and the budget
  check's code in `unreadable_reason`: `labour_hourly_invalid` (no `hourly`,
  `{}`, any property missing or not a number, a rate or hours not above zero,
  a figure past the cent) or `labour_hourly_mismatch` (the maximum is not
  rate x hours to the cent, or the labour amount is below the maximum; a
  budget stored by an older writer is read by today's rules, and neither of
  two figures that disagree is picked), `work_order_amount_unknown` (no work
  order amount, or a line paid to the crew whose cost is unknown) or
  `work_order_amount_mismatch` (the work order is not the labour plus the
  crew's lines in other lanes, to the cent). That, or any failed read (returned
  as an error or thrown), is 503 `work_order_cap_unavailable`, never let
  through. The work order
  cap's known limits (two invoices at the same moment can both pass; the
  remainder lets a trade work out what others billed) apply unchanged.
- **Raising it.** `POST ops-api?action=raise_job_labour_cap`
  `{ job_id, budget_id, amount_ex_gst, reason }`, signed in only.
  `raise_job_labour_cap` checks the caller with `owner_approval_authority`
  (the work order approver list; not changed here), the job's company, that
  `budget_id` is still the job's newest budget and that it pays hourly, then
  records who, when, why and how much in `job_labour_cap_raises`
  (append-only). A new budget version starts again from its own maximum.
  Refusals: `not_approver`, `wrong_company`, `job_not_found`, `no_budget`,
  `budget_changed`, `not_hourly`, `amount_invalid`, `reason_invalid`.
- **Reading it.** `GET ops-api?action=job_labour_cap&job_id=` (staff in the
  job's company): `state` (`no_budget`, `not_capped`, `capped`,
  `capped_unreadable`, with `unreadable_reason`), `rate_ex_gst`, `max_hours`, `max_ex_gst`,
  `crew_options_ex_gst`, `crew_lines_ex_gst`, `work_order_ex_gst`,
  `raised_ex_gst`, `cap_ex_gst`, and on a capped job
  `billed_ex_gst` and `remaining_ex_gst` by the guard's own count. The office
  work order list (`list_work_orders` `kind=job`) shows an hourly job's row
  with that limit (`cap.limit: "hourly_maximum"`). Never shown to a trade
  beyond the refusal.

Fence removal paid to the crew (17a T3) is settled by ruling 18 A7: it is
whatever the scoper sets on the removal line. A removal line paid to the crew
is in the work order amount, so it is in the fill and the cap.

## Tests

- `_shared/job_budget/budget_v1_test.ts`: the formula, the tool's shared
  examples and A to D (with `taken_option_ids`), every add-up code, gaps,
  supplier delivery lines, the exact native one-figure patio and allowance
  entry, the native sealed budgets of both trades
  (`fixtures/native-budgets.json`), money to two decimals, the strip.
- `_shared/job_budget/record_job_budget_test.ts`: the acceptance writer.
- `ops-api/job_budget_strip_test.ts`: every read in the table above.
- `ops-api/job_labour_cap_test.ts`, the `hourly:` cases in
  `ops-api/work_order_total_cap_test.ts`, the `R17 step 4` cases in
  `ops-api/job_work_order_quote_fill_test.ts`: step 4's mode, limit read,
  doors, the one guard and the fill.
- `supabase/tests/migration-contracts/20261114030000_job_labour_cap/`: the
  limit (crew options, every unreadable shape), raises, append-only, no
  database guard on trade invoices; break and rollback proofs.
- `supabase/tests/migration-contracts/20261113190000_job_budgets/`: privileges,
  the writer, replay, conflict, revision and decimal refusals, write-once, the
  view and the refused state; break and rollback proofs.

## Rollout

Apply `20261113190000_job_budgets.sql` before or with the matching
`send-quote` deploy (the writer skips with `store_missing` until it is
applied). The rollback (`supabase/rollbacks/20261113190000_job_budgets_down.sql`)
drops the writer, the view and the guard and keeps every stored budget.

Step 4: apply `20261114030000_job_labour_cap.sql` before the matching
`ops-api` (its two doors and the cap guard call its functions). It changes
nothing until `job_labour_budget_v1` is turned on. Its rollback refuses once any raise is
recorded; switch the flag off instead.

## Step 5: Job Profit's first expected source

Migration `20261114040000_job_profit_expected_from_budget.sql` (rollback in
`supabase/rollbacks/`). With `feature_flags.job_profit_expected_from_job_budget`
on (seeded off), `v_job_profit` reads a job's newest budget version first:

| `v_job_profit` | From the budget |
|---|---|
| `expected_source` | `job_budget` |
| `expected_labour_ex` | `work_order_ex_gst` (labour plus the other lines paid to the crew, what the crew bills) |
| `expected_materials_ex` | `materials_ex_gst` |
| `expected_commission_ex` | `commission_ex_gst` |
| `expected_other_ex` (new) | cost before commission less materials less the work order amount |
| `expected_cost_ex` | the four lanes above added up |
| `budget_gross_profit_ex` (new) | `gross_profit_ex_gst`, the figure commission is worked from |
| `expected_budget_id` (new) | the budget row read |

A budget lane that is not known names `expected_cost_lane_missing`, as for
every other source; it is never read as 0 or taken from an older source. A job
with no budget, and every job while the switch is off, reads exactly as before.
`commission_summary` and the patio expected read treat `job_budget` as an
accepted baseline. Nothing works commission or margin from an assumed 35%.
Proof: `supabase/tests/migration-contracts/20261114040000_job_profit_expected_from_budget/`.
Rollout: apply the migration, then turn the switch on.
