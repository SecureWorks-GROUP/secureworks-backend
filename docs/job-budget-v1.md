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

## Labour: pay mode and the hourly cap (step 4)

Ruling 17 sections 4 and 5. The budget's `labour.pay` says how the crew is
paid: `group_work_order` (the default: one agreed amount) or `hourly_capped`
(a rate and maximum hours, `labour.hourly`). Everything below runs only while
`feature_flags.job_labour_budget_v1` is on (seeded off; missing or unreadable
is off). While it is off, invoicing and the work order fill are exactly as
before.

- **What the budget must say.** On `hourly_capped`, `hourly.max_ex_gst` is
  `rate_ex_gst x max_hours` to the cent and equals `labour.amount_ex_gst` (the
  labour lines add up to the maximum). On `group_work_order`, `hourly` is
  null. Otherwise `checkBudget` refuses `labour_hourly_invalid` or
  `labour_hourly_mismatch` and nothing is stored.
- **The work order.** The job work order's `agreed_labour_ex` is the budget's
  `labour.work_order_amount_ex_gst` (taken crew options already in it), read
  from the newest stored budget when it is for the same accepted revision the
  fill reads (`job_work_order_quote_fill.ts`). A budget for another revision
  leaves the quote's figure. An unreadable budget, or one with no amount,
  holds the draft for the approver (`job_budget_unreadable`,
  `job_budget_labour_missing`). Group mode keeps today's rule: billing equals
  the agreed amount.
- **How the trade invoices.** A job whose newest budget is `hourly_capped` is
  invoiced by the hour (`invoice_mode` `hourly`, reason `hourly_capped`),
  after a live group work order only (`trade_invoice_mode.ts`). An unreadable
  budget fails the mode read; it never reads as "no cap".
- **The cap.** `job_labour_cap_state(job)` is the one read: the maximum plus
  the approver's raises on that budget, against every labour-lane charge
  resolved to the job (`v_trade_charge_resolved`) on a billed invoice. A
  deferred guard on `trade_invoice_lines` and `trade_invoices` refuses, at
  commit, an invoice whose labour on a capped job would take that job past
  its cap (`job_labour_cap_exceeded`). The trade's own draft counts; other
  trades' drafts do not. A per-job lock makes two invoices take turns. A line
  only lowered, and a billed invoice moving on (approved, pushed, paid), are
  never refused. A maximum the database cannot read caps the job at nothing.
  The cap is in dollars, not hours: hours times each trade's own rate is what
  is charged to the job.
- **The refusal.** Any door answers 409 `job_labour_cap_exceeded` with no
  figure (the maximum is the office's): "Ask the office to raise it".
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
  `capped_unreadable`), `rate_ex_gst`, `max_hours`, `max_ex_gst`,
  `raised_ex_gst`, `cap_ex_gst`, `billed_ex_gst`, `remaining_ex_gst`. Never
  shown to a trade.

Open for the director: whether the crew is paid for fence removal (17a T3)
is the tool's labour lines; this step caps whatever labour the budget names.

## Tests

- `_shared/job_budget/budget_v1_test.ts`: the formula, the tool's shared
  examples and A to D (with `taken_option_ids`), every add-up code, gaps,
  supplier delivery lines, the exact native one-figure patio and allowance
  entry, the native sealed budgets of both trades
  (`fixtures/native-budgets.json`), money to two decimals, the strip.
- `_shared/job_budget/record_job_budget_test.ts`: the acceptance writer.
- `ops-api/job_budget_strip_test.ts`: every read in the table above.
- `ops-api/job_labour_cap_test.ts`, the `R17 step 4` cases in
  `ops-api/job_work_order_quote_fill_test.ts`: step 4's mode, doors, refusal
  and fill.
- `supabase/tests/migration-contracts/20261114030000_job_labour_cap/`: the
  cap, raises, the guard (refused, raised, lowered, moving on, a replaced
  draft, switch off), append-only; break and rollback proofs.
- `supabase/tests/migration-contracts/20261113190000_job_budgets/`: privileges,
  the writer, replay, conflict, revision and decimal refusals, write-once, the
  view and the refused state; break and rollback proofs.

## Rollout

Apply `20261113190000_job_budgets.sql` before or with the matching
`send-quote` deploy (the writer skips with `store_missing` until it is
applied). The rollback (`supabase/rollbacks/20261113190000_job_budgets_down.sql`)
drops the writer, the view and the guard and keeps every stored budget.

Step 4: apply `20261114030000_job_labour_cap.sql` before the matching
`ops-api` (its two doors call its functions). It changes nothing until
`job_labour_budget_v1` is turned on. Its rollback refuses once any raise is
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
