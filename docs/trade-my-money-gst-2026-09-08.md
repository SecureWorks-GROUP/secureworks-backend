# Trade "My money" + GST from the profile (2026-09-08)

Marnin: trades (Hugo first) must see the invoices they send us, month and
year-to-date totals, what Xero has reconciled as paid, what is still owed, and
how much is super. GST must come from the trade's profile, not the phone.

## Paid state from Xero

- `trade_invoices` gains `paid_at date`, `amount_paid numeric(12,2)`,
  `xero_bill_status text` (migration `20260908120000_trade_invoices_paid_from_xero.sql`),
  backfilled from `xero_invoices` on `xero_bill_id`. Rows whose bill is PAID move
  to our `paid` status. On 2026-09-08 that was 154 of 199 pushed invoices; none
  had ever been marked paid.
- Root cause: xero-sync gated trade bills on Reference text (`TRADE-` / `WE date`)
  that no invoice uses (real refs look like `Hugo | SW-INV-H-260904-026 | ...`),
  and queried a `xero_invoice_id` column trade_invoices does not have.
- `xero-sync/trade_bill_status.ts` (`tradeBillStatusPatch`) now mirrors every
  ACCPAY bill onto its trade invoice by `xero_bill_id`: status, AmountPaid,
  FullyPaidOnDate; `status = 'paid'` only when Xero says PAID and our row is not
  released (draft / failed / ops-reject).

## `my_money` (trade JWT, read-only)

`?months=12&today=YYYY-MM-DD` (today is for tests). Returns
`{ profile: { name, abn, gst_registered, invoice_type, xero_linked }, month, fytd, all_time, months[], invoices[] }`.
Totals carry `invoices, gross_earned, super_amount, gst, payable, paid_total, outstanding, figures_incomplete`.
Financial year starts 1 July. Voided / deleted bills and released rows are
listed but never counted. A legacy row whose super/GST split fails to reconcile
is flagged `figures_ok:false` and counts its cash figures only; the old list
endpoint 500'd the whole history on one such row (`presentTradeInvoiceSafe`).
Pure aggregation in `ops-api/trade_money.ts` (`trade_money_test.ts`).

## Profile

- `update_trade_profile` MERGES `users.trade_details` (only body keys change) and
  accepts an explicit `gstRegistered`; returns `{ profile }`. The old handler
  replaced the whole jsonb, so a bank-details save from a phone that did not
  know the flag wiped it.
- `my_trade_invoices`: limit 100, per-row safe presenter, `paid`, `paid_at`,
  `amount_paid`, `xero_bill_status` on each row.
