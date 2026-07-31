# WO labour holder-invoice evidence

Date: 2026-07-31 (Australia/Perth)

## Captain ruling implemented

`generate_trade_invoice` no longer creates a `pending_ops_review` payout
invoice for a named labourer. It still persists `wo_allocated`,
`wo_labour_deduction`, and cleaned `wo_labour_lines` on the holder's
`trade_invoice_lines` row. Unnamed or incomplete labour lines still update the
holder's office note and emit `trade.wo_labour_unresolved`.

The server-owned holder description for the worked example is:

```text
Work order $559.50.
Less labour: Tendo 11.5h x $25 = $287.50.
Total labour deducted $287.50.
Net payable to holder $272.00.
Named crew bill SecureWorks Group directly; office to check their invoices against this breakdown.
```

The newline-separated description is also placed in the Xero `LineItems[].Description`
for the holder bill. The production PDF path is:

1. `generate_trade_invoice` sends that description in the ACCPAY
   `xeroPost('/Invoices', ...)` payload.
2. `get_invoice_pdf` fetches Xero's rendered PDF with
   `GET /Invoices/{xero_invoice_id}` and `Accept: application/pdf`.

The local rendered proof is [wo-labour-holder-invoice-breakdown-2026-07-31.png](wo-labour-holder-invoice-breakdown-2026-07-31.png).
It renders the exact server-produced Xero line-description payload without
creating or mutating a production invoice.

## Read-only production audit

Query run against the production Supabase Management API using the read-only
database query endpoint. Window start was `2026-07-30T16:00:00Z`, which is
2026-07-31 00:00 in Australia/Perth. The query selected `pending_ops_review`
`trade_invoices` with fan-out provenance in `notes`, `query_note`, or a
`trade_invoice_lines.description` containing `WO labour`.

Result: **0 rows**.

List for the PR body: **empty**. There are no fan-out payout invoices from the
deploy window for the office to void manually.

## Code and test anchors

- Breakdown builder: `supabase/functions/ops-api/wo_labour_fanout.ts`
- Holder persistence and Xero payload: `supabase/functions/ops-api/index.ts`
- Regression coverage: `supabase/functions/ops-api/wo_labour_breakdown_test.ts`
- Xero PDF route: `get_invoice_pdf` in `supabase/functions/ops-api/index.ts`

Validation:

- `deno fmt --check` passed for the changed TypeScript files.
- 10/10 WO labour breakdown tests passed.
- 4/4 trade Xero account-routing tests passed.
- The adjacent `index_deno_type_baseline_test.ts` requires `--allow-env` and
  then exits 139 in this local Deno 2.7.14 environment; this is a validation
  environment failure, not a reported assertion.
