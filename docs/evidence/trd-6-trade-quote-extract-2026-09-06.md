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
  covers `$`, `A$`/`AU$`, `AUD`, `USD`, `GST`, currency words
  (`dollar(s)` / `buck(s)`), and contextual words
  (`rate`, `price`, `amount`, `cost`, `fee`, `deposit`, plus the existing
  total phrases) on every extract string leaf, identity included. Sealed
  payment-terms language (`50% deposit + 50% on completion`) is exempt
  only on `terms.payment_terms`. HTML assertion strips the Payment terms
  row and the extract footer disclaimer before scanning.

## Review-3 locks (2026-09-06)

- **Percent and payment-language fail closed.** `tradeTextHasMoneyToken`
  treats `%` / `percent` / `percentage` and payment-language words
  (`upfront`, `balance`, `due`, `payment` / `pay` / `paid`, and the
  neighbouring owing/payable set) as money. The exact sealed phrase
  `50% deposit + 50% on completion` stays exempt only on
  `terms.payment_terms`. Ad-hoc "50% upfront" / "balance due" /
  "Payment 50" drop from extracts and from allocated customer/terms.
  Allocated leftover percent/payment-language / currency-word prose
  drops. Review-11 supersedes the earlier `Install Deposit` leftover
  allowance: allocated quote-pack prose now uses the full money-token
  predicate. HTML money needles strip `<style>` first so CSS `100%`
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
  same allowlist. Review-11 drops the earlier `Install Deposit`
  leftover allowance on allocated quote-packs.
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

## Review-6 locks (2026-09-06)

- **Claim token owns publish and revert.** `send_claim_token` is minted with
  `send_claimed_at`. Stale reclaim writes a new token. Publication and
  revert match that token per document. The original worker cannot stamp
  or clear a claim after reclaim. Batch send-runs claims are fenced the
  same way.
- **Office/admin only may send (TRD6-R6-001).** `/send` and `/send-runs`
  JWT callers must be `admin`, `owner`, or `ops_manager` (the same
  `OPS_API_STAFF_OPERATOR_ROLES` set). Trade / estimator / allocated /
  `makesafe_open` / `lead_installer` JWTs are 403
  `operator_access_required` before Resend, claim, or `draft`→`quoted`.
  JWT send also requires `users.org_id` === `jobs.org_id`; a missing org
  on either side fails closed. API-key / service-role stays office.
  `/send-invoice` still accepts any verified user JWT.
- **Frozen pack is part of publication.** Both send paths persist and
  confirm `trade_pack_json` before `sent_to_client`/`sent_at`. An
  unconfirmed pack write reverts the owned claim and returns 500. A
  published row cannot silently miss the extract.
- **send-runs does not report success with zero emails.** All-Resend-fail
  is 502. Nothing assembled is 400. Neighbour-only email success stays
  200 and leaves the job unquoted. An already-published no-op retry is
  200 `already_sent`.
- **Claim database faults are not already_sent.** Document and job claim
  helpers return `claimed` / `unavailable` / `error`. `/send` maps error
  to 500. send-runs maps a job-claim error to 500, not 409.

## Review-7 locks (2026-09-06)

- **Superseded outranks accepted.** `superseded_at` makes the pack
  `status=superseded` even when `accepted_at` is set. Frozen extract
  hydration returns null; `tradeQuoteExtractIsEligible` still rejects
  `status=superseded`. A revised accepted quote cannot stay extractable.
- **Quote numbers are fail-closed identity.** Allocated `quote_packs`
  and extract pointers run `allocatedTradePackIdentity` on
  `quote_number`. `$18,400` / `50% deposit` / `rate 850` null the field
  or omit the pointer. Filenames sanitize before slugging.
- **Failed send-runs recipients release their claims.** After publishing
  the successful subset, leftover claims revert under the same token
  fence (cannot clear a published row). Zero-publication still reverts
  every claim.

## Review-8 locks (2026-09-06)

- **draft→quoted uses durable primary publication.** send-runs flips a
  leftover draft when the primary client document is already published
  (`publishedExistingDocs` / `use_published`), not only when this request
  emailed the primary. An alreadyComplete retry after a partial
  publication cannot leave the job draft. Neighbour-only publication
  still does not release.
- **Superseded send-runs rows are not current.** The existing-document
  read selects `superseded_at` and excludes non-null rows before
  `use_published` / `reuse_unpublished`. A `/send` revision mint must
  create a fresh run document instead of claiming the superseded pack
  was already sent. Extract exclusion of superseded packs stays in force.

## Review-9 locks (2026-09-06)

- **Revision supersession uses extract-durable publication.**
  `supersede_prior` stamps every current-scope prior row that
  `quoteDocumentHasClientSend` would treat as published: `sent_to_client=true`,
  historical omitted-flag + `sent_at`, or `accepted_at`. Explicit
  `sent_to_client=false` and in-flight claims stay unpublished. A read or
  write fault returns 500 `quote_supersede_failed` (not a silent 200). An
  already-published retry with `supersede_prior` re-runs the stamp so a
  failed first write cannot leave a stale extract current.
- **Accepted is published for send-runs reuse.** Existing-document reads
  carry `accepted_at`. `quoteSendIsPublished` is the extract predicate, so
  an accepted historical/run row with a false or omitted sent marker is
  `use_published`, not claimed or re-emailed. Claim exclusive/reclaim also
  require `accepted_at IS NULL`.

## Review-10 locks (2026-09-06)

- **Payment prose and currency words fail closed outside payment_terms.**
  `TRADE_PAYMENT_LANGUAGE_RE` includes `payment` / `pay` / `paid`.
  `tradeTextHasMoneyToken` and allocated leftover prose also refuse
  `dollar(s)` / `buck(s)`. After figure-strip, leftovers such as
  `Payment 50` and `Payment in dollars` drop from extract notes,
  customer fields, item descriptions, HTML, and quote-pack redaction.
  The exact sealed phrase stays exempt only on `terms.payment_terms`.
  HTML leak scanning removes the whole Payment terms row (label
  included) so the `<dt>Payment terms</dt>` copy is not a false hit.
  Review-11 supersedes the earlier `Install Deposit` leftover
  allowance on allocated quote-packs.

## Review-11 locks (2026-09-06)

- **Allocated quote-pack prose uses the full money-token predicate.**
  `allocatedTradePackProse` / projection leaks refuse the same tokens
  as extract leaves: generic money words (`price`, `cost`, `fee`,
  `rate`, …), `USD`/`GST`, deposit-only leftovers, payment language,
  and currency words. `Price review`, `cost estimate`, `Deposit
  required`, `USD pricing`, and `Install Deposit` drop from allocated
  summary and item descriptions. Sealed phrase stays exempt only on
  `terms.payment_terms`.
- **Allocated units reject currency tokens.** `sanitizeTradePackUnit`
  refuses `dollar(s)`, `buck(s)`, `USD`/`AUD`/`GST`, and any leftover
  that trips `tradeTextHasMoneyToken`. Redact applies that same
  fail-closed check before emitting `unit`. Approved construction
  units (`m`, `ea`, `lot`, …) stay.
