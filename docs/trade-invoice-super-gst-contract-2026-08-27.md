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
are omitted, the API returns `GST_CHOICE_REQUIRED` and creates nothing. The
stored profile value is not an invoice choice and is never used as a fallback.

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

`get_trade_invoice`, `my_trade_invoices`, `my_invoices`,
`list_new_trade_invoices`, and `list_trade_invoices` return the persisted split
fields plus server-computed `trade_payable`. Historical invoices created before
the split expose `trade_payable: null`; partial or contradictory split data is
refused. The sibling UI should present: gross earned, less super, net pay, then
GST and the cash payable to the trade. It must send the explicit `gst_on` choice
on every create/draft request instead of deriving a second money path.

## Xero ACCPAY mapping

Labour lines stay at the **submitted amounts**. Super is **one** 12%-of-submitted-total
**minus** line so the bill total equals cash payable to the trade
(`trade_payable` / OSCO payout). Super is paid to the fund separately and
is never added on top of labour. Lines are not scaled to 88%.

The super line description is human wording:

`Superannuation Guarantee 12.00% of submitted total`
`Submitted total $X. Super $Y. Amount payable $Z.`

The labour lines plus the negative super line sum to `net_pay`. Labour keeps the
invoice GST treatment (`INPUT` or `NONE`); the super withholding is always
`NONE` so GST stays 10% of gross earned once and is not calculated on the
withholding. Both currently use account 306, the existing governed trade
ACCPAY account.

The canonical audit PDF uses the same numbers: submitted lines unchanged, one
super line, header Submitted total / Super 12% / Amount payable agreeing with
TOTAL. That PDF is attached to the DRAFT. If the trade also sent `pdf_base64`,
that file is attached too; attach failure is not treated as success.

The live Israel draft `4fb56498-14a9-4204-989a-38a92b0d8ba5` (28 Aug 2026) is
the pre-fix shape: labour already netted, super added, no PDF, machine wording.
This generator change applies to **new** submissions only and does not rewrite
that draft.

The same builder is used by automatic generation, legacy submission, work-order
submission, and the ops retry push. A legacy row without the persisted split is
refused by the retry path rather than silently creating a gross-only Xero bill.

All create paths finish line construction, money calculation, split validation,
and local invoice/line persistence before resolving or creating a Xero supplier
contact. Once Xero returns a bill ID, that identity is checkpointed locally in a
recoverable `approved` state before the returned lines are reconciled. A mixed
old/new deployment that returns a gross-only bill is therefore refused without
losing the Xero identity; only a reconciled response advances the row to
`pushed_to_xero`.

The ops retry validates `trade_invoice_lines.line_total_ex` against stored
hours/rate or quantity/rate. Historical work-order lines that predate those
quantity/rate facts retry as one line from the validated extended amount; the
system does not invent hours, and null/undefined/empty extended amounts are
refused before JavaScript numeric coercion can turn them into zero. New
work-order and per-metre lines persist their reconstructable quantity/rate.

Every create and office-retry route reconstructs the same Xero idempotency key
from the persisted `trade_invoices.id`. A checkpointed external identity is
reconciled against that exact Xero bill and blocks invoice rejection or
deletion. Trade deletion is limited to unsubmitted `draft` rows so a retryable
invoice cannot lose its operation key; this contract does not invent a voiding
path.

Draft autosave and submission build a complete replacement before touching the
prior draft. `replace_trade_invoice_draft_v1` then atomically transfers only
the replacement's assignment locks, releases any other stale prior-draft locks,
and deletes the prior header only when it is still a same-user draft with no
Xero identity. A failed guard rolls the entire transfer/delete back and the new
replacement is cleaned up, preserving the prior draft.

Apply `20260827112928_trade_invoice_super_gst_split.sql` before the matching
`ops-api`. The insert trigger requires the full split for every new row, and
the migration owns the guarded replacement RPC, while allowing pre-cutover rows
to remain visibly null rather than fabricating historical withholding.
