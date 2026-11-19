# More than one work order on a job (v1)

Owner, 19 Nov 2026: a job can need several pieces of work, each with its own
scope and agreed amount (a make-safe, a roof report, a restoration, a repair),
and trades invoice the work order, not the job. Worked case: SWRESTO-261719
(Lynwood) had a $80 work order to attend, inspect, report and quote; once the
builder approved the restoration, the restoration day and the equipment pickup
are a second work order on the same job.

Code: `supabase/functions/ops-api/job_additional_work_orders.ts`. Schema,
seal and approval: `supabase/migrations/20261119090000_additional_job_work_orders.sql`
(contract `supabase/tests/migration-contracts/20261119090000_additional_job_work_orders/`).

## Model

- The job keeps its ONE main work order (`work_orders.kind = 'job'`, unique per
  job). Everything in `docs/job-work-orders-v1.md` is about that one and is
  unchanged: quote fill, automatic issue, owner approvals, customer
  variations, group work orders.
- Every further work order is a row of kind `additional`: its own number
  (`WO-<job number>-<n>`, the main one counting as 1), `title`, `scope_items`,
  `special_instructions`, `scheduled_date`, `agreed_labour_ex` and optionally
  the trade it is for (`assigned_user_id`). Draft, then approved and sealed;
  never deleted once approved (trigger `work_orders_additional_guard`).
- Approving one (`approve_additional_work_order`, the only door) seals it and,
  in the same transaction, adds its amount to the main work order as a work
  order amount change (`change_work_order_amount`, P1-14), reason
  `Additional work order <number>: <title>`. The main work order's own row
  never changes. So every job-level rule that reads the main work order plus
  its amount changes (the invoice cap `_assertWithinWorkOrderTotal`,
  `job_backed_room` and the line hold, the pay run checks, the group pot, the
  overbilled list) allows the job's whole agreed labour with no change to any
  of them, and nothing is counted twice.
- Nothing that reads `kind = 'job'` sees an additional work order, and every
  crew reader reads `kind = 'crew'` (ops-api no longer reads `kind <> 'job'`).
  Trades never read either directly: the client read policy hides every kind
  but crew. `job_cost_close` counts additional orders with the job's own.
- The main work order must be approved first (409
  `main_work_order_not_approved`). On a restoration job set it with
  `restoration_set_work_order`.
- Amounts include super. The one super rule (`trade_invoice_money.ts`,
  `inclusive_12_112_v1`, live from the pay week of 23 Nov 2026) takes 12/112
  of what the trade bills as super and pays the rest; nothing here works super
  out. Work done in a pay week before that rule starts is priced by the old
  rule.

## Which work order a trade bills

