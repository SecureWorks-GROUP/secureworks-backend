<!-- Points Claude at AGENTS.md via import; edit AGENTS.md, not this file. -->
@AGENTS.md

## Trade quote lines, late freeze, completion evidence (2026-09-08)

See `docs/trade-quote-lines-and-completion-evidence-2026-09-08.md`. Quote packs carry the quote's own rows (`quote_lines`) and writing (`quote_notes`); legacy sent quotes on active jobs freeze on first trade read; fencing job invoices require completion photos + neighbour sign-off (`trade_completion_evidence.ts`, trade actions `complete_my_job` / `waive_neighbour_signoff`).
