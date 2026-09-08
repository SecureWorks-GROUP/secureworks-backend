<!-- Points Claude at AGENTS.md via import; edit AGENTS.md, not this file. -->
@AGENTS.md

## Trade quote lines, late freeze, completion evidence (2026-09-08)

See `docs/trade-quote-lines-and-completion-evidence-2026-09-08.md`. Quote packs carry the quote's own rows (`quote_lines`) and writing (`quote_notes`); legacy sent quotes on active jobs freeze on first trade read; fencing job invoices require completion photos + neighbour sign-off (`trade_completion_evidence.ts`, trade actions `complete_my_job` / `waive_neighbour_signoff`).

See `docs/trade-roof-report-any-makesafe-hours-2026-09-08.md`. A trade may attach a SecureWorks letterhead roof report to ANY make-safe (`submit_roof_report`); the reporting checklist advances only on report-type jobs. `log_my_job_hours` puts the trade's hours on their own assignment for the job with one tap (replaces, quarter-hour, refuses `invoiced_in`).

See `docs/trade-my-money-gst-2026-09-08.md`. `my_money` gives a trade earned / paid / owed / super by month and FY; `trade_invoices.paid_at|amount_paid|xero_bill_status` are mirrored from Xero by `xero-sync/trade_bill_status.ts` (keyed on `xero_bill_id`, never on reference text). `update_trade_profile` merges `trade_details`; GST default is the profile flag, never browser storage.

See `docs/makesafe-submitter-attribution-and-unlock-2026-09-08.md`. Submitting a final make-safe report cancels other trades' assignments on that attendance cycle (invoiced rows are left and flagged); `unlock_makesafe_report` reopens a submitted report until the office sends it.
