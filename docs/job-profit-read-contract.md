# Job profit read contract

What the finance tab reads from `ops-api?action=job_profit` and
`ops-api?action=job_profit_list`. Engine: migration
`20261009130000_job_profit_engine.sql` (`v_job_profit`, `v_job_cost_events`,
`v_job_revenue_events`). Code: `supabase/functions/ops-api/job_profit.ts`,
`job_profit_rollup.ts`. Every response also carries these meanings under
`labels`.

Access: a server key or an admin/owner session. Everyone else gets 403.

All money is ex GST. Profit is gross profit on direct costs, no overhead.

`reporting-api?action=job_profitability` (Jarvis and the older Job P&L tab)
reads the same `v_job_profit` rows (`reporting-api/job_profitability.ts`).
Its legacy keys keep their names: `invoiced` is `invoiced_ex`, `bills` is
`actual_cost_ex` (null when nothing is placed), `margin` / `margin_pct` are
`profit_ex` / `margin_pct` (null unless `margin_ok`, with `margin_status` and
`margin_reason`), `quote_value` is `quoted_ex`. Its summary average covers
margin-known customer jobs only and excludes holding jobs. Its added detail
fields (expected, committed, collected, holding job money) are returned only
to staff and server callers (`summary.detail` says `full` or `basic`); every
caller gets `margin_status`, `margin_reason` and `margin_reason_codes`, which
carry no money.

## Actions

| Action | Returns |
|---|---|
| `job_profit&job_id=<uuid>` or `&job_number=<number>` | `job` (one row of the fields below), `trades`, `trade_charge_dates` (below), `cost_events`, `revenue_events`, `timeline`, `dispatch_orders` (below), `cost_close` (below), `labels` |
| `job_profit_list` (`type`, `status`, `from`, `to`, `date_field=created\|invoiced`, `limit`, `offset`) | `jobs` (rows of the fields below), `has_more`, `cost_close` (below, by job), `labels` |
| `job_profit_list&view=rollup` (same filters) | `totals`, `by_type`, `by_month`, `labels` |

`job_profit_list` returns no row count. `has_more` is true when another page
follows: ask again with `offset` raised by `limit`. An offset past the last job
answers an empty `jobs` with `has_more` false, never an error. Totals come from
`view=rollup`.

The `type` filter matches `work_type`, not `jobs.type`: a job whose family is
repair is listed as `repair` whatever its type. `work_subtype` is the family.

## When each trade charged

A crew invoice line's `event_date` in `v_job_cost_events` is its `line_date`
or else the pay week's start, so it is not when the trade charged. `job_profit`
reads each trade line's crew invoice (`trade_invoice_lines` by line id, with
`trade_invoices.submitted_at`) and adds, on that line's `cost_events` row and
its `timeline` entry: `submitted_on` (the Perth day the trade submitted it),
`work_date` (the day worked, from the line's time entry) and `line_date` (the
line's own day: a work order's completed or scheduled day, or the day typed).
Each `trades` row gains `first_charge` and `last_charge`, each taken from one
line: the earliest and latest by submitted day, then day worked (or line day).
A trade charge's `timeline` date is its submitted day; a line never submitted
keeps its cost event date. `trades.first` and `trades.last` stay the cost event
dates. `trade_charge_dates.status` is `ok`, `none` (no trade line) or
`unknown` with a `reason`: then no date is added and none is guessed. No
figure, lane or cost event date changes.
Legacy jobs have no row.

## Job fields