The trade app's Pay tab bills one agreed amount per job card
(`work_order_agreed_ex` on `my_hours` and `trade_invoice_job_modes`). With
more than one work order on the job, that amount is the first work order this
trade has not billed yet (`pickTradeWorkOrder`). The job's work orders a trade
may bill are, in order: those named for this trade (`assigned_user_id`), then
the main one, then those named for nobody, each group by approval. A work
order named for another trade is never offered. What this trade has billed on
the job (lines on invoices in `job_work_order_billed_invoice_statuses`, not on
a holding invoice, an override first, commission and reimbursement left out:
the cap's own rule) covers them in the order they were approved, so a trade
who billed the main work order before a named one was added has the main one
covered and is offered the named one; a part payment never covers a work
order. Once every one is billed, the card shows the main work order again and
the cap refuses more.

So a trade with a work order named for them is offered it first, at its
agreed amount, even when the same trade also holds the main work order, and
`generate_trade_invoice` refuses any other figure
(`work_order_amount_not_agreed`), exactly as before.

## The cap holds a named work order for its trade

The job-wide cap allows the main work order plus its amount changes, which
carry every additional work order. On its own that would let one trade bill
into another trade's named work order (trade A bills the main order; trade
B's order is approved; A bills the main order again and passes while B's
amount is at least the main one's). So on a job with an approved additional
work order named for a trade, the cap also checks the trade whose invoice the
line is on (`ownWorkOrderRoomEx`, `work_order_total_cap.ts`): every other
trade keeps the larger of its named work orders and what it has billed, and
this trade may bill what is left of the job's allowance after those and its
own billing. A named work order stays its trade's however much room the job
has, and the job's shared part (the main work order, its customer variations
and raises, and any additional order named for nobody) is drawn on once in
all, however many trades bill it. The refusal is the cap's code
(`work_order_total_over_agreed`) with `limit: "own_work_orders"` on the job;
the figure (`most_this_invoice_ex`, the trade's own room) is shown only on a
job where every billed line is theirs, as for the job-wide cap. On such a job
a refusal shows the trade's own room even when the job itself is over: the
job's room carries the other trade's named amount and is never shown. On a
job whose named work orders are all the billing trade's own, its room is the
job's, so the job check alone answers, with the words it always had.

It can only add a refusal: the job-wide check runs first and unchanged. A job
with no additional work order, or with additional ones named for nobody,
reads nothing more and answers exactly as before. The named orders reach the
cap only through `loadTradeInvoiceJobModes`'s `includeAdditionalOrders`,
which only the cap door sets: they carry other trades' amounts and are never
on an answer a trade reads. A lead's adjust of a crew line
(`review_crew_charge`) holds the line's own trade, never the lead. With
`trade_line_hold_v1` on, the job's billed total is the database's
(`work_order_backed_billed`) and each trade's share is read from the lines by
the same rule as with the switch off; that share can only be larger, so it can
only add a refusal. The database's own job amount guard is job-wide and does
not know a named work order (not built yet).

A job with more than one work order adds three fields to its mode answer:
`cap_work_order_id` and `cap_agreed_ex` (the main work order, which the cap
reads) and `work_orders[]` (`{id, wo_number, title, agreed_ex, main,
billed}`). A job with one work order answers exactly as it did. A trade who is
not allocated to the job gets none of the amounts.

`my_job_work_order` adds `additional_work_orders[]`: each approved one through
the same allowlist as the main work order (scope and instructions, never an
amount), with `title` and `for_me`.

## API

All on `ops-api`. Staff = a signed-in admin/owner/ops_manager, or the ops
server key with the owner-directed fence (`owner_email` + `owner_statement`,
`ses_owner_directed_approval.ts`). Errors are `{error, code}`.

| action | method | input | output |
| --- | --- | --- | --- |
| `add_job_work_order` | POST | `{job_id \| job_number, title, agreed_labour_ex, scope_items?, special_instructions?, scheduled_date?, assigned_user_id?, approve?}` (`approve` defaults true; `scope_items` `[{description, qty?, unit?, hours?}]`; one of scope or instructions required) | `{success, job_number, work_order:{id, wo_number, title, status, agreed_labour_ex, assigned_user_id, main_work_order_id}, job_agreed_total_ex, note}`. 409 `main_work_order_not_approved`, 409 `work_order_not_approved` (saved as a draft), 400 `money_in_text` (a title, scope line or instruction carrying `$` or a rate: trades read every word), 403 `approver_required` |
| `approve_additional_work_order` | POST | `{work_order_id, expected_updated_at}` | `{success, work_order}` with `amount_change`; 409 `stale_review` |
| `job_work_orders` | GET | `job_id` or `job_number` | `{schema:"job-work-orders.v1", job, work_orders[] (main and additional: id, kind, main, wo_number, title, status, agreed_labour_ex, assigned_user_id, trade_name, scheduled_date, approved_at, approved_via, updated_at), agreed_total_ex}` |

`job_events` rows (`job_work_order_added`, `job_work_order_drafted`) carry ids
and the title only, never an amount: trades read job events. An owner's
direction through the server key is kept there as who and when only
(`owner_directive: {kind, owner_user_id, recorded_at}`,
`ownerDirectiveEventStamp`), never their words or email address.

## Not built yet

- The database's job amount guard (`trade_invoice_lines_job_amount_guard`)
  and `job_backed_room` are job-wide: a line written straight to the database
  past the ops-api doors is not held to a trade's named work order.

- The trade app shows the next work order's amount on the job card but does
  not list the job's work orders or let the trade choose one; it reads
  `additional_work_orders` nowhere yet (secureworks-ux follow-up).
- The office screens: no Add work order button (use `add_job_work_order`), and
  Financials > Work Orders lists main work orders only.
- A trade invoice line is still stamped against the main work order
  (`trade_invoice_lines.job_work_order_id`). The staff figures of the main
  work order (`job_work_order` read) count every labour line on the job
  against its own agreed labour without the amount changes, so a job with an
  additional work order reads over its main figure there. The cap, the line
  hold and the pay run checks read the amount changes and are right.
