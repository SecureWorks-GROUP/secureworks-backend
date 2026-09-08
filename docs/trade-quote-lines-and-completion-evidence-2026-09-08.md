# Trade quote lines, late freeze, and fencing completion evidence (2026-09-08)

Captain ask (Marnin, 2026-09-08): trades must see exactly what was in the
quote minus the price, reliably; "Open quote" must work on active legacy jobs;
a fencing job cannot be invoiced until completion photos and the neighbours'
sign-off are on file.

## Quote lines (`_shared/trade_quote_pack/pack_trade_quote.ts`)

`TradeQuotePack.quote_lines` = the rows the client PDF prints
(`pricing_json.runs[].items` description / quantity / unit) plus the flat
`pricing_json.line_items` rows the run rows do not carry (category custom /
removal always; other categories only when their quantity+unit pair is not a
run row). `quote_notes` = job description, the scoper's custom description,
site notes, removal notes, quote note. Money is stripped at pack time and the
allocated projection (`redactTradeQuotePackMoney`) fails closed: a note that
still carries money language is dropped whole. `allocatedTradeQuotePackProjectionLeaks`
covers both new fields. The derived installer `items` (metres / plinths /
gates, the per-metre pay basis) are unchanged; the app shows them under
"Install summary".

"due to" is causal prose ("damaged due to storms"), not payment language,
in both `TRADE_PAYMENT_LANGUAGE_RE` and the extract HTML needle scan. Bare
"due" / "balance due" / "due on completion" still count as money language.
Plain quantity cells in the extract HTML ("7.1 m") are exempt from the money
token scan; anything else in a qty cell is still scanned.

## Late freeze (`freezeLegacySentQuotePacks`, ops-api)

A sent, non-superseded quote document with no `trade_pack_json` on a job in
`TRADE_LATE_FREEZE_JOB_STATUSES` (accepted .. rectification, not quoted, not
complete/invoiced/archived) is frozen on the first `trade_job_detail` read.
The pack records `frozen_late_at`; the same response already carries the
frozen pack and the `quote_extracts` pointer. Never re-runs for a doc that has
a pack. Quotes on jobs still at `quoted` stay `live_fallback` with no extract.

## Completion evidence (`ops-api/trade_completion_evidence.ts`)

Fencing only. Required: 3 `job_media.phase='completion'` photos and
max(1, named neighbours on `scope_json.job.neighbours`) `phase='neighbour_signoff'`
rows, unless a `job_events.event_type='neighbour_signoff_waived'` row exists
(trade action `waive_neighbour_signoff`, reason required, logged with user).
Read paths carry `completion_evidence` (my_work_orders rows, per-metre
my_hours assignments, trade_job_detail) and set
`invoice_block_reason='completion_evidence'`; write paths
(`submit_work_order_invoice`, weekly `_resolveWeeklyWorkOrderInvoice`,
per-metre `submit_trade_invoice`) refuse with `completionEvidenceMessage`.
Hourly invoices are not gated. A failed evidence read fails closed.

`complete_my_job` is the trade-scoped door to `completeJob` (assignment /
vertical-manager access, then the same evidence gate for fencing).
`complete_job` stays staff-only; the completion wizard 403'd for installers
before this. Migration `20260908100000` adds `neighbour_signoff`, `marketing`
and `issue` to the `job_media.phase` check.

Tests: `pack_trade_quote_test.ts`, `trade_access_tier_test.ts` (quote lines,
late freeze, complete_my_job gate, waiver), `trade_completion_evidence_test.ts`,
`trade_work_order_invoice_test.ts`, `trade_invoice_weekly_resolver_test.ts`.
