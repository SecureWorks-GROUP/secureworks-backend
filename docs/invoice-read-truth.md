# Invoice reads: unknown is not $0, and "sent" is Xero's flag

Tickets INT-35 and INT-36 (Integrated Job Framework, R-22). Code:
`supabase/functions/ops-api/invoice_read_truth.ts`; tests:
`invoice_read_truth_test.ts`.

## `list_invoices` summary (INT-35)

`summary` is `{ outstanding, overdue, total, summary_error }`.

- A healthy read gives numbers (rounded to the cent) and `summary_error: null`.
  A true zero stays `0`.
- `outstanding` and `overdue` are both `null`, and `summary_error` names why,
  when:
  - `open_invoice_read_failed`: the open-invoice read returned an error, threw,
    or returned no row list;
  - `open_invoice_amount_due_missing`: an open (AUTHORISED or SUBMITTED)
    invoice has no readable `amount_due`;
  - `open_invoice_read_incomplete`: the read hit its page limit (50 pages of
    1,000) before it ended.
- The read pages in 1,000-row ranges ordered by `id`, so it is no longer cut
  at PostgREST's 1,000-row stop. Before this change a failed read summed to
  `outstanding: 0, overdue: 0`, and a large book was summed from its first
  1,000 rows only.
- The early "no job found for that job number" answer keeps `0`: there are no
  invoices to owe.

Pages show "Unknown" with the reason when a figure is `null`, and "Unknown"
when the summary is missing. No other money read changes in this ticket.

## `sent_to_contact` (INT-36)

Every invoice row from `list_invoices` and every invoice in `job_detail`
carries `sent_to_contact`: `true` or `false` only as Xero's own
`Invoice.SentToContact` says, else `null` ("Sent: not known" on the page).
Status is never read as a sent flag (Xero has no SENT status).

It needs no column or migration: xero-sync already stores Xero's whole
invoice in `xero_invoices.raw_json` (the 15-minute sync, the backfill, and the
single-invoice reconcile all write it). `list_invoices` projects
`raw_json->SentToContact`; `job_detail` already selects the row and reads it
in code. Our own send path posts to Xero's `/Invoices/{id}/Email`, which sets
Xero's flag, so the next sync shows it; no second record is folded in.

Not observed: the flag's presence on live stored rows was not read for this
change. A row stored without it reads `null`, never `false`.
