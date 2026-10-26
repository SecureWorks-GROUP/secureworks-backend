# Invoice→job links never move money (INT-14, 26 Oct 2026)

**Rule** (the same sentence in the CFO and Context records and in both sides' tests):

> An invoice→job decision decides only which job an invoice counts on, never its money: total, amount due, amount paid and status come only from Xero's own record. xero-sync's reference and exact client-name links may set the job on an invoice that has none, and never move one already on a job. A Context decision never writes the invoice row, so it never moves revenue.

## What each side does today

| Who links | What it writes | Test |
|---|---|---|
| xero-sync `matchUnlinkedInvoices`, strategy 1 (a job number in the reference) and strategy 2 (`client_name_exact`, one live job) | `xero_invoices.job_id` and `updated_at` only, on rows read as `job_id is null`. The write itself is guarded by `job_id is null` (added here), so a job set between the read and the write is kept | `xero-sync/match_unlinked_strategy2_test.ts`, the `INT-14` cases |
| The sync-time reference linker and `linkContactInvoicesToJob` | `job_id` only, already guarded by `job_id is null` | (unchanged) |
| A Context decision (`context_recon_record_decision`, migration `20261020140000`) | `context_reconciliation_decisions` and `context_placement_links` only. Its subject is a `business_events` row, never an invoice. Context's money read (`context_job_owed_lines`) places an invoice on a job only by `xero_invoices.job_id` | Context's test, in that migration's contract |

So a person who decides an `invoice.paid` event onto job B, while Xero's mirror says job A, moves the evidence to B. The money stays on A.

## Still open: V-07

`ops-api` `reconcile_payment` writes a Xero payment and then updates the local mirror's `amount_due`, `amount_paid` and `status` from its own arithmetic. That is a payment path, not an invoice→job decision, so it is outside this rule. It does break "money only from Xero's own record" until the next invoice sync overwrites the row from Xero. The fix is to re-read the invoice from Xero after the payment. That is a CFO ticket, not this one.
