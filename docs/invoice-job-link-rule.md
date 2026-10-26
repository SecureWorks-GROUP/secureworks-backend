# Invoice→job links never move money (INT-14, 26 Oct 2026)

**Rule** (the same sentence in the CFO and Context records and in both sides' tests):

> An invoice→job decision decides only which job an invoice counts on, never its money: total, amount due, amount paid and status come only from Xero's own record. xero-sync's reference and exact client-name links may set the job on an invoice that has none, and never move one already on a job. A Context decision never writes the invoice row, so it never moves revenue.

## What each side does today

| Who links | What it writes | Test |
|---|---|---|
| xero-sync `matchUnlinkedInvoices`, strategy 1 (a job number in the reference) and strategy 2 (`client_name_exact`, one live job) | `xero_invoices.job_id` and `updated_at` only, on rows read as `job_id is null`. The write itself is guarded by `job_id is null` and returns the rows it changed (added here). A job set between the read and the write is kept, and then no `invoice.auto_linked` evidence is written and nothing is counted | `xero-sync/match_unlinked_strategy2_test.ts`, the `INT-14` cases |
| xero-sync `matchInvoicesByReference` (the `match_invoices_by_reference` action) and reporting-api `matchInvoicesToJobs` | `job_id` only. Guarded the same way (added here), and they count only a row that was actually linked | The `INT-14` source scan in the same test file: every automatic `.update({ job_id … })` in xero-sync and reporting-api carries `.is('job_id', null)` |
| The sync-time reference linker and `linkContactInvoicesToJob` | `job_id` only, already guarded by `job_id is null` | Covered by the same source scan |
| A Context decision (`context_recon_record_decision`, migration `20261020140000`) | `context_reconciliation_decisions` and `context_placement_links` only. Its subject is a `business_events` row, never an invoice. Context's money read (`context_job_owed_lines`) places an invoice on a job only by `xero_invoices.job_id` | Context's test, in that migration's contract |

**Outside the rule:** a person moving an invoice to another job on purpose. That is ops-api `update_invoice_job_link`, and resolving an `unlinked_invoice` annotation. Those are staff presses, not automatic links, and they may move an invoice that already has a job.

So a person who decides an `invoice.paid` event onto job B, while Xero's mirror says job A, moves the evidence to B. The money stays on A.

## Still open: V-07

`ops-api` `reconcile_payment` writes a Xero payment and then updates the local mirror's `amount_due`, `amount_paid` and `status` from its own arithmetic. That is a payment path, not an invoice→job decision, so it is outside this rule. It does break "money only from Xero's own record" until the next invoice sync overwrites the row from Xero. The fix is to re-read the invoice from Xero after the payment. That is a CFO ticket, not this one.
