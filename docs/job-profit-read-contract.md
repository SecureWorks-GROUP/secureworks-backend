# Job profit read contract

What the finance tab reads from `ops-api?action=job_profit` and
`ops-api?action=job_profit_list`. Engine: migration
`20261009130000_job_profit_engine.sql` (`v_job_profit`, `v_job_cost_events`,
`v_job_revenue_events`). Code: `supabase/functions/ops-api/job_profit.ts`,
`job_profit_rollup.ts`. Every response also carries these meanings under
`labels`.

Access: a server key or an admin/owner session. Everyone else gets 403.

All money is ex GST. Profit is gross profit on direct costs, no overhead.

## Actions

| Action | Returns |
|---|---|
| `job_profit&job_id=<uuid>` or `&job_number=<number>` | `job` (one row of the fields below), `trades`, `cost_events`, `revenue_events`, `timeline`, `labels` |
| `job_profit_list` (`type`, `status`, `from`, `to`, `date_field=created\|invoiced`, `limit`, `offset`) | `jobs` (rows of the fields below), `has_more`, `labels` |
| `job_profit_list&view=rollup` (same filters) | `totals`, `by_type`, `by_month`, `labels` |

`job_profit_list` returns no row count. `has_more` is true when another page
follows: ask again with `offset` raised by `limit`. An offset past the last job
answers an empty `jobs` with `has_more` false, never an error. Totals come from
`view=rollup`.

The `type` filter matches `work_type`, not `jobs.type`: a job whose family is
repair is listed as `repair` whatever its type. `work_subtype` is the family.
Legacy jobs have no row.

## Job fields

| Field | Meaning | Null means |
|---|---|---|
| `quoted_ex` | Value of a sent or accepted quote | No quote was sent. Never the live price |
| `quoted_source` | Which quote: `sent_quote:...` | No quote was sent |
| `expected_cost_ex`, `expected_labour_ex`, `expected_materials_ex`, `expected_commission_ex` | Cost fixed at the quote | No cost was fixed at a quote, including a quote sent with no cost figures. Never 0 for that, never a live estimate |
| `expected_source` | `frozen_at_acceptance`, `accepted_quote_revision` or `sent_quote_revision` | No cost was fixed at a quote |
| `actual_cost_ex`, `actual_labour_ex`, `actual_materials_ex`, `actual_commission_ex`, `actual_other_ex` | Costs linked to the job line by line: trade charges, supplier bills, materials facts | Never null |
| `cost_basis`, `line_level_cost_ex` | Always `line_level`; the same figure as `actual_cost_ex` | Never null |
| `xero_project_expenses_ex` | Expenses on record against the job's Xero Project. Evidence only, not the job's full cost. Trade labour may sit outside it | No project is named after the job |
| `invoiced_ex`, `collected_ex`, `draft_revenue_ex`, `variations_listed_ex` | Sales invoiced, paid, in draft, and agreed variations | Never null |
| `profit_ex`, `margin_pct` | Invoiced minus actual cost, and that as a share of invoiced | Unknown. `cost_flag` and `completeness` name why |
| `profit_ex_unsuppressed` | Invoiced minus the costs linked so far. Not a profit figure | The Xero Project total exceeds the linked costs |
| `revenue_verified_paid`, `costs_verified_paid` | Xero recorded the payment. Not a bank reconciliation | Never null |
| `committed_open_ex` | Priced open purchase orders with no supplier invoice emailed and no bill placed. Committed, not actual: never in `actual_cost_ex`. An order with no price is never here as $0.00 | Never null |
| `ordered_not_billed_count`, `ordered_not_billed_over_30_count` | Ordered, not billed: sent orders with no price (every Dispatch order) and no invoice or bill yet, and those first sent 30 or more Perth days ago. Counts, never dollars. Show "ordered, not billed: N" | Never null (0). Absent before migration 20261019120000 |
| `invoice_emailed_count`, `invoice_emailed_ex` | Invoice emailed, no bill matched to this order: the supplier emailed an invoice for the order and no bill is linked to the order yet (the bill may be on the job without that link). Never show as nothing owed. `invoice_emailed_ex` is the priced ones' amount, in neither `committed_open_ex` nor actual cost | Count never null (0); amount null when none is priced. Absent before migration 20261019120000 |
| `cost_flag`, `revenue_flag`, `completeness` | The first reason, and every reason, a figure is missing or weak. Values below | Never null |

There is no live price or live estimate field. Show "no quote sent" when
`quoted_ex` is null.

## Flag values

`revenue_flag` is `ok` or `missing_client_invoice`. `cost_flag` is `ok` or the
first of the cost reasons below, in this order. `completeness` lists every
reason and note that applies.