| Field | Meaning | Null means |
|---|---|---|
| `quoted_ex` | Value of a sent or accepted quote | No quote was sent. Never the live price |
| `quoted_source` | Which quote: `sent_quote:...` | No quote was sent |
| `expected_cost_ex`, `expected_labour_ex`, `expected_materials_ex`, `expected_commission_ex` | Cost fixed at the quote | No cost was fixed at a quote, including a quote sent with no cost figures. Never 0 for that, never a live estimate |
| `expected_source` | `job_budget` (switch `job_profit_expected_from_job_budget` on, migration 20261114040000), `frozen_at_acceptance`, `accepted_quote_revision` or `sent_quote_revision` | No cost was fixed at a quote |
| `expected_other_ex`, `expected_budget_id`, `budget_gross_profit_ex` | With a job budget read: its lanes not paid to the crew (cost before commission less materials less the work order amount; inside `expected_cost_ex`), the budget row read, and its gross profit (sell less cost before commission). With a budget, `expected_labour_ex` is the work order amount | No budget was read (none on the job, or the switch off). Absent before migration 20261114040000 |
| `office_variations_ex`, `office_variation_labour_ex` | The approved office variations on the job work order (`work_order_customer_variations`): their customer price and their trade allocation, ex GST. The price is also in `variations_listed_ex`, so the margin is held (`variation_not_invoiced`) until the invoices cover it. A draft or cancelled one is in neither | Never null (0). Absent before migration 20261111100000 |
| `expected_labour_with_variations_ex`, `expected_cost_with_variations_ex` | The quote's expected labour and expected cost plus that trade allocation. The quote's own figures (`expected_labour_ex`, `expected_cost_ex`, `quoted_ex`) stay the quote's | No cost was fixed at a quote (as `expected_cost_ex`). Absent before migration 20261111100000 |
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
| `materials_below_quote` | Materials are placed, but less than 70% of the materials cost the quote fixed (`expected_materials_ex`): a bill is probably still to come | Null |
| `ordered_not_billed_over_30_days` | A sent order with no price was first sent 30 or more Perth days ago (the policy's limit) and still has no invoice or bill | Shown (named in `cost_flag` and Null only if the policy makes it hold) |
| `po_no_bill_overdue` | A priced open order whose delivery day (else the Perth day it was created) is 30 or more days ago, or a supplier invoice emailed for an order 30 or more Perth days ago, still with no bill placed | Shown (named in `cost_flag` and Null only if the policy makes it hold) |
| `variation_not_costed` | An agreed variation with money on it has no cost figure (`job_variations.cost_estimate` empty; 0 is a figure) | Shown (named in `cost_flag` and Null only if the policy makes it hold) |
| `text_matched_lines` | A trade line was matched to the job by text, not by job id | Shown |
| `xero_project_linked_by_contact_only` | The job's Xero Project is linked by contact, not by name, so it gives no project figure | Shown |
| `unapproved_trade_charges` | A trade charge is on an invoice not yet approved | Shown |
| `open_purchase_orders` | `committed_open_ex` is above zero | Shown |
| `ordered_not_billed` | A sent order with no price has no invoice or bill yet | Shown |
| `invoice_emailed_bill_not_placed` | A supplier emailed an invoice for an order, and no bill is linked to that order (it may be on the job unlinked) | Shown |
| `draft_revenue` | `draft_revenue_ex` is above zero | Shown |
| `holding_job` | A holding job, not a customer's job | Shown |
| `variation_not_invoiced` | An agreed variation, and the job's invoices fall short of the sent quote plus its agreed variations by more than $1. Which invoice bills a variation is not recorded, so the totals decide | Null (the policy can make it a warning) |
| `variation_invoice_unchecked` | An agreed variation on a job with no sent quote (repairs priced in the quote builder among them), so nothing can show whether it is invoiced | Shown |
| `work_done_no_labour_overdue` | The job was completed (`jobs.completed_at`) or first signed off by the client (`job_client_signoffs`) 14 or more Perth days ago and no labour is placed. `no_labour_linked` already holds the margin; this names the overdue case | Null (by `no_labour_linked`) |
| `expected_cost_lane_missing` | The quote fixed an expected cost but left a lane (labour, materials or commission) unknown, so `expected_cost_ex` is partial: the unknown lane counts as 0 in the sum. The figure is unchanged; the rollup does not compare it with actual cost | Shown |

From `xero_project_linked_by_contact_only` to `holding_job`, and the last four,
appear in `completeness` only. `cost_flag` takes the first cost reason in the
order of this table. `materials_below_quote` and, while they hold, the next
three sit after `no_labour_linked`, so a job whose `cost_flag` was one of the
reasons above them keeps it; a job that read `ok` or `text_matched_lines` may
now read one of them. `revenue_flag` stays `ok` or `missing_client_invoice`.

## Partial-cost checks (TP-13)

A cost probably missing is a named reason, never a margin: it is never turned
into an estimate, and expected, committed and actual stay separate figures.
Every check is named in `completeness`. Which checks also hide the margin is
`job_profit_partial_cost_policy() -> holds_margin` (migration 20261029160000),
so a later migration can flip one without rewriting the view:

| Check | As shipped | Why |
|---|---|---|
| `materials_below_quote` | Holds | Placing the missing bill clears it. Its switch can make it warn, for a job whose materials really came in under quote |
| `po_no_bill_overdue`, `ordered_not_billed_over_30_days` | Warn | A person's bill placement records no order (`materials_recon.ts` writes `matched_po_id` null), so a placed bill never closes its order and a hold could never clear |
| `variation_not_costed` | Warn | The variation writer dropped a cost of 0 until the same change, and the trade app sends no cost (its `estimated_cost` is the price) |
| `variation_not_invoiced` | Holds | Issuing the invoice clears it; with no sent quote it is `variation_invoice_unchecked` instead, which never holds |

The numbers change only by migration: an order with no bill after 30 Perth
days, no labour 14 Perth days after the work is done, materials below 70% of
the quote's, and $1.00 of tolerance on the variation cover. They are
proposals. The Xero Project check is `xero_project_exceeds_line_costs`,
unchanged.

The story money book (`context_job_story_book`) names the cost checks that hold
in its margin line and an uncovered variation as money not billed (`reason`
`variation_not_invoiced`, "Money incomplete"). As shipped no hold depends on
the clock, so a day passing never changes a story's words. A check that
depends on the clock and holds would; for that case
`context_job_story_money_sig` carries the order checks' state while the policy
makes one hold, so the sweep rewrites the story on the day an order turns
overdue. The signature also carries the job's variations.

## Cost close (15 Nov 2026)

Is a job's cost final, and if not, what is it waiting on. `job_cost_close(job_ids, as_of)`
(migration 20261115130000, service role only) works the answer out from Job Profit's own row on
every read. The answer is not stored, no person closes a job, and `v_job_profit` is untouched. Every number
and list is in `job_cost_close_policy()` (`cost-close-v1`) and changes only by migration.

The same migration adds `job_status_moves`: the database's own record of every job status move,
written by a trigger on `jobs` whoever makes the change (a row when a job is created, one per status
change naming both statuses, and one baseline row per job that existed when the record began). The
rule dates a finish by the last time the job went back to work, and the application's events are not
a complete record of that: five independent reviews each found another writer that changes
`jobs.status` and logs something else or nothing (a restoration stage move, a quote accepted on a
finished job, a declined quote run, a callback, a booking moving `accepted` to `processing`). The
trigger cannot be got around by a new writer. It never fails the change it records (an error is
caught and logged as a warning). Service role reads the table; nothing else reads or writes it.

| `cost_state` | Means |
|---|---|
| `not_applicable` | A holding job, or a job that did not go ahead (cancelled, lost), holds no cost and has none still to come |
| `open` | The work is not finished, or the job is back in rectification or another working status |
| `waiting` | Finished, but Job Profit names a cost reason: `waiting_on` lists them, in Job Profit's words |
| `settling` | Finished with no cost reason, inside the quiet days (30) since the later of the finish day and the newest cost |
| `final` | Finished, no cost reason, quiet for 30 days. `final_on` is the day it became final, `closed_by` the rule |

- **Finished** is where the job stands now, never a day on the job alone: a job sent back to work
  keeps its old `completed_at` and its old sign-off. Read in this order:
  - A job in `rectification` is never finished, and neither is a job with a callback open
    (`jobs.is_callback`, or a `callback_opened` event with no `callback_resolved` after it), nor a
    job with a crew visit still to come (a `job_assignments` row at `scheduled` or `confirmed`, not
    a ghost or observer, dated on or after `as_of`): labour not yet worked.
  - A cancelled or lost job is finished as `did_not_go_ahead` when it holds cost or a cost is still
    to come (`pending_cost_reasons` in the policy: an open or unbilled order, a bill not placed or
    not confirmed, unapproved trade charges), so it reads `waiting`, not `not_applicable`.
  - A job that carries a repair stage is finished by stage `complete` while the stage stands
    (below), whatever its status (the Repairs board moves the stage, not the status), or by status
    `archived` (`closed_statuses`). One sent back to work after its stage reached `complete`, with
    the stage left there, is open until it reaches a finished status again. An invoice never
    finishes a repair, and a stage that is not `complete` is finished only by `archived`.
  - Every other job is finished by a finished status (`complete`, `invoiced`, `final_payment`,
    `get_review`, `archived`). A make-safe is also finished by its first counted invoice, but only
    while it rests at `accepted`, `scheduled` or `processing` (`invoice_finish_statuses`: where
    invoiced make-safes sit on production; `in_progress` and every other working status keep it
    open), only on its first attendance (`makesafe_job_details.cycle_number` 1 and no
    `reopen_reason`), never for restoration work (a restoration stage on the job, or a work
    subtype that contains `restoration`: restoration is invoiced before the works), and only while
    the invoice stands (below): one raised before the job went back to `in_progress`, was reopened
    or was re-attended finishes nothing. Once a make-safe has been taken out of a finished status,
    its invoice never finishes it again; only a finished status does. And the invoice stands only
    while no move to a status that is not finished comes on a later day, except a move from one
    resting status to another whose old status is named (by the record, or by the event; an old
    status inferred from the previous logged move does not count, because a move nobody logged may
    lie between).
- **`finished_on` and `finished_basis`.** The finish day is the later of two days, so a job
  finished a second time is never dated by its first finish and a job is never dated before it
  came to stand where it stands. A job cannot go from `open` to `final` in a day.
  - The work day: the later of `completed_at` and the newest client sign-off not revoked since.
  - The day the job came to stand where it stands. A repair finished by its stage: the newest
    `repair_stage_changed` to `complete`. A make-safe finished by its invoice: its first counted
    invoice. A job at a finished status: the first move into a finished status at or after the
    last move out of one (`job_events` `status_changed` / `status_change`), or for a make-safe
    whose invoice stands, the invoice day when that is earlier (putting the card away later does
    not restart the count).
  - A day stands only while the status has not moved to a working one after it. A working move is
    a move to any status that is not finished; for a make-safe or a job with a repair stage, whose
    status is not its stage, a move to a resting status (`invoice_finish_statuses`) is not one.
    A move out of a finished status is a working move wherever it lands (the old status is read
    from the event, or is the status the last logged move set). Reopening or re-attending a
    make-safe, a quote accepted, a quote run declined and a callback opened each put a job back to
    work and may log no status move; each leaves its own event (`reopen_event_types`, and a note
    starting `Job reopened`) and each counts as a working move. A complete
    stage with no stage move on record stands only when no working move is on record either, and a
    stage stands only while no stage move to another stage is on record after it last reached
    `complete`. A
    stage day that does not stand gives way to the status move. The invoice carries a day and no
    time, so a working status move on the invoice day itself leaves it standing (a make-safe is
    attended and invoiced on one day); a reopen or a re-attend on that day does not.
  - The moves read are `job_status_moves` (complete from the day the record began) and, for the
    time before, the events in `status_events`: `status_changed` and `status_change` (new status
    under `new_status`, `to` or `status`), `restoration_stage_changed` (`job_status`), and the
    events that set a status without naming it (`quote_accepted`, `quote_run_declined`,
    `callback_opened`, `callback_resolved`).
  - **The history floor.** Before the record began, a status move nobody logged cannot be later
    than the day the job row last changed (`jobs.updated_at`, stamped by trigger on every update).
    So the quiet count never starts before the earlier of that day and the day the job's record
    began. A job untouched for 30 days loses nothing; one touched recently waits out the
    difference once, and from 30 days after the record began the floor no longer holds anything.
    Measured on production on 15 Nov 2026 (rehearsed with the record starting that day): 22 jobs
    that would otherwise be final read `settling` because of it.
  - `finished_basis` names the day used: `work_done`, `repair_stage`, `first_invoice`, `status`
    (a status move, or no day on record), `did_not_go_ahead` (no day).
  - The quiet count runs from the latest of the finish day, the newest cost and the history floor. A finished job with
    no day on record counts from the later of the newest cost and the day the job record last
    changed (`jobs.updated_at`), so an old cost never closes a job finished yesterday. With no
    cost date it reads `waiting` on `no_cost_date`; with a cost date and no day at all, `waiting`
    on `no_finish_day`.
  - Known limit: an invoiced make-safe at a resting status is taken as attended; no attendance
    record is read. One nobody attended holds no labour, so Job Profit's own reasons keep it
    `waiting`. Measured 15 Nov 2026: 216 of 285 such make-safes carry a trade report or a
    completed booking; of the 69 that carry neither, 24 wait on a cost reason and 43 hold a dated
    cost with nothing missing.
  - Known limit: a make-safe past its first attendance that rests at `accepted`, `scheduled` or
    `processing` stays `open` until its card reaches a finished status, even when its invoice came
    after the last attendance. Only its first invoice day is read.
  - A status changed outside the application, or by a writer that logs nothing, is in
    `job_status_moves` from the day the record began. Before that, it is bounded by the history
    floor.
- **A cost reason** is any `completeness` code or non-ok `cost_flag`, except the ones that are about
  revenue or structure and not cost (`not_cost_reasons` in the policy: a missing or draft customer
  invoice, an unbilled variation, a holding job, a missing expected-cost lane, a Xero Project linked
  by contact only). Every other code holds a close, `text_matched_lines` included, and so does a code
  Job Profit adds later. So `final` says the cost is complete; it does not say the job was invoiced.
- **Nothing is frozen.** A cost that lands on a final job moves it back to `settling` with a later
  `final_on`; a job put back into rectification or any working status reads `open`, and so does a
  repair or a resting make-safe reopened, re-attended or sent back to work. `as_of` moves
  only the day the quiet count is measured to: the costs, the status and the reasons are always
  today's, so it is not a read of how the job stood on an earlier day. Measured on production on 15 Nov 2026:
  of 261 jobs finished by 15 Aug, 22 took a cost more than 30 days after going quiet and 11 more than 90.
- `job_profit` returns `cost_close` for its job; `job_profit_list` returns `cost_close.by_job` for
  the page. Each is `{ ok: true, cost_state, cost_final, final_on, closed_by, finished, finished_on,
  finished_basis, last_cost_on, waiting_on, all_costs_paid, quiet_days, as_of, rule }` and carries no
  money figure. A read that fails, or a job the rule has no row for, is `{ ok: false, reason }`:
  never `final`, never `open`. A job missing from `by_job` is not known.
- It is not line evidence: `final` does not mean every cost line is verified (`line_evidence` says
  that), and it never changes a margin or whether one is shown.

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
| `expected_cost_ex`, `jobs_with_expected`, `actual_cost_on_expected_ex` | Quote-fixed expected cost, how many jobs have one, and what those same jobs cost: only jobs whose actual cost is complete (`cost_flag` `ok` or `text_matched_lines`) and whose expected cost names every lane (no `expected_cost_lane_missing`) |
| `jobs_with_expected_not_comparable`, `expected_cost_not_comparable_ex` | Jobs with an expected cost whose actual cost is still partial (no cost linked, materials not linked, labour missing, unclassified or incomplete lines, a Xero Project above its lines, a TP-13 cost reason), or whose expected cost left a lane unknown, and their expected cost. Not compared |
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

## Dispatch orders and their bills (B4)

`job_profit` answers `dispatch_orders`: the job's Dispatch orders and the supplier bills linked to each, read
from `v_dispatch_orders` and `v_dispatch_order_bills` (migration `20261104010000`, service role only; code
`job_dispatch_orders.ts`; rules (c) and (d) from migration `20261104040000`, (e) and (f) from `20261104233000`). An order is a Dispatch v2
supplier order email that went out (`sent` or `send_unknown`) or a purchase order that is not a draft or
cancelled.

A supplier bill (Xero ACCPAY, AUTHORISED or PAID) links to an order by the owner's rule of 3 Nov 2026, by
itself, never by a person: the bill's supplier is the order's supplier (the supplier record's Xero contact, or
the names agree once company words are dropped: "Metroll" and "Metroll Perth"), and the bill's number,
reference or line text carries `supplier_ref` (a supplier order, quote or invoice number saved for that order
from its replies) or `job_number` (our job number, as `SWP-261309`, `SWP261309` or `SWP 261309`), and, decided
3 Nov 2026 09:44Z, `po_number` (our PO number as words, `PO-298035` or `PO 298035`, or run together,
`PO298035`, `PO#298035`, never the digits alone; on the bill or on the supplier's PDF of it) or `site_address`
(the job's site address in the bill's own number, reference or lines, decided 10:26Z, or on the supplier's PDF,
keyed by the context placer's `context_address_key`, when it matches exactly one order of that supplier). The
supplier's PDF of a bill is a PDF that came in by email from that supplier (never one we sent; the sender's address
carries the supplier's name), whose file name and text both carry the bill's number and whose text names the bill's
supplier. Its text is what the document text reader or, for a scan, the vision reader already extracted; a scan
neither could read has no text and its bill waits. The same supplier and the same
amount alone never link. Purchase orders have no saved refs and Dispatch v2 emails have no order number, so
`supplier_ref` applies only to v2 orders and `po_number` only to purchase orders. A bill links to one order:
one that names two orders links neither and is listed under that order's `unclear_bills` with a reason
(`several_order_numbers`, `other_order_ref`, `job_disagrees`, `several_jobs_named`, `several_orders_on_job`);
an order's own number (saved ref or PO number) picks its order when nothing else on the bill points at another
job.

Two more, from migration `20261104233000` (3 Nov 2026), for bills that carry nothing of ours but that our own records
tie to the order: `bill_number` (purchase orders only: the bill's own number written on the purchase order's
reference or notes, where the office records the supplier's quote or invoice number, as `R&R INV-86846` or
`Lysaght quote KEW/231967 received`; read as written on the bill, its letters, then 5 or more digits, then at most
one letter, so `INV-86846` never matches `INV-86846a`; a number of digits alone needs 6 or more and is never read
inside an amount; it picks its order like a saved ref) and `job_number` found in `pdf_email` (Dispatch v2 orders
only: our job number in the subject and body of the emails that carry the supplier's PDF of the bill, the supplier's
own email from the domain the order went to, or ours, such as a forward to finance@ asking to pay it, never a
customer's; those words must name exactly one job number; the PDF's own text is not needed, so a scan no reader can
read still links; it places like a job number on the bill).

| Field | Meaning |
|---|---|
| `status`, `reason` | `ok`, or `unknown` with a reason when the orders or links cannot be read. Unknown is never "not billed": `ordered`, `billed` and `not_billed` are then null |
| `ordered`, `billed`, `not_billed` | Counts of orders; billed = at least one bill linked |
| `orders[]` | `order_kind` (`dispatch_v2_email` or `purchase_order`), `order_id`, `supplier`, `order_label` (the email subject or PO number), `order_status`, `ordered_at`, `state` (`billed` or `not_billed`), `bills[]`, `unclear_bills[]` |
| `bills[]` | `invoice_number`, `supplier`, `bill_date`, `bill_status`, `bill_sub_total_ex` (the bill's own amount, ex GST), `rule` (every rule that matched, joined by `+`, in the order `supplier_ref`, `job_number`, `po_number`, `site_address`, `bill_number`), `matched_ref`, `matched_job_number`, `matched_po_number`, `matched_site_address` (the address key), `matched_in` (where it was found, joined by `+` in this order: `bill`, `supplier_pdf`, `pdf_email`, `order`), `cost_on_this_job` (Job Profit counts the bill on this job) |

No price goes on an order and a link moves nothing: it places no bill, writes no row, and changes no figure
in `job`, `cost_events`, `ordered_not_billed_count` or any rollup. `ordered_not_billed_count` still counts
purchase orders only.

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

## Employer-super consumer classification

The existing Group WO employer-super source is `trade_employer_super`.
`job_profit.timeline` labels it `employer_super`, never `supplier_bill`.
Its original source/line identity, date (including null), `is_actual`, amount,
and unpaid status pass through unchanged. A cash invoice payment does not
settle the employer obligation. Advance-related events stay nonactual.
The `trades` totals continue to show trade charges only; employer-super
obligations are shown separately. No new cost formula is calculated by the
API or screen. Missing super records do not establish zero or cost-close.
The source producer and its feature activation remain owned by Group WO;
this consumer compatibility change does not activate that feature.

A crew bill raised straight in Xero (no crew-app record) can state the company super on its super line
("Company contribution $50.40"). Since 20261104071000 each placed line of that bill carries its share of
it (line amount x contribution / the bill's other lines), source `bill_employer_super`, on the line's job
and lane, unpaid, behind the same `job_cost_employer_super_v1` switch. `job_profit.timeline` labels it
`employer_super`. The super line itself, the worker's share withheld from pay and paid to the fund, is
never a cost on any bill. Crew-app mirror bills stay out, so a crew invoice's super is only ever its own.

## Split lines and supplier credits (A6, 3 Nov 2026)

- A Xero line Bookkeeping's ledger splits across jobs is one `cost_events` row per part (20261104070000):
  source `supplier_bill`, `source_id` `<bill>:<line>:part<k>`, match `bookkeeping_evidence`, at the part's
  amount. Parts are used only while complete and adding up to the Xero line as we hold it, and only where
  the ledger's line evidence is (no office whole-bill job). An AI whole-bill fact stands aside whenever the
  ledger places any line or part of that bill on another job; a person's split still outranks the ledger.
- A supplier credit is taken at the credit note's own ex-GST rate (its sub total over its total), the bill's
  rate only when our copy does not hold the note (20261104072000). One bill's credit rows are rounded as a
  running total, so they add up to the credit's own cents.

### Context money-book completeness (TP-13 / TP-17 composition, 31 Oct 2026)

A warning permits the agreed provisional margin; it is not evidence that costs or invoicing are complete. The story money book names `variation_not_costed` and `variation_invoice_unchecked`, sets `complete=false` and shows the corresponding Costs/Money incomplete line while retaining the actual margin on costs placed so far. An explicit variation cost of zero remains known. The signature combines existing TP-13 variation inputs with the later native employer-on-cost inputs; both known definitions have guarded, reversible composition. No cost, invoice, policy or payment row is changed.
