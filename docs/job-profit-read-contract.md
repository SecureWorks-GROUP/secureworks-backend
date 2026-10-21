# Job profit read contract

What the finance tab reads from `ops-api?action=job_profit` and
`ops-api?action=job_profit_list`. Engine: migration
`20261009130000_job_profit_engine.sql` (`v_job_profit`, `v_job_cost_events`,
`v_job_revenue_events`). Code: `supabase/functions/ops-api/job_profit.ts`,
`job_profit_rollup.ts`. Every response also carries these meanings under
`labels`.

Access for `job_profit` and `job_profit_list`: a server key or an admin/owner
session. Everyone else gets 403. These actions never link a supplier bill.

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
| `quoted_ex` | Sent or accepted quote. While `job_profit_patio_quote_v1` is on, the one frozen patio tool quote when it is the only candidate and it agrees with the live price and with what has been invoiced. A conflict is blank and flagged | No quote, or the patio figure conflicts or cannot be read. Never the live price |
| `quoted_source` | `sent_quote:...`, or `patio_quote:sole_frozen_revision` when that frozen quote is the one published | No figure was published |
| `expected_cost_ex`, `expected_labour_ex`, `expected_materials_ex`, `expected_commission_ex` | Quote-fixed cost. While `job_profit_work_order_labour_v1` is on, labour is an approved job work order's agreed labour (`approved_at` is not null), plus approved customer variations, when that figure is present. A draft work order is ignored | No quote cost and no approved agreed labour. A stored 0 on an approved work order is a real figure. Never a live estimate |
| `expected_source` | `job_work_order`, `frozen_at_acceptance`, `accepted_quote_revision` or `sent_quote_revision` | No expected cost |
| `expected_labour_quote_ex` | The quote's labour, even when `expected_labour_ex` is the approved work order | No quote labour |
| `work_order_agreed_labour_ex` | Approved job work order agreed labour, plus approved customer variations. A draft is not included. Evidence even while the labour switch is off. A stored 0 is a real figure | No approved agreed figure |
| `actual_cost_ex`, `actual_labour_ex`, `actual_materials_ex`, `actual_commission_ex`, `actual_other_ex` | Costs linked to the job line by line. Stays line-level when a margin is published from the Xero Project | Never null |
| `cost_basis`, `line_level_cost_ex` | Always `line_level`; the same figure as `actual_cost_ex` | Never null |
| `margin_source` | Exactly `from Xero Project, may exclude unlinked labour` when that switch published the margin from the project | No margin published |
| `margin_cost_ex` | The cost the published margin subtracted | No margin published |
| `xero_project_expenses_ex` | Expenses on record against the job's Xero Project. Evidence. Trade labour may sit outside it | No project is named after the job |
| `invoiced_ex`, `collected_ex`, `draft_revenue_ex`, `variations_listed_ex` | Sales invoiced, paid, in draft, and agreed variations | Never null |
| `profit_ex`, `margin_pct` | Invoiced minus the cost the margin used (`margin_cost_ex`) | Unknown. `cost_flag` and `completeness` name why |
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
| `xero_project_exceeds_line_costs` | See the Xero Project rule. While the project switch is off this is also `cost_flag` and profit is null. While it is on, this stays set and profit stays null unless the job is finished or billed labour has reached an approved work order whose agreed labour is above zero. When that margin publishes, this suppressor is not set and `cost_flag` is `ok`. An unconfirmed installer bill still blanks the margin | Null until the project margin publishes |
| `installer_bill_unconfirmed` | An installer bill (account 306 or 301) is on the job but no person has confirmed it. See the installer bill rule. Always on, not behind a switch | Null |
| `xero_project_margin_held` | The project figure is higher than the linked lines, the switch is on, and the job is not finished and billed labour has not reached an approved work order whose agreed labour is above zero. The margin stays blank | Null |
| `margin_from_xero_project` | The published margin used the Xero Project figure. Only while `job_profit_xero_project_cost_v1` is on, no installer bill is unconfirmed, and the job is finished or billed labour has reached an approved work order whose agreed labour is above zero | Shown, and `margin_source` is exactly `from Xero Project, may exclude unlinked labour` |
| `patio_sales_price_conflict` | The one frozen patio tool quote disagrees with the live price, with what has been invoiced, or with the sent quote, by more than $1. The published price is blank. Only while `job_profit_patio_quote_v1` is on | Not guessed |
| `patio_sales_price_unreadable` | The frozen patio tool quote could not be read. A sent quote, when there is one, is kept. Only while the patio switch is on | The sent quote, or null |
| `patio_sales_price_live_only` | A patio job has a readable live price and no frozen tool quote. A sent quote, when there is one, is kept. Only while the patio switch is on | The sent quote, or null. The live price is not published |
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
| `quote_costs_incomplete` | The quote the job stands on sealed its costs as still to confirm, so no expected cost is fixed (`expected_source` null). Not the same as a job with no costed quote. Column `quote_costs_incomplete` (20261020220000). | Shown |

From `text_matched_lines` through `holding_job`, and `quote_costs_incomplete`, these appear in `completeness` only.

## Switches

Three rows in `feature_flags`, seeded off. Missing or unreadable is off.
Turning one on is the owner's word, after this migration is applied. While a
switch is off, the fields that switch owns keep the meaning they had before
it. Installer-bill blanking is not one of those switches: an unconfirmed
installer bill blanks profit and margin with every switch off.
The four columns added in `20261021180000` (`margin_source`, `margin_cost_ex`,
`expected_labour_quote_ex`, `work_order_agreed_labour_ex`) are present either
way.

