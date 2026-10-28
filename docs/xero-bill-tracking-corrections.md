# Posted supplier bill tracking corrections

`POST ops-api?action=xero_correct_bill_tracking` is a separate, tracking-only
door for AUTHORISED/PAID ACCPAY bills. Existing draft creation/editing remains
unchanged. No payment, approval, void, tax, amount, account or date edit is accepted.

The caller must be a dedicated server-secret caller or an owner/admin JWT for
the configured organisation. Public keys, routine callers and other staff roles
are refused. The expected Xero tenant UUID must match the live connection.

Request: `{mode:"preview"|"apply", tenant_id, bills:[{xero_invoice_id,
expected_snapshot_hash?, changes:[{line_item_id,tracking_category_id,
tracking_option_id}]}], confirm?:true}`. Maximum ten bills, processed serially.
Preview accepts empty changes to discover complete raw lines and their immutable
Xero IDs. Preview the intended changes before apply; apply requires the snapshot
hash and explicit confirmation. Targets must be active tracking options in the
connected tenant. All original line IDs and financial fields are preserved.

Apply re-reads before submission, then reads Xero again to verify every original
invoice field apart from tracking and provider update metadata. The first
conflict, provider error, uncertain response or verification difference stops the
batch. Results retain per-bill states and `not_attempted` IDs; a failed batch is
never reported as fully applied. There is no automatic retry. On `unknown`, read
the invoice and compare it with the saved preview before preparing another change.

## Limits and release proof

Xero offers no transactional compare-and-swap for these updates. The local guard
does not serialize separate function isolates or humans editing Xero. Use one
writer and a quiet editing window. No durable operation ledger is added here;
save exact previews and returned receipts in the bookkeeping evidence record.
The provider idempotency key is short-lived, not an accounting audit ledger.

Local tests use provider-shaped fixtures. They establish validation, preservation,
conflict refusal, readback checks and no-retry behavior, not live Xero semantics.
Before broad production use, validate one authorised correction end to end,
including preserved payment allocations, tax, total and project association.
Do not create synthetic bills in production. Locked periods remain provider-held.
This door does not reconcile bank statements or resolve duplicate payables.
Bills with nonzero rounding adjustments are rejected before submission because
resending lines can recalculate their totals. Invoice reads and writes request
`unitdp=4` to retain four-decimal unit prices. Both provider update timestamp
representations are excluded from comparison; financial fields remain checked.

Verification: `deno test --allow-env supabase/functions/ops-api/xero_bill_tracking_corrections_test.ts supabase/functions/ops-api/xero_accpay_books_test.ts`.
