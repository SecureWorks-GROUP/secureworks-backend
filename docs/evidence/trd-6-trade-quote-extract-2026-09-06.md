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

## Review-1 locks (2026-09-06)

- **Client send before extract.** Eligibility is `job_documents.sent_at` or
  `accepted_at`. Pack presence / stored `sent_at` / `hydrateStoredPack` status
  is not enough. Send-runs persist `trade_pack_json` only after `primarySent`.
- **Money scrub at every free-text field.** Phone, email, units, quote/job
  numbers, notes, and customer/terms prose all fail closed on `$` / AUD / GST
  / money tokens. Phone and email keep digits unless a money token is present.
  `assertTradeQuoteExtractArtifact` covers the JSON extract and rendered HTML.
- **Frozen pack only.** `trade_quote_extract` requires persisted
  `trade_pack_json`. A sent quote with no frozen pack may still get a TRD-4
  `quote_packs` `live_fallback`; it gets no extract. Old packs may overlay
  documented customer/terms fields only.

## Review-2 locks (2026-09-06)

- **Allocated pack snapshots are fail-closed.** `redactTradeQuotePackMoney`
  runs the same money-token predicate on every customer/terms string
  (phone, email, and `valid_until` included). Dirty fields are omitted, not
  copied. `assertAllocatedTradeQuotePackProjection` pins the allocated
  projection.
- **Primary send before pack exposure.** send-runs inserts quote rows with
  `sent_to_client=false` and `sent_at=null`. Those flags stamp only after
  the primary Resend succeeds; a failed primary reverts them. Quote-pack
  fallback treats an explicit `sent_to_client=false` as unpublished.
  Historical rows that omit the flag and already have `sent_at` stay
  eligible. `accepted_at` still wins.
- **One conservative money-token predicate.** `tradeTextHasMoneyToken`
  covers `$`, `A$`/`AU$`, `AUD`, `USD`, `GST`, and contextual words
  (`rate`, `price`, `amount`, `cost`, `fee`, `deposit`, plus the existing
  total phrases) on every extract string leaf, identity included. Sealed
  payment-terms language (`50% deposit + 50% on completion`) is exempt.
  HTML assertion strips that phrase and the extract footer disclaimer
  before scanning.
