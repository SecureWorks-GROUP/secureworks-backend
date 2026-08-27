# Trade invoice super and GST contract

Status: implementation contract for Captain review; no production mutation or
Xero bill push was performed as part of this change.

## Statutory rate source

Checked 27 August 2026 against the Australian Taxation Office
[Super guarantee percentage table](https://www.ato.gov.au/tax-rates-and-codes/key-superannuation-rates-and-thresholds/super-guarantee).
The table gives the general Superannuation Guarantee rate as 12.00% from
1 July 2025, including 1 July 2026 to 30 June 2027 and 1 July 2027 onwards.

`trade_invoice_money.ts` owns the dated rate schedule. Invoice creation fails
closed when the earnings date is outside that schedule; callers must not guess
or substitute zero.

## Money definitions

All values are rounded to cents:

- `gross_earned`: job lines before GST and before the super split.
- `super_rate`: resolved statutory rate snapshot (`0.12`).
- `super_amount`: `gross_earned * super_rate`.
- `net_pay`: `gross_earned - super_amount`, before GST.
- `gst_on`: the per-invoice choice.
- `gst`: `gross_earned * 0.10` when `gst_on`, otherwise zero.
- `trade_payable`: `net_pay + gst` (response-only convenience field).
- `total_inc`: `gross_earned + gst`, which equals the net earnings and super
  portions plus optional GST.

Super reallocates gross earned; it is not added on top. GST is therefore 10%
of gross earned once. It is not calculated on gross and then again on super.

## API contract for the trade UI

Preferred request field for `generate_trade_invoice`, `submit_trade_invoice`,
`save_trade_invoice_draft`, and `submit_work_order_invoice`:

```json
{ "gst_on": true }
```

`gst_registered` and the existing boolean `gst` are accepted aliases. When all
are omitted, the boolean `users.trade_details.gstRegistered` profile value is
the compatibility fallback. If neither the invoice nor the profile provides a
real boolean choice, the API returns `GST_CHOICE_REQUIRED` and creates nothing.

Create responses expose:

```json
{
  "gst_on": true,
  "gross_earned": 1000,
  "super_rate": 0.12,
  "super_amount": 120,
  "net_pay": 880,
  "gst": 100,
  "trade_payable": 980,
  "total_inc": 1100
}
```

`get_trade_invoice`, `my_trade_invoices`, and the ops list return the persisted
split fields. The sibling UI should present: gross earned, less super, net pay,
then GST and the cash payable to the trade. It must send the explicit `gst_on`
choice on every create/draft request instead of deriving a second money path.

## Xero ACCPAY mapping

Every gross job line is converted into its proportional net-earnings portion,
then one line is appended:

`Superannuation Guarantee (12.00%) | Gross earned $... | Amount reserved for super`

The net lines sum to `net_pay`; the super line equals `super_amount`; together
they sum to `gross_earned`. Both portions keep the same Xero GST treatment, so
`INPUT` produces exactly 10% GST over the original gross supply and `NONE`
produces zero. Both currently use account 306, the existing governed trade
ACCPAY account; the distinct description and amount give ops the worked-out
super figure without inventing an unapproved chart-of-accounts code.

The same builder is used by automatic generation, legacy submission, work-order
submission, and the ops retry push. A legacy row without the persisted split is
refused by the retry path rather than silently creating a gross-only Xero bill.

Apply `20260827112928_trade_invoice_super_gst_split.sql` before the matching
`ops-api`. The insert trigger requires the full split for every new row while
allowing pre-cutover rows to remain visibly null rather than fabricating
historical withholding.
