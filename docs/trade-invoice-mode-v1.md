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
  "can_claim_commission": true | false | null
}
```

and the reply carries `invoice_mode_unavailable: boolean`. When the trade, the
jobs or the group work orders cannot be read, my_hours still answers, every
row's three fields are `null` and `invoice_mode_unavailable` is `true` (logged
as `[ops-api] my_hours: invoice mode unreadable`). Null means not known; the
app must not guess a mode.

## `GET ops-api?action=trade_invoice_job_modes&job_ids=<uuid>,<uuid>`

Trade JWT (on `OPS_API_PROFILE_SCOPED_JWT_ACTIONS`, both trade dispatch
lists, and the owner's read-only trade preview). 1 to 50 job ids,
comma-separated, deduplicated. Only jobs in the caller's company are decided.

```json
{
  "ok": true,
  "jobs": [
    { "job_id": "<uuid>", "invoice_mode": "work_order", "invoice_mode_reason": "fencing_job", "can_claim_commission": false }
  ],
  "not_found": ["<uuid of a job not in your company>"]
}
```

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
