# Exact supplier-credit evidence read (TP-07 / TP-01)

`GET ops-api?action=read_xero_settlement_record&record_type=credit_note&record_id=<Xero UUID>` now accepts either Xero credit-note type: `ACCRECCREDIT` (customer) or `ACCPAYCREDIT` (supplier). It returns `ledger_side: receivable|payable` alongside the unchanged raw provider record and provenance. The existing SecureSuite tool uses this same door without new arguments.

This unblocks Bookkeeping's known supplier-credit IDs from AgedPayables, previously rejected with409 `NOT_ACCREC_SETTLEMENT`. The exact-ID route preserves original dates, updated date, status, lines, allocations and their invoice identities/amounts, remaining credit, currency, tax and payment records. It does not infer which accounting period an allocation belongs to from the credit's document date, or assign a job from a division tag.

Scope is deliberately bounded: `list_xero_settlement_records` still lists receivables only, so existing receipt consumers do not silently gain supplier credits in their population. Payment, overpayment and prepayment reads retain their receivables restriction. Wrong/missing/duplicate IDs and unknown types are refused. Existing staff authentication, tenant selection, provider GET, cooldown and provenance behavior are unchanged; no cache/business write, provider POST, new key or permission change is introduced.

A returned supplier credit is original evidence, not permission to apply, backdate or adjust an allocation. No credit nets against cost here, and no bank-statement signoff, payment approval or job cost-close follows from a successful read.

Provider contract: [Xero Credit Notes](https://developer.xero.com/documentation/api/accounting/creditnotes/). Tests execute the actual read function and injected GET-only provider interface, including raw source preservation, customer/supplier separation, invalid identities/types, contradictory invoice side, unchanged list filtering and no database access. Live acceptance must re-read the known Bunnings UUID `7e392aed-5703-46b6-bb6e-71a51940639f` through SecureSuite after deploy, then return the evidence route to Bookkeeping's sole source owner.
