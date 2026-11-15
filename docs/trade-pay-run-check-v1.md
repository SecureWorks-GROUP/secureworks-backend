# Trade pay-run check, v1 (`trade-pay-check-v1`)

Owner: CFO thread "Integrate trade app redesign end to end", 15 Nov 2026.
Migration: `supabase/migrations/20261115140000_trade_pay_run_check.sql`.
Door: `ops-api?action=trade_pay_run_check` (`ops-api/trade_pay_run_check.ts`).

## What it is for

Every week the bookkeeper approves the trades' bills in Xero one at a time.
Nothing on a trade invoice is re-keyed, but nothing tells her which bills are
safe to approve either. This check reads every live trade invoice in the pay
weeks and marks each one **clean** or **stopped**, with a plain reason for each
stop. She approves the clean bills in one batch and looks only at the stopped
ones.

It only reads. It writes nothing, never calls Xero, never approves or pays a
bill, and changes no invoice. Approving and paying stay with a person.

## The call

`GET ops-api?action=trade_pay_run_check&as_of=YYYY-MM-DD&weeks=N`

| Parameter | Default | Rule |
|---|---|---|
| `as_of` | today in Perth | A real date, `YYYY-MM-DD`, or 400. |
| `weeks` | 2 | A whole number from 1 to 26, or 400. |

The window is the `weeks` Monday-to-Sunday pay weeks ending with the week that
holds `as_of`. An invoice is in it when its `week_start` is, and its status is
not `draft` or `ops-reject`.

**Who may call it:** staff only (admin, owner, ops_manager) or the server key.
It is in no trade, routine, lead-installer or agent-read list, because it names
trades and their pay. **Org:** always the caller's. A staff session reads its
profile's org; a session with no org is a 403, never every org's invoices. The
server key reads the server org.

**Failure:** an answer that is missing, errored, or not this rule is a 503
("The pay-run check could not be read"). It is never shown as an empty list,
which would read as "every bill clean".

## The answer

```json
{
  "ok": true,
  "check": {
    "rule": "trade-pay-check-v1",
    "as_of": "2026-11-15", "weeks": 2,
    "from_week": "2026-11-02", "to_week": "2026-11-09",
    "counts": { "invoices": 17, "clean": 7, "stopped": 10,
                "to_pay": 15, "to_pay_clean": 6, "to_pay_stopped": 9 },
    "invoices": [{
      "invoice_id": "…", "invoice_number": "SW-INV-…", "user_id": "…",
      "trade_name": "…", "week_start": "2026-11-09", "status": "pushed_to_xero",
      "xero_bill_id": "…", "xero_bill_status": "DRAFT", "xero_bill_total": 1000,
      "invoice_pays": 1000, "paid": false, "verdict": "stopped",
      "stops": [{ "code": "rate_above_office",
                  "text": "The rate on SWF-1 is $60.00 an hour, above the office rate of $50.00." }],
      "notes": []
    }]
  }
}
```

- `invoice_pays` is what the invoice says the bill should be: `net_pay`, plus
  GST when `gst_on`, less the weekly deduction, plus the lines the office added
  in Xero (`xero_adjustments_ex`).
- `paid` is true when the invoice status is `paid` or its Xero bill is `PAID`.
  `to_pay*` counts the invoices that are not paid.
- Order: not paid first, then stopped first, then newest week, then trade name.

## Stops: do not approve until a person has looked

| Code | When |
|---|---|
| `not_in_xero` | The invoice has no Xero bill. |
| `xero_bill_voided` | Its Xero bill is VOIDED or DELETED. |
| `xero_amount_differs` | The Xero bill total is more than 5 cents from `invoice_pays`. |
| `work_order_over_agreed` | The agreed-amount lines (`work order`, `group share`) on one job work order, across every live invoice of every trade and any week, add up to more than `work_orders.agreed_labour_ex`. Every invoice holding such a line is stopped. |
| `rate_above_office` | An hourly labour line's rate is above the trade's office rate on that day (`trade_rates`) and is not the rate on the trade's booking for that job (`job_assignments.hourly_rate`). Trades set their own rate on each job (owner, 15 Nov 2026), so a rate at or below the office rate passes. With no office rate on file the rate is not judged. |
| `line_on_no_job` | A labour or agreed-amount line has no job. |
| `second_invoice_same_week` | Another live invoice of the same source from the same trade for the same week. |

## Notes: shown, never stop a bill

| Code | When |
|---|---|
| `hours_over_expected` | The line already carries flag `hours_over_baseline`. |
| `labour_over_agreed` | All labour on a job work order (agreed-amount lines plus hourly, fencing, patio and decking lines, every trade) is above the agreed amount, while the agreed-amount lines alone are not. |
| `day_not_booked` | An hourly line's day has no non-cancelled booking of that trade on that job. A note, not a stop: on 15 Nov 2026, 43 of 88 time lines in ten weeks were on days with no booking, so bookings are not reliable enough to stop pay on. |
| `changed_in_xero` | The office added lines to the bill in Xero. |

## Measured before release

Rehearsed read-only on production on 15 Nov 2026 over 11 weeks: 103 invoices,
97 clean, 6 stopped, every stop a real problem. By stop (an invoice can carry
more than one): not in Xero 1, Xero total differs 2, second invoice in the same
week 2, work order over the agreed amount 1, rate above the office rate 2. 46
invoices carried notes. Of the 5 invoices not yet paid, 4 were clean.

## Not in v1

- Approving clean bills in Xero automatically. Revisit only after eight weeks in
  which every bill this check marked clean was right, and with the owner's word.
- Comparing hours with clock times: clocking is almost unused (7 clock-ons ever
  on 15 Nov 2026).
- Loan repayments as an automatic weekly deduction (owner, 15 Nov 2026: leave
  for now). They show as `changed_in_xero` notes.
