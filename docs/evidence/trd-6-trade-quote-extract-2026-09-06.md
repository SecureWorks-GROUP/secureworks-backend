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

## Review-3 locks (2026-09-06)

- **Percent and payment-language fail closed.** `tradeTextHasMoneyToken`
  treats `%` / `percent` / `percentage` and payment-language words
  (`upfront`, `balance`, `due`, and the neighbouring owing/payable set) as
  money. The exact sealed phrase `50% deposit + 50% on completion` stays
  exempt. Ad-hoc "50% upfront" / "balance due" drop from extracts and from
  allocated customer/terms. Allocated item leftovers may still keep strip
  artifacts such as `Install Deposit`; leftover percent/payment-language
  prose does not. HTML money needles strip `<style>` first so CSS `100%`
  is not a false leak.
- **In-flight claim is not publication.** Direct `/send` locks
  `job_documents.send_claimed_at` only. `sent_to_client` and `sent_at`
  stamp after Resend succeeds. Quote-pack and extract eligibility require
  that publication marker (or `accepted_at`, or a historical omitted-flag
  row with `sent_at` and no open claim). An explicit `sent_to_client=false`
  or a still-open claim never exposes allocated packs. Same bar as
  send-runs.

## Review-4 locks (2026-09-06)

- **Sealed phrase is payment_terms-only.** `tradeTextHasMoneyToken` and
  `allocatedTradePackProse` fail closed on `50% deposit + 50% on completion`
  like any other money prose. The exact leftover is kept only by
  `allocatedPaymentTerms` / extract `terms.payment_terms`. Customer name,
  items, notes, and summary that carry that phrase are dropped. HTML leak
  scanning strips the phrase only from the Payment terms `<dt>/<dd>` row.
- **send-runs publishes per recipient.** A primary Resend success no longer
  stamps neighbour documents. Each created doc publishes only when that
  recipient's email succeeded. Job `draft` → `quoted` still requires the
  primary client send.
- **send-runs documents mint a quote number at insert** (`next_quote_number`,
  fallback `job-run` / `job-run-N`) and select it through so frozen packs
  stay extract-eligible.
- **Publication stamp failure reverts the /send claim.** After Resend
  accepts, a failed `sent_to_client`/`sent_at` write clears `send_claimed_at`
  and returns 500 so retry is not stranded on `already_sent`.

## Review-5 locks (2026-09-06)

- **payment_terms is the exact sealed phrase only.** After strip,
  `allocatedPaymentTerms` keeps `50% deposit + 50% on completion` and drops
  every other leftover (`Payment on completion`, `Net 30` included).
  Allocated projection leaks and extract HTML Payment terms `<dd>` use that
  same allowlist. Item leftovers such as `Install Deposit` stay allowed.
- **Document send claims expire.** `send_claimed_at` is exclusive while
  fresh (`QUOTE_SEND_CLAIM_TTL_MS` = 15 minutes) and unpublished. A stale
  unpublished claim is reclaimable. A published row stays `already_sent`.
- **send-runs fails closed on publication stamp failure.** After Resend
  succeeds, a failed `sent_to_client`/`sent_at` stamp reverts in-flight
  claims and returns 500. The handler does not flip `draft` → `quoted` or
  report success without durable publication for the successful recipients.
- **send-runs is claimed and idempotent per job/run.** `jobs.send_runs_claimed_at`
  fences concurrent create+send. Existing published job+run+contact docs are
  reused, not reminted; unpublished docs are reclaimed and republished. A
  retry after stamp failure publishes the same documents.
