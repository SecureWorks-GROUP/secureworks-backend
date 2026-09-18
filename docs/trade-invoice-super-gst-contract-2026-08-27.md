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
- `super_amount`: `gross_earned * super_rate`. Bookkeeper / SG remittance.
  Still 12%. The 2026-09-18 ruling does not reduce this figure.
- `worker_withhold`: `gross_earned * 0.06` (Captain 2026-09-18). Cash taken
  from the trade. Derived; not a stored column.
- `company_contribution`: `super_amount - worker_withhold` (the other 6%,
  residual so the split has no cent drift). Company cost, not taken from the
  trade. Derived; not a stored column.
- `net_pay`: `gross_earned - worker_withhold`, before GST. On $1,000 this is
  $940 (was $880 under the 2026-09-10 full carve-out).
- `company_total_out`: `net_pay + super_amount` (GST-exclusive). On $1,000
  this is $1,060 (was $1,000). Not `total_inc`.
- `gst_on`: the per-invoice choice.
- `gst`: `gross_earned * 0.10` when `gst_on`, otherwise zero.
- `trade_payable`: `net_pay + gst` (response-only convenience field).
- `total_inc`: `gross_earned + gst`. This stays the GST-inclusive contractor
  supply face, not company total out. Company cost and invoice face have
  diverged; callers that want cash payable use `trade_payable`, callers that
  want the bookkeeper super figure use `super_amount`, and callers that want
  company cash out use `net_pay + super_amount` (plus GST already inside
  `trade_payable` when GST is on).

Historical split-aware rows written under the 2026-09-10 full 12% carve-out
(`net_pay = gross_earned - super_amount`) remain valid and are not rewritten.

GST is 10% of gross earned once. It is not calculated on gross and then again
on super.

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
  "worker_withhold": 60,
  "company_contribution": 60,
  "net_pay": 940,
  "gst": 100,
  "trade_payable": 1040,
  "total_inc": 1100,
  "company_total_out": 1060
}
```

`get_trade_invoice`, `my_trade_invoices`, `my_invoices`,
`list_new_trade_invoices`, and `list_trade_invoices` return the persisted split
fields plus server-computed `trade_payable`. Historical invoices created before
the split expose `trade_payable: null`; partial or contradictory split data is
refused. The sibling UI should present: gross earned, SG remittance 12%, worker
withhold 6%, company contribution 6%, net pay, then GST and the cash payable
to the trade. It must send the explicit `gst_on` choice on every create/draft
request instead of deriving a second money path. Trade.html copy is owned by
the Trade desk; this backend remains the money authority.

## Xero ACCPAY mapping

Labour lines stay at the **submitted amounts**. A single minus line cannot
carry both the $120 bookkeeper remittance and the $940 cash payable on a
$1,000 invoice. The chosen shape is: **one worker-withhold minus line**
(6% of submitted total on new invoices) so the bill total equals cash payable
to the trade (`trade_payable` / OSCO payout). `super_amount` stays 12% on the
persisted invoice for the bookkeeper and the fund working paper. The company
contribution is company cost, not a Xero bill line. Super is paid to the fund
separately and is never added on top of labour. Lines are not scaled.

The super line description is human wording:

`Superannuation Guarantee 12.00% of submitted total`
`Submitted total $X. Super remittance $Y. Worker withhold $W. Company contribution $C. Amount payable $Z.`

The labour lines plus the negative withhold line sum to `net_pay`. Labour keeps the
invoice GST treatment (`INPUT` or `NONE`); the worker withhold is always
`NONE` so GST stays 10% of gross earned once and is not calculated on the
withholding. Both currently use account 306, the existing governed trade
ACCPAY account.

The canonical audit PDF uses the same numbers: submitted lines unchanged, one
worker-withhold minus line, header Submitted total / Super 12% remittance /
Amount payable agreeing with TOTAL. That PDF is attached to the DRAFT. If the trade also sent `pdf_base64`,
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

Apply `20260827112928_trade_invoice_super_gst_split.sql` and
`20260918120000_trade_invoice_super_payable_split.sql` before the matching
`ops-api`. The insert trigger requires the full split for every new row, the
CHECK accepts the 2026-09-18 6% withhold *or* the historical 12% carve-out so
existing rows stay updatable, and pre-cutover NULL rows remain visibly null
rather than fabricating historical withholding.