| Flag | While off | While on |
|---|---|---|
| `job_profit_work_order_labour_v1` | Expected labour is the quote snapshot. `work_order_agreed_labour_ex` is still shown | Expected labour is an approved job work order's agreed labour (`approved_at` is not null) when that figure is present, ahead of the quote. Approved customer-variation trade allocation is included. A draft work order and a draft variation are not. Crew work orders are not read. A stored 0 is a real figure |
| `job_profit_xero_project_cost_v1` | A Xero Project above the linked lines nulls profit and margin | That margin uses the project figure as its cost only when the job is finished or billed labour has reached an approved work order whose agreed labour is above zero, and `margin_source` is exactly `from Xero Project, may exclude unlinked labour`. A stored 0 does not publish it. Otherwise the margin stays blank and `xero_project_exceeds_line_costs` stays set. When the margin publishes, that suppressor is not set and `cost_flag` is `ok`. `actual_cost_ex` stays the linked lines. A missing client invoice, incomplete lines, unclassified lines, or an unconfirmed installer bill still hide the margin. `materials_not_linked` and `no_labour_linked` do not |
| `job_profit_patio_quote_v1` | `quoted_ex` is a sent quote document only | A patio job's sales price is the one frozen tool quote when it is the only candidate and it agrees with the live price and with what has been invoiced. A conflict is blank and flagged. The live price is never published. `quoted_source` is `patio_quote:sole_frozen_revision` |

## Xero Project rule

`actual_cost_ex` is never the Xero Project total. `profit_ex_unsuppressed`
stays null when the project exceeds the linked lines.

While `job_profit_xero_project_cost_v1` is off, that excess also nulls
`profit_ex` and `margin_pct`, and `cost_flag` is
`xero_project_exceeds_line_costs`. Show the project total beside the job as
"project expenses on record".

While the switch is on, the published margin is invoiced minus the project
figure only when the job is finished (`complete`, `completed`, `invoiced`,
`archived`, `get_review`, `final_payment`) or billed labour has reached an
approved work order whose agreed labour is above zero. A stored agreed labour
of 0 is still a real expected-labour figure, and it does not publish this
margin. Then `margin_source` is exactly
`from Xero Project, may exclude unlinked labour`, `margin_cost_ex` is the
project figure, `cost_flag` is `ok`, and `completeness` names
`margin_from_xero_project` and not `xero_project_exceeds_line_costs`. The line
costs are not added on top. When that margin publishes, linked trade labour
that is not booked to the Xero Project is dropped from it. That drop is the
current behaviour and is pending Marnin. Otherwise the margin stays blank,
`cost_flag` stays `xero_project_exceeds_line_costs`, and `completeness` also
names `xero_project_margin_held`. An unconfirmed installer bill blanks the
margin either way.

These three rules are DEFAULT, owner to confirm: publish the project margin
only when the job is finished or labour is fully billed; stop the suppressor
when that margin publishes; blank and flag a patio quote that disagrees. Approved-only
work-order labour is the same kind of default.

Company, work-type and month `actual_cost_ex` totals never include the project
figure. `published_cost_ex` includes it only for a job whose margin was
published from the project.

## Supplier bills

Nothing in this read sets `xero_invoices.job_id`. A reviewed match is a row in
`materials_bill_proposals` (Bills to place), outcome `queued_for_review`,
written by `job_profit_link_bill`. The writer refuses a sales invoice, a
voided or deleted bill, a bill already linked to a job, a trade-app bill, an
installer bill (account 301 or 306), and a bill that already has a
`job_materials_facts` row. A refusal writes nothing.

`scripts/job-profit-bill-match.ts` is the dry-run. It prints every proposed
bill: bill id, contact, amount, job number, the matched text, and the outcome.
A match is a whole job-number token only (`SWP-`, `SWF-`, `SWMS-`, `SWB-`,
5 or 6 digits) in the reference, a line description, or line tracking, so
`SWF-2611` never matches inside `SWF-261111`, and `SWF-261041,SWF-261042` is
two tokens. A bill that names more than one job number goes to review for a
person to split. A subcontractor-account bill and a bill paid through the
trade app are excluded and are never applied. `--apply` writes only a reviewed
list, one audit row per proposal, and never touches an installer bill. It is
manual and is not run by this migration.

xero-sync's bill prematch (`runBillPrematch`) is the only writer whose rows
its own sync keeps. A proposal from `job_profit_link_bill` has a different
hash and no queue-row ownership, so the next sync supersedes it. Keeping it
needs a change in that sync, described on the pull request. Until then this
writer does not attach a proposal to an open Bills-to-place queue row.

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

Each of `totals`, `by_type[]` and `by_month[]` carries:

| Field | Meaning |
|---|---|
| `jobs` | Jobs in the group |
| `invoiced_ex`, `collected_ex`, `actual_cost_ex` | Summed over every job in the group |
| `quoted_ex`, `jobs_with_quote`, `invoiced_on_quoted_ex` | Sent-quote value, how many jobs have one, and what those same jobs invoiced |
| `expected_cost_ex`, `jobs_with_expected`, `actual_cost_on_expected_ex` | Quote-fixed expected cost, how many jobs have one, and what those same jobs cost |
| `profit_ex`, `margin_pct`, `jobs_with_margin`, `published_revenue_ex`, `published_cost_ex` | Only jobs whose profit the engine published. `published_cost_ex` uses `margin_cost_ex` when that job's margin came from the Xero Project, and `actual_cost_ex` otherwise. `actual_cost_ex` in the same bucket stays line-level |
| `revenue_verified_paid_jobs` | Jobs whose sales invoices are all paid in Xero |

Compare expected with actual through `actual_cost_on_expected_ex`, and quoted
with invoiced through `invoiced_on_quoted_ex`, so both sides cover the same
jobs. `by_month` groups jobs by the `date_field` that filtered them; it is a
job cohort, not an accounting period.
