# TRD-6 trade quote extract (2026-09-06)

Server-side, allowlisted, price-free quote extract for allocated trades and
`makesafe_open`. Office and division manager still see the full priced quote
PDF. Priced MakeSafe / quote / work-order PDFs stay hidden from allocated
trades (TRD-5). This extract is the only quote/work-order-style document those
callers get for customer details, terms, and scope quantities.

## Source

Frozen `job_documents.trade_pack_json` (`TradeQuotePack`) plus customer and
terms snapshots stamped at send (`packTradeQuote` / `persistTradePackOnDocuments`).
Older packs without snapshots overlay live `jobs` customer fields and default
terms (`50% deposit + 50% on completion`, 30 days). The extract never reads
`unit_price`, `line_total`, installer rates, or quote totals.

## Fetch

JWT trade caller with the same access as `trade_job_detail`:

```
GET ops-api?action=trade_quote_extract&jobId=<id>&document_id=<quote doc id optional>&format=json|html
```

- Default `format=json`: `{ schema, type, extract, html, filename, format }`
- `format=html`: printable HTML, `Content-Disposition: inline; filename="…-trade-extract.html"`
- Pointers also on `trade_job_detail.quote_extracts[]` (not injected into `documents`)

## Left for UX

No trade.html / dashboard change in this repo. The app opens the HTML (or
prints the JSON `.html`) later. No stored PDF. No print button here.
