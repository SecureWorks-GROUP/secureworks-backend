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
holds `as_of`. An invoice is in it when its pay week is, and its status is not
`draft` or `ops-reject`. The pay week is `week_start`; a crew share invoice has
none, so it counts in the Monday week (Perth) it was sent (`submitted_at`, else
`created_at`). The answer's `week_start` is that pay week.

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
- `clean_with_notes` counts the clean invoices that carry a note. `undated`
  counts the org's live invoices with no `week_start`, `submitted_at` or
  `created_at`: no window can hold them, so a number above 0 means some bills
  were not checked. The door refuses (503) an answer whose counts do not add
  up, or that marks a bill clean while it carries a stop.
- Order: not paid first, then stopped first, then newest week, then trade name.

## Stops: do not approve until a person has looked

| Code | When |
|---|---|
| `invoice_not_approved` | The invoice's status is not `approved`, `pushed_to_xero` or `paid` (for example `pending_acknowledgment`, `queried` or `failed`). |
| `lines_differ` | The invoice's lines do not add up to its `subtotal_ex` (within 5 cents), or it has no lines. |
| `not_in_xero` | The invoice has no Xero bill. |
| `xero_bill_voided` | Its Xero bill is VOIDED or DELETED. |
| `xero_amount_differs` | The Xero bill total is more than 5 cents from `invoice_pays`. |
| `xero_total_not_read` | The invoice has a Xero bill whose total has not been read yet, so it cannot be compared. |
| `xero_changed_by_hand` | The bill was changed in Xero to pay the trade more (`xero_adjustments_ex` above 0), any office line on it adds money (so a plus and a minus that cancel out still stop), or one of the invoice's own lines was edited in Xero (a `xero_adjustment_lines` entry of kind `unexplained`). `invoice_pays` adds back every Xero change, so without this stop a changed bill would always match. |
| `work_order_over_agreed` | The `work order` lines on one job work order, across every live invoice of every trade and any week (bills voided or deleted in Xero left out), add up to more than `work_orders.agreed_labour_ex`. Every invoice holding such a line is stopped. Crew shares (`group share`) are left out: each share carries 12% super inside it, so the shares add up to more than the agreed labour, and the group work order's own release already holds the shares until they add up to its pool. |
| `work_order_not_agreed` | A `work order` line whose work order has no agreed amount on file, so nothing can say the amount is right. |
| `rate_above_office` | An hourly labour line's rate (`labour`, `general labour`, `make safe`; `hourly_rate`, else `unit_rate`, which most older lines carry instead) is above the trade's office rate on that day (`trade_rates`) and is not the rate on the trade's live (not cancelled) booking for that job (`job_assignments.hourly_rate`). Trades set their own rate on each job (owner, 15 Nov 2026), so a rate at or below the office rate passes. With no office rate on file the rate is not judged. |
| `line_on_no_job` | A labour, make safe or agreed-amount line has no job. |
| `second_invoice_same_week` | Another live invoice of the same source from the same trade for the same week, or, for a crew share, another live invoice from the same trade holding a share of the same group work order (`group_share_id`, else `job_work_order_id`). |

## Notes: shown, never stop a bill

| Code | When |
|---|---|
| `hours_over_expected` | The line already carries flag `hours_over_baseline`. |
| `labour_over_agreed` | All labour on a job work order (agreed-amount lines plus hourly, fencing, patio and decking lines, every trade) is above the agreed amount, while the agreed-amount lines alone are not. |
| `day_not_booked` | An hourly or make safe line's day has no non-cancelled booking of that trade on that job. A note, not a stop: on 15 Nov 2026, 43 of 88 time lines in ten weeks were on days with no booking, so bookings are not reliable enough to stop pay on. |
| `changed_in_xero` | The office took money off the bill in Xero (a loan repayment, say). A change that pays more is a stop. |

## Measured before release

Rehearsed read-only on production on 15 Nov 2026 over 11 weeks (the final
body, after the second review): 106 invoices, 3 of them crew shares, none
undated. 60 clean (25 of them with notes), 46 stopped. Invoices by stop (an
invoice can carry more than one): no agreed amount on the work order 24, rate
above the office rate 20, Xero total differs 2, second invoice in the same week
2, not approved 1, not in Xero 1, work order over the agreed amount 1. No
invoice's lines differed from its subtotal, no crew share was invoiced twice
and no bill was changed by hand in Xero. Of the 5 invoices not yet paid, 3 were
clean.

What the numbers say:

- 23 invoices are stopped only because their work order has no agreed amount
  on file. Putting an agreed amount on every work order turns those clean.
- The rate stops are mostly older lines that carry the rate in `unit_rate`.
  One trade billed $80.00 an hour on fencing jobs against $35.00 on file, and
  several bill $45.00 to $50.00 against $40.00. Under the owner's rule these are
  right to stop. If those rates are agreed, raising the office rate on file
  clears them.
- One line billed $710.00 an hour (SWF-261281): a lump sum typed as hours.
- Leaving the crew shares out of the agreed sums took the work order over
  agreed stops from 4 invoices to 1: the 3 shares on SWP-261247 add up to
  $2,428.57 against $2,160.00 agreed, which is the 12% super inside each share.

## Not in v1

- Approving clean bills in Xero automatically. Revisit only after eight weeks in
  which every bill this check marked clean was right, and with the owner's word.
- Comparing hours with clock times: clocking is almost unused (7 clock-ons ever
  on 15 Nov 2026).
- Loan repayments as an automatic weekly deduction (owner, 15 Nov 2026: leave
  for now). They show as `changed_in_xero` notes.
