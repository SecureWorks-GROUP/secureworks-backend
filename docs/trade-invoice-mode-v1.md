# How a trade invoices a job (v1)

Marnin, 11 Nov 2026: a trade invoices each job ONE way, decided by the job,
not chosen by the trade. Code: `supabase/functions/ops-api/trade_invoice_mode.ts`;
tests: `trade_invoice_mode_test.ts`.

## The rule, in order

1. The job has a live (not `void`) group work order: `group_work_order`.
2. The trade is per metre (`users.invoice_type = 'per_metre'`): `work_order`.
3. A patio job: `group_work_order`.
4. A fencing job: `work_order`.
5. Everything else (make-safe, repair, other): `hourly`.

The job's vertical is read with `_jobVertical` (index.ts), repair family
first: a repair-family card typed `makesafe` or `fencing` is `hourly`, and an
`SWMS-` numbered job is a make-safe. Each answer carries
`invoice_mode_reason`: `live_group_work_order`, `per_metre_trade`,
`patio_job`, `fencing_job` or `other_job`.

The rule decides; it refuses nothing. The write paths keep their own checks.
Fencing helpers are still paid by the hour on fencing jobs (they bill
SecureWorks directly), so no hourly line on a fencing job is refused because
of this rule. There is no office per-job setting yet; trades add themselves to
a job with `self_allocate_for_invoice` (`docs/trade-self-allocation-v1.md`).

## Commission

Commission is not a mode. It is an extra line a trade may add only on a job
they created (`jobs.created_by`), a job in a division they manage
(`users.managed_verticals`), or with the office's invoice-any-job grant
(`trade_details.invoiceAnyJob === true`). Being booked on the job does NOT
allow commission. The one rule list is `trade_invoice_extra_job_authority.ts`
(`booked_on_job` no longer passes a commission line);
`can_claim_commission` asks that same list.

`generate_trade_invoice` refuses a commission line that passes none of them,
before any write, with 403:

- only commission refused: `code: "commission_not_allowed"`, `jobs: []`,
  `commission_jobs: [<job numbers>]`, message "This invoice was not saved.
  Commission can only be claimed on a job you created. ..." Adding yourself to
  the job does not help, so the app must not offer it.
- a not-booked ordinary line too: `code: "extra_job_not_allowed"`, `jobs` the
  not-booked jobs, `commission_jobs` the refused commission jobs, and the
  message names both.

## `my_hours`

Every row in `assignments` and in `group_route_jobs` carries:

```json
{
  "invoice_mode": "group_work_order" | "work_order" | "hourly" | null,
  "invoice_mode_reason": "live_group_work_order" | "per_metre_trade" | "patio_job" | "fencing_job" | "other_job" | null,
  "can_claim_commission": true | false | null,
  "work_order_agreed_ex": 1850.5 | null,
  "job_work_order_id": "<uuid>" | null
}
```

and the reply carries `invoice_mode_unavailable: boolean`. When the trade, the
jobs or the group work orders cannot be read, my_hours still answers, every
row's three fields are `null` and `invoice_mode_unavailable` is `true` (logged
as `[ops-api] my_hours: invoice mode unreadable`). Null means not known; the
app must not guess a mode. The job work orders are read the same way: a
failed read (or two approved job work orders on one job) makes every field
null and `invoice_mode_unavailable` true.

## The agreed work order (Marnin, 12 Nov 2026)

A job whose `invoice_mode` is `work_order` and which has an APPROVED job work
order (`work_orders.kind = 'job'`, `status = 'approved'`, `agreed_labour_ex`
set) is billed as a work order at exactly that agreed labour.
`work_order_agreed_ex` (number, ex GST) and `job_work_order_id` carry it;
both are null otherwise (no approved job work order, a draft one, or a job
not invoiced as a work order, such as a group job, whose agreed labour is the
group's pot). They are on `my_hours` (the caller's own cards and group route
jobs) and `trade_invoice_job_modes`, and on no other trade feed.

`generate_trade_invoice` refuses, before anything is written, an invoice with
a work-order line (`row_type: 'work_order'`, named `wo_labour_lines`, or a
line typed `Work Order`) on such a job whose `wo_allocated` is not the agreed
figure within a cent, or a second work-order line on that job
(`workOrderAmountRefusal`, `trade_invoice_mode.ts`):

```json
HTTP 409
{ "ok": false, "success": false, "saved": false,
  "code": "work_order_amount_not_agreed",
  "jobs": [{ "job": "SWF-123", "job_id": "<uuid>", "agreed_ex": 1850.5, "billed_ex": 2000 }],
  "error": "Job SWF-123 has an agreed work order of $1,850.50. Bill it at that amount, or ask the office." }
```

The named labour lines on the row still come off it (the row's rate is the
agreed amount less labour, `_woNetMismatch`). Hourly lines on a fencing job
stay allowed (helpers). A failed read of the job work orders answers 503
`invoice_mode_unavailable` and saves nothing, never a guess. The weekly
work-order lane (server-built lines) and drafts are not checked.

## `GET ops-api?action=trade_invoice_job_modes&job_ids=<uuid>,<uuid>`

Trade JWT (on `OPS_API_PROFILE_SCOPED_JWT_ACTIONS`, both trade dispatch
lists, and the owner's read-only trade preview). 1 to 50 job ids,
comma-separated, deduplicated. Only jobs in the caller's company are decided.

```json
{
  "ok": true,
  "jobs": [
    { "job_id": "<uuid>", "invoice_mode": "work_order", "invoice_mode_reason": "fencing_job", "can_claim_commission": false,
      "work_order_agreed_ex": 1850.5, "job_work_order_id": "<uuid>" }
  ],
  "not_found": ["<uuid of a job not in your company>"]
}
```

Each job also carries `work_order_agreed_ex` and `job_work_order_id` (see
"The agreed work order" above).

Errors: 400 `job_ids_required` / `job_ids_invalid` / `too_many_job_ids`
(before any job is read), 405 for a non-GET, 503 `invoice_mode_unavailable`
when a read fails (never answered as `hourly`).

## Saved weekly draft: on by default

`users.trade_details.runningInvoiceDraft` is ON unless it is exactly `false`
(unset, `null` or anything else is on). One helper,
`runningInvoiceDraftEnabled` (`trade_invoice_running_draft.ts`), feeds both
`my_hours.running_invoice_draft` and the save gate (`running_draft_off`, 403,
only for an explicit `false`). Submit still works out GST, super and the
weekly deduction.

## `submit_trade_invoice` is retired

The old one-press weekly submit inserted the invoice straight as `approved`,
skipping the office's review. No live screen calls it (`trade.html`'s
`submitTradeHours` has no button). It now answers, before reading or writing
anything:

```json
HTTP 410
{ "ok": false, "success": false, "saved": false, "code": "use_weekly_invoice",
  "error": "Send your invoice from the Weekly Invoice in the Trade App." }
```

Trades send every invoice from the Weekly Invoice (`generate_trade_invoice`).

## Patio pay through the group

`assertPatioPaysThroughGroup` (`group_work_order.ts`) refuses ordinary hours
on a patio job only while `patio_pay_group_only_v1` AND `group_work_order_v1`
are both on: with groups off nobody can open or join one, so refusing hours
would leave a patio trade unpaid. A failed read of either switch refuses
(`group_work_order_unreadable`), never reads as off. The flag name lives in
`group_work_order.ts` only (`patio_auto_group.ts` re-exports it). Migration
`20261111170000_patio_pay_group_only_flag.sql` seeds the row switched off
with `ON CONFLICT DO NOTHING`, so production's existing enabled row is
untouched; its rollback deletes nothing for the same reason.
