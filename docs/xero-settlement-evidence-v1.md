# Xero payment settlement evidence

An invoice marked PAID proves a Xero invoice balance, not which bank statement
line settled it. This slice records provider payment and receipt-batch evidence
and gives debt collection, context and profitability one read they can consume.
It does not change their balances or policies.

## Capture

The existing `xero-sync` `sync_invoices` run calls `syncSettlementEvidence`.
Only GET `/Payments` (`ACCRECPAYMENT`) and GET `/BatchPayments` (`RECBATCH`)
are available to that module. It uses the existing tenant, token and shared
rate-limit transport. No additional scope, connection, token or schedule is
introduced. Do not run `sync_invoices` as a read-only proof: its existing work
has other effects. This slice was proved by GETs and local replay only.

`xero_settlement_evidence` is one private table, keyed by organisation, Xero
tenant, record kind and provider ID. Payments retain their invoice and batch
IDs, date, amount, reference, account, status and nullable `IsReconciled`.
Batches retain their own total and complete `raw_json.Payments` allocations.
Never add a batch total to its allocations. Raw provider fields are retained,
including any provider statement identifier; this is not a new local bank-line
relationship. No query matches `xero_bank_transactions`.

Payments are paged at 100, including deleted records; a full page is followed
until a short page. BatchPayments is an unpaged collection in Xero's contract.
The initial normal sync traverses the whole provider history. Later runs use
their own `xero_sync_state` key, scoped to org and tenant, and the existing
15-minute modified-since overlap. Invoice modification time is not used to
decide whether payment reconciliation changed. Xero does not promise that
reconciling a payment or batch moves its `UpdatedDateUTC`, so the first run
after the last complete traversal is 24 hours old reads the whole history
again (`settlement_evidence_full:<org>:<tenant>` records it). A payment
reconciled after capture is therefore re-observed within about a day.

The cursor advances only after both complete provider reads and every upsert
succeed. An unreadable collection, duplicate ID, page-limit refusal, provider
error or write error retains the cursor. The new capture reports its failure
in `settlement_evidence` on the sync result/log; it does not manufacture an
empty success. Earlier observations cannot overwrite a newer captured row.
The 100-page safety bound refuses completion rather than truncating history.

## Shared read

Staff/server GET `ops-api?action=invoice_settlement&xero_invoice_id=<Xero UUID>`
calls `readInvoiceSettlement` in `xero_invoice_settlement_read.ts`. It selects
the caller's org, existing connection's tenant and exact sales invoice. It
does not refresh credentials or call Xero. Browser database roles cannot read
the evidence table. Unauthenticated callers, trades and routine callers are
not admitted by the staff/server door.

The contract is `xero-invoice-settlement/v1`:

| Field | Meaning |
| --- | --- |
| `paid_amount`, `currency` | Invoice header's recorded cash paid; never recomputed from credits or the batch total. |
| `observed_payment_amount` | Sum of AUTHORISED payment allocations for this invoice. |
| `payments` | Provider payment fields, observation times and per-payment reconciliation result. Deleted/non-authorised observations stay visible but do not add to paid cash. |
| `batches` | Each referenced receipt batch once, with its complete allocations, total and observation time. It may include sibling invoices; those allocations do not enter this invoice's sum. |
| `bank_proof.reconciled` | `true`, `false` or `null` (unknown), **as observed in Xero**, on basis `xero_payment_reconciliation`. |
| `bank_proof.unknown_reason(s)` | Explicit reasons such as unavailable evidence, missing batch allocation, account/flag conflict or invoice/payment amount disagreement. |
| `bank_proof.statement_line` | Always `not_ingested`; BK-03 remains open. |

A known invoice result requires positive recorded cash, complete authorised
payment amounts agreeing with that cash to the cent, matching invoice currency,
bank account IDs and explicit provider reconciliation booleans. A batched
payment also needs its batch, the same account and reconciliation result, and
one matching payment/invoice/amount allocation. Missing embedded payment IDs
cannot disappear when the richer provider evidence is read.

