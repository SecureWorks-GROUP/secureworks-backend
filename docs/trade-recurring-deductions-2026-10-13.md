# Trade recurring deductions (13 Oct 2026)

Owner's ask, 13 Oct 2026: one trade hires a ute from us, so each week the hire
comes off what we pay him. $100 for the invoice week starting Monday
12 Oct 2026, $200 for every invoice week from Monday 19 Oct 2026.

This is the back end. The trade app and ops screens need a paired change in
`secureworks-ux` to show the line (see "What the screens need").

- Rule owner: `supabase/functions/ops-api/trade_invoice_recurring_deduction.ts`
  (which invoice carries a deduction)
- Money owner: `supabase/functions/ops-api/trade_invoice_money.ts` (the payable
  and the Xero line)
- Migration: `supabase/migrations/20261013143700_trade_recurring_deductions.sql`
- Tests: `supabase/functions/ops-api/trade_invoice_recurring_deduction_test.ts`,
  `supabase/tests/migration-contracts/20261013143700_trade_recurring_deductions/`

## The rule

- The deduction is data, in table `trade_recurring_deductions`: trade
  (`user_id`), `label`, `amount`, `first_week_start`, optional
  `last_week_start`, `active`. No amount lives in code.
- Only an invoice with an invoice week (`week_start`) carries one: the weekly
  invoice (`generate_trade_invoice` with `week_start`, `submit_trade_invoice`)
  and its draft (`save_trade_invoice_draft` with `week_start`). A single
  work-order invoice (`submit_work_order_invoice`) and an invoice submitted
  with no week carry none.
- The week is the invoice's own `week_start`, never the day it was submitted.
  An invoice for a week before the row's first week carries none.
- Once per invoice week. When another live invoice of the same trade and
  `week_start` already carries it, this one carries none and says so. A draft,
  and an invoice the office rejected, are released: the invoice that replaces
  them carries it once. A partial unique index is the guard under the code.
- Never a negative invoice. When the amount payable (net pay + GST) is less
  than the deduction, nothing is refused and nothing is taken: the invoice is
  saved and paid in full and is marked for the office with the reason. A
  deduction equal to the amount payable is taken and the invoice pays $0.
- Every other trade is untouched: with no row for them, no figure, field or
  stored column of their invoices changes.

## The money

The deduction is not a line of the trade's work and is not inside gross earned.
It comes off the amount payable after super and GST:

```
trade_payable = net_pay + gst - recurring_deduction.amount
```

So the trade is paid exactly the deduction less, with GST on or off. Gross
earned, super, GST, `subtotal_ex` and `total_inc` are what they would be
without it, and the invoice's lines still sum to `subtotal_ex`.

Worked example, 8 hours at $50, this week:

| | GST off | GST on |
| --- | --- | --- |
| Gross earned | $400.00 | $400.00 |
| Worker super withheld (6%) | -$24.00 | -$24.00 |
| GST | $0.00 | $40.00 |
| Payable before the deduction | $376.00 | $416.00 |
| Ute hire | -$100.00 | -$100.00 |
| **Paid** | **$276.00** | **$316.00** |

## What is stored

On `trade_invoices` (all NULL on an invoice that carries none):

| Column | Meaning |
| --- | --- |
| `recurring_deduction_id` | the rule row the invoice carries |
| `recurring_deduction_label` | the label as it stood when the invoice was saved |
| `recurring_deduction_amount` | dollars taken off the amount payable |
| `recurring_deduction_note` | when a rule covered the week but was not taken, the plain reason |

A CHECK keeps the first three all set or all NULL, only on an invoice with a
week, and never above `net_pay + gst`.

## What the reads answer

Added only when the invoice carries a deduction; an invoice with none reads
exactly as before.

| Read | What it carries |
| --- | --- |
| `my_invoices`, `my_trade_invoices`, `get_trade_invoice`, `list_trade_invoices`, `list_new_trade_invoices` | `recurring_deduction: { id, label, amount }`, `payable_before_deduction`, and `trade_payable` already reduced. The four stored columns ride along. |
| `my_money` | each invoice row's `trade_payable`, `payable` and `outstanding` are the reduced figure, with `recurring_deduction: { label, amount }` |
| `generate_trade_invoice`, `submit_trade_invoice`, `save_trade_invoice_draft` responses | the same two keys, the reduced `trade_payable`, and `recurring_deduction_week` |
| `my_hours` | `recurring_deduction_week`, so the label and amount show before he submits |
| `generate_trade_invoice` 409 `WEEK_ALREADY_INVOICED` | the live invoice's reduced `trade_payable` and `recurring_deduction: { label, amount }` |

`recurring_deduction_week` is `{ label, amount, week_start, applied, outcome, note }`
and is present whenever a rule covers the trade and week. `outcome` is
`applied`, `already_taken` or `payable_below_deduction`; `note` is the reason
when it was not taken. In `my_hours` the figures are a preview of clocked
hours, so the deduction is taken off that preview only when the preview covers
it; `label` and `amount` are what comes off at submit.

A rule read that fails stops a submit or a draft save (nothing is written); it
never fails `my_hours`, which then shows no deduction.

## Xero

The bill is still the trade's ACCPAY draft, created at submit. The deduction
is its own line on that bill, after the super line:

- Description: `Weekly deduction - <label>` and one sentence with the amount.
- Quantity 1, unit amount minus the deduction, TaxType `NONE`.
- Account: the trade bill's own account (306) unless
  `TRADE_RECURRING_DEDUCTION_XERO_ACCOUNT_CODE` names another. No other
  mapping moves.

So the bill total is the reduced figure. This nets a hire charge against a
supplier bill. Whether the hire should carry GST, and which account it belongs
on, is the bookkeeper's call on the draft bill.

The audit PDF attached to the bill shows the line and the cash paid. The PDF
the trade app builds itself does not, until the app is changed.

## What the screens need

Not built here.

Trade app (`trade.html`):

- It works out "You get" from `amount_payable` / `net_pay` plus GST. Where it
  shows an invoice (the submit confirmation, Invoice history, the invoice
  detail, the Pay tab preview and the PDF it builds), when
  `recurring_deduction` is present it should show a row with
  `recurring_deduction.label` and minus `recurring_deduction.amount`, and show
  `trade_payable` as the amount paid.
- Before submit, on the Weekly Invoice screen, when `my_hours` or the
  `save_trade_invoice_draft` response carries `recurring_deduction_week`, show
  its `label` and `amount` as what comes off this week, and its `note` when
  `applied` is false.
- My Money needs no change: its rows already use the server's payable.

Ops screen (`ops.html`, Trade Bills): the total column shows `total_inc`
(gross plus GST) for every trade. To show the reduced figure it should show
`trade_payable`, and the `recurring_deduction` label and amount beside it. It
shows `query_note` only on invoices pending review, so a "not taken" reason is
best read from `recurring_deduction_note`.

## Changing or ending a deduction

No deploy. Edit the rows (service role only):

- End it: set `active = false`, or set `last_week_start` to the last Monday it
  applies to.
- Change the amount from a week: add a row with that `first_week_start`.
  Where two active rows cover a week, the later `first_week_start` wins.
- Do not delete a row an invoice carries (the database refuses).

Invoices already saved keep what they carried.