| Value | Meaning | Profit and margin |
|---|---|---|
| `missing_client_invoice` | Nothing invoiced yet | Null |
| `xero_project_exceeds_line_costs` | See the Xero Project rule | Null |
| `installer_bill_unconfirmed` | An installer bill (account 306 or 301) is on the job but no person has confirmed it. See the installer bill rule | Null |
| `no_cost_linked` | No cost is linked to the job | Null |
| `incomplete_invoice_lines` | A trade invoice on the job has no lines, or lines that do not add up to its total | Null |
| `unclassified_lines` | A trade line has no cost lane | Null |
| `materials_not_linked` | Materials are owed (a fencing, patio, decking or combo job, or one whose expected cost or pricing carries materials) and none is linked | Null |
| `no_labour_linked` | No labour cost is linked | Null |
| `text_matched_lines` | A trade line was matched to the job by text, not by job id | Shown |
| `xero_project_linked_by_contact_only` | The job's Xero Project is linked by contact, not by name, so it gives no project figure | Shown |
| `unapproved_trade_charges` | A trade charge is on an invoice not yet approved | Shown |
| `open_purchase_orders` | `committed_open_ex` is above zero | Shown |
| `ordered_not_billed` | A sent order with no price has no invoice or bill yet | Shown |
| `ordered_not_billed_over_30_days` | Such an order was first sent 30 or more days ago | Shown |
| `invoice_emailed_bill_not_placed` | A supplier emailed an invoice for an order, and no bill is linked to that order (it may be on the job unlinked) | Shown |
| `draft_revenue` | `draft_revenue_ex` is above zero | Shown |
| `holding_job` | A holding job, not a customer's job | Shown |

The last eight appear in `completeness` only.

## Xero Project rule

The Xero Project total is never returned as actual cost and is in no company,
work-type or month total of cost or profit. When it is larger than the costs
linked to the job, the job is flagged `xero_project_exceeds_line_costs` and
`profit_ex`, `margin_pct` and `profit_ex_unsuppressed` are null. Show the
project total beside the job as "project expenses on record", never as the
job's cost.

## Installer bill rule

A person confirms each installer bill before it is placed on a job (JP-12).
An installer bill has a line on account 306 or 301. It counts as actual
labour only once a person placed it on the job through Bills to place (a
whole placement or a split). Until then its rows in `cost_events` have source
`installer_bill_unconfirmed`, confidence `awaiting_confirmation` and
`is_actual` false: the amount is shown, it is not in `actual_cost_ex`, and the
job is flagged `installer_bill_unconfirmed` with no profit or margin. This
holds even when Xero's reference links the bill to the job. A bill a person
marked not job related has source `installer_bill_not_job_related`, is never
actual and flags nothing. In `v_bill_allocation_balance` such a bill whose
rows no person made has `installer_unconfirmed` true and is never `balanced`.

## Rollup fields

Each of `totals`, `by_type[]`, `by_month[]` and `holding_jobs` carries:

| Field | Meaning |
|---|---|
| `jobs` | Jobs in the group |
| `invoiced_ex`, `collected_ex`, `actual_cost_ex` | Summed over every job in the group |
| `quoted_ex`, `jobs_with_quote`, `invoiced_on_quoted_ex` | Sent-quote value, how many jobs have one, and what those same jobs invoiced |
| `expected_cost_ex`, `jobs_with_expected`, `actual_cost_on_expected_ex` | Quote-fixed expected cost, how many jobs have one, and what those same jobs cost: only jobs whose actual cost is complete (`cost_flag` `ok` or `text_matched_lines`) |
| `jobs_with_expected_not_comparable`, `expected_cost_not_comparable_ex` | Jobs with an expected cost whose actual cost is still partial (no cost linked, materials not linked, labour missing, unclassified or incomplete lines, a Xero Project above its lines), and their expected cost. Not compared |
| `jobs_with_margin` | How many jobs in the group the engine published a profit for; 0 when none |
| `profit_ex`, `margin_pct`, `published_revenue_ex`, `published_cost_ex` | Only jobs whose profit the engine published. Null (Unknown) when `jobs_with_margin` is 0, never 0 |
| `revenue_verified_paid_jobs` | Jobs whose sales invoices are all paid in Xero |

Compare expected with actual through `actual_cost_on_expected_ex`, and quoted
with invoiced through `invoiced_on_quoted_ex`, so both sides cover the same
jobs. `by_month` groups jobs by the `date_field` that filtered them; it is a
job cohort, not an accounting period.

