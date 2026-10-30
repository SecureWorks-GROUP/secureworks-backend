# Posted-record line coding corrections

`POST ops-api?action=xero_correct_line_coding` corrects a line's Business Unit
tracking and/or its account code on one posted Xero record. It covers:
- an AUTHORISED or PAID invoice: an ACCPAY bill or an ACCREC sales invoice;
- an AUTHORISED or PAID credit note: ACCPAYCREDIT or ACCRECCREDIT;
- an AUTHORISED spend or receive money bank transaction: SPEND or RECEIVE.

It cannot change amounts, tax, dates, contacts, status, payments, allocations
or reconciliation. The older `xero_correct_bill_tracking` door is unchanged.

Callers are the same as X15: a dedicated server-secret caller, or an
owner/admin JWT for the configured organisation. The expected tenant must
match the live connection.

Request:
`{mode:"preview"|"apply", tenant_id, confirm?:true, record:{kind:"invoice"|"credit_note"|"bank_transaction", id, expected_snapshot_hash?, changes:[{line_item_id, tracking_category_id?, tracking_option_id?, account_code?}]}}`.

Rules for the request:
- Exactly one record per request.
- A change carries a tracking pair (both IDs), an account code, or both. Each line takes one change.
- Preview takes 0–100 changes. Empty changes is discovery: it returns the raw lines and their LineItemIDs. Preview never accepts `confirm` or a hash.
- Apply takes 1–100 changes, `confirm:true`, and the hash from a preview of the same changes.
- The hash binds the tenant, the kind, the full record snapshot and the sorted change list.

Rules for a recode:
- The target account must be active, not a system account and not a bank account.
- It must have the same class as the line's current account: EXPENSE to EXPENSE, or REVENUE to REVENUE. A recode never moves money to the balance sheet or across the P&L.
- The line keeps its TaxType and TaxAmount. Tracking targets must be active Business Unit options.

The preview and every receipt carry a `summary` for each requested line. It gives the description, the amount, and the account and Business Unit before and after.

## How apply checks its work

Before writing, apply re-reads the record and requires the hash to match again.

It then sends one POST with the full line list. For a bank transaction the POST also carries only the bank account ID and the contact ID, never `IsReconciled`, `Status` or the date.

It then reads the record again and compares every field except tracking and the account on the recoded lines. On a bank transaction that includes `IsReconciled`, the bank account, the total and the date. If the record has payments allocated, Xero returns its standard warning. When the readback is clean, that outcome is `verified_with_provider_warning` and counts as success.

| State | Meaning |
|---|---|
| `preview` | Nothing written |
| `verified` | Written, and the readback matches |
| `verified_with_provider_warning` | Written with Xero's standard warning, and the readback matches |
| `unchanged` | The record already had the requested coding |
| `rejected` | Refused before any write |
| `refused_unchanged` | Xero answered with a 4xx refusal, and a fresh read shows the record unchanged |
| `verification_failed` | Written, but the readback differs. Keep the receipt and inspect the record |
| `unknown` | The outcome is uncertain. Read the record before anything else. Never retry blindly |

## Open question this door is built to answer safely

Xero's API reference does not say whether a reconciled bank transaction accepts a tracking-only update. Either answer is safe:
- If Xero refuses, the result is `refused_unchanged`.
- If Xero silently unreconciles the transaction, the readback reports `verification_failed`, with `IsReconciled` named in the before and after.

Prove this on one low-value reconciled line before any batch.

## Limits

- Xero has no compare-and-swap, and the lock is isolate-local. Use one writer and a quiet window.
- Records with a nonzero rounding adjustment, or with an invoice-level address block, are refused. Resending lines drops the address block; this was seen on INV-1697 on 30 Oct 2026.
- The readback covers the record's API fields. It does not prove bank statement lines or project links.
- The work budget and no-retry rules are the same as the bill tracking door.

## Read doors

These are read only:
- `GET ops-api?action=read_xero_history&kind=&id=` returns Xero History and Notes: who created or changed the record, and when.
- `GET ops-api?action=list_xero_attachments&kind=&id=` lists attachments by ID, file name, MIME type and size. Xero's file URL is dropped.
- `GET ops-api?action=get_xero_attachment&kind=&id=&attachment_id=` returns one PDF or image attachment as base64, up to 4 MiB. Type and size are checked against Xero's listing before anything is downloaded.

Tests:

```bash
deno test --allow-env --allow-read supabase/functions/ops-api/xero_line_corrections_test.ts supabase/functions/ops-api/xero_record_reads_test.ts
```