When those checks pass, all reconciled payments yield `true`; any explicitly
unreconciled payment yields `false`. Incomplete or contradictory evidence yields
`null`, even if another payment is known. A failed evidence-table read also
yields unknown; a failed invoice read fails the request. These are observations
with `captured_at`, not an on-demand guarantee of Xero's current state. If any
active payment or its batch was captured more than 26 hours before the read,
the invoice returns unknown with `settlement_evidence_stale`. A stopped capture
therefore cannot keep publishing a known reconciliation result indefinitely.

`false` does not create debt. An invoice can be fully paid in Xero and still
have an unreconciled payment. No debt, deposit, job, payer, due-date, context,
profit or invoice amount is written by this module.

The existing `list_xero_settlement_records` and `read_xero_settlement_record`
already read raw Xero records directly, rather than a stored settlement table.
They remain available for direct inspection (the exact credit-note read also
admits supplier credits: `docs/xero-supplier-credit-read.md`); the new contract
is the shared stored-evidence interpretation beside them, not another bank
matcher.

## Real-data proof, 14 October 2026

Production SELECT returned exactly the diagnosis's 1,212 PAID sales invoices
and $2,145,913.50 paid. Existing-connection GETs at approximately 20:58–21:06
Perth returned 1,332 sales payment records over 14 pages and 87 receipt batches
containing 469 allocations. Batch GET returned HTTP 200; no new access was
needed. The unfiltered batch GET also returned supplier batches, which are
excluded from this slice. The exact filtered receipt GET returned 87 batches.

The captured responses were replayed through the actual sync projection and
shared reader locally, with persistence in memory. This is implementation
proof on real records, **not deployed capture proof**. Production was not
backfilled, synced or migrated by this task.

| Population | Count | Paid / allocation amount | Reconciled true | False | Unknown |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original newest 50, 2–14 October | 50 | $81,236.60 | 40 | 10 | 0 |
| Newest 50 September, same date-descending/invoice-ID ordering | 50 | $70,918.50 | 50 | 0 | 0 |
| PAID sales invoices | 1,212 | $2,145,913.50 | 1,158 | 53 | 1 |

The invoice split is $2,037,523.87 reconciled, $105,188.63 unreconciled and
$3,201.00 unknown. INV-0183 has no active payment evidence agreeing with its
recorded $3,201.00 paid. It remains unknown, not silently classified unpaid.
All **456 of 456** batch-linked allocations in the diagnosis have their
payment, batch and allocation preserved. No bank line was ingested or matched.

Fault probes on those real records confirmed unknown for a missing evidence
read, missing batch, conflicting batch flag and changed invoice paid amount.
A malformed provider collection refused capture without advancing its cursor.
Snapshots, the executable local replay and per-invoice verdicts are retained
in the task's authorised `data/bookkeeping-settlement-evidence-20261014/`
folder, outside Git. Do not publish customer payloads in the repository.

## Release and outstanding decision

Apply `20261014125951_xero_settlement_evidence.sql` before either edge function;
both are declared in the schema preflight. The version was absent from the
production migration ledger when checked. The migration installs only the
evidence store and grants; it backfills no business records. Normal sync fills
it after deployment. Reverting code leaves the evidence table intact.

The registered PostgreSQL migration contract checks batch allocation retention,
nullable reconciliation, newer-observation precedence and private service-only
access. The no-mistakes/CI lane owns execution of that disposable database test.
The verdict rules, the not-found result (served as 404) for an unknown or
non-sales invoice, and the cursor and daily full re-read rules are pinned by
`ops-api/xero_invoice_settlement_read_test.ts` and
`xero-sync/settlement_evidence_test.ts`.

BK-03 still decides whether provider reconciliation alone satisfies the business
definition of bank proof, or whether actual statement lines are also required.
Statement-line ingestion and automatic bank matching are not built. Changing
debt, profit or context behavior is a later consumer slice, not implied by this
new evidence. Merging, deploying and the independent money/database review
remain with firstmate/Rayleigh.

Provider contracts: [Payments](https://developer.xero.com/documentation/api/accounting/payments/),
[BatchPayments](https://developer.xero.com/documentation/api/accounting/batchpayments/)
and [Xero's OpenAPI schema](https://github.com/XeroAPI/Xero-OpenAPI/blob/master/xero_accounting.yaml).
