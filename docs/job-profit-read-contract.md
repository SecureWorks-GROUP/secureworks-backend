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
| `cost_flag`, `revenue_flag`, `completeness` | The first reason, and every reason, a figure is missing or weak | Never null |

There is no live price or live estimate field. Show "no quote sent" when
`quoted_ex` is null.

## Xero Project rule

The Xero Project total is never returned as actual cost and is in no company,
work-type or month total of cost or profit. When it is larger than the costs
linked to the job, the job is flagged `xero_project_exceeds_line_costs` and
`profit_ex`, `margin_pct` and `profit_ex_unsuppressed` are null. Show the
project total beside the job as "project expenses on record", never as the
job's cost.

## Rollup fields

Each of `totals`, `by_type[]` and `by_month[]` carries:

| Field | Meaning |
|---|---|
| `jobs` | Jobs in the group |
| `invoiced_ex`, `collected_ex`, `actual_cost_ex` | Summed over every job in the group |
| `quoted_ex`, `jobs_with_quote`, `invoiced_on_quoted_ex` | Sent-quote value, how many jobs have one, and what those same jobs invoiced |
| `expected_cost_ex`, `jobs_with_expected`, `actual_cost_on_expected_ex` | Quote-fixed expected cost, how many jobs have one, and what those same jobs cost |
| `profit_ex`, `margin_pct`, `jobs_with_margin`, `published_revenue_ex`, `published_cost_ex` | Only jobs whose profit the engine published |
| `revenue_verified_paid_jobs` | Jobs whose sales invoices are all paid in Xero |

Compare expected with actual through `actual_cost_on_expected_ex`, and quoted
with invoiced through `invoiced_on_quoted_ex`, so both sides cover the same
jobs. `by_month` groups jobs by the `date_field` that filtered them; it is a
job cohort, not an accounting period.