A holding job (`holding_job`, such as SWF-PDF-BUCKET, where unplaced costs are
parked) is not a customer's job. It is in no `totals`, `by_type` or `by_month`
figure; `holding_jobs` reports it on its own so the parked cost stays visible.

## Where a bill's cost counts (H7)

`cfo_bill_cost_outcomes` (`20261029170000`, contract
`cfo-bill-cost-outcome-v1`, service role only) has one row per supplier bill
(Xero ACCPAY, trade-app mirrors left out) and job it is Xero-linked to, has an
actual allocation row on, or is counted on. `counts` is read from the engine,
never re-derived: `counted` only when `v_job_cost_events` has an actual row of
the bill on that job and `v_job_profit` reads the job; `not_counted` with a
`reason` (read through allocation rows, overhead, an unconfirmed or
not-job-related installer bill, a labour part not yet confirmed, voided, not
approved, a legacy job, an expected row on another job hiding the Xero link);
`unknown` when it cannot be read, never 0. A bill marked not job related that
the engine still counts reads `bill_state` `held` (F1, JP-21). A bill counted
for more than its ex GST total (counted parts plus any overhead part: 1200
counted on a 1000 bill, two 700 placements on one) reads `over_counted`, never
`counted_in_part`; less reads `counted_in_part`, equal `counted_in_full`, all
using `v_bill_allocation_balance`'s comparison (the remainder within half a
cent) over the parts the engine counts, not every allocation row. So they agree
with that view only where every allocation row is counted at its own amount: a
whole row on the bill's own Xero job with a different amount, or a split with a
legacy part plus overhead, can read `counted_in_full` or `counted_in_part` here
while the view reads the bill over-allocated. A trade-app mirror bill is left out unless a person placed it on a
job: that row reads `not_counted`, reason `mirror_bill_person_placed`,
`bill_state` `trade_mirror`, because its cost counts through the trade lines.
The `evidence_hash` is led by the contract version; a payment does not move it
(AUTHORISED and PAID are one class), a changed total, line, tax-inclusive flag
(`LineAmountTypes`, which the engine reads), credit, status class, allocation
row or overhead does. A DRAFT bill linked to a job reads `not_counted`,
`bill_not_approved`, as the engine treats it. Context's job card reads it through
`context_job_bill_outcomes(job)` (`20261029170100`), which carries no amount.
The rule is one function, `cfo_bill_cost_outcomes_scoped(job)`: the view is
its call with null, and a job's call first finds that job's bills (its Xero
links and actual allocation rows) and judges only those (and every other job
they touch), giving exactly the view's rows for those bills (the contract
compares both ways for every fixture job). A job with no bill skips the engine
read. The engine's own shared parts still read every bill once per call (the
floor until the engine can be filtered), so the job read runs with
`jit = off`: JIT compiling that plan costs seconds and saves nothing.
ops-api `job_overview` serves that as `bills` and refuses any other contract
version or any amount (`job_bill_outcomes_read.ts`); a mirror bill reads
`where_counted` `trade_app` there, both on a job a person placed it on and on
its Xero-linked job where CFO's view lists no row (there `here` is
`not_counted`, reason `mirror_bill_not_placed_here`; a voided mirror there
has reason `bill_voided` and reads `no_job`, never a count; one whose state CFO
cannot read keeps `here` null and reads `unknown`), and each bill carries
CFO's `mirror_bill` flag as given. The one-job timing read for the 8 s API limit is
`scripts/explain-context-job-bill-outcomes-one-job.sql` (read only). INT-10's
five-job acceptance, `scripts/int10-five-job-bill-outcomes-acceptance.sql` (read
only, after both migrations apply), takes five jobs by a fixed shuffle of job
ids and compares, both ways, the bills each card should list (placed on the
job, or counted on it by the engine) with the bills it does list: a bill left
out is `missing_from_card`, one listed that should not be is `extra_on_card`,
every picked job always shows, and the one deliberate exclusion (a trade-app
mirror no person placed on any job, which CFO's view lists nowhere) is its own
step and is named on its row. Each row sets the engine rows beside the card's
read for a person to check against Xero. `scripts/test-int10-acceptance-proof.sh`
proves it on a disposable local database: the card as served has no failure,
and a card that drops a bill, carries an extra one, lists nothing for a job or
shows the excluded mirror is flagged by name. Both scripts treat a job as a
holding job by the engine's own rule (`v_job_profit.holding_job`,
`lower(do_not_schedule) = 'true'`), the rule CFO's view and the card read use
too; Context's placement rules read `'true'` or `'1'`, and on a job set to
`'1'` the two disagree (not measured on production).
