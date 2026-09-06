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
  Review-12 puts `/send-invoice` on the same office JWT + tenant gate.
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

## Review-12 locks (2026-09-06)

- **`/send-invoice` is office-only.** `QUOTE_SEND_OFFICE_PATHS` is
  `send` / `send-invoice` / `send-runs`. JWT callers must be
  `admin` / `owner` / `ops_manager`. Trade / estimator / allocated /
  `makesafe_open` / `lead_installer` are 403 before Resend. Tenant
  compare is `users.org_id` === the authorized invoice job's
  `jobs.org_id`. API-key / service-role stays office.
- **JWT send-invoice does not trust body recipient or payment fields.**
  `resolveSendInvoiceDelivery` reads `client_email`, name, type,
  address, invoice number, deposit, and due date from the authorized
  job / Xero mirror. Body `payment_url` / `share_token` / attacker
  email are ignored on JWT. API-key may still pass office-derived
  fields (ops-api).
- **Allocated `quote_packs` emit is asserted.** After
  `redactTradeQuotePackMoney`, `projectAllocatedTradeQuotePacks`
  runs `assertAllocatedTradeQuotePackProjection` on every pack
  before `trade_job_detail` returns allocated / `makesafe_open`
  `quote_packs`. A residual leak 500s rather than shipping.

## Review-13 locks (2026-09-06)

- **Money-token fence covers non-AUD currency and tax/invoice prose.**
  `tradeTextHasMoneyToken` refuses `€` / `£` / `¥` and sibling symbols,
  common currency codes (`EUR` / `GBP` / `JPY` / `VAT` …), compact
  amounts (`EUR18`), and tax/invoice/billing language. `€18`, `£85`,
  `tax included`, and `invoice attached` drop from extracts, allocated
  identity/prose, and units. The sealed phrase stays exempt only on
  `payment_terms`.
- **JWT `/send-invoice` tenancy is first after lookup.**
  `authorizeSendInvoiceAccess` order is invoice → job → tenant →
  binding → sealed. JWT missing, unreadable, or foreign-org invoices
  return generic 404 `invoice_not_found` with no job id or sealed
  fact. Binding and `inspectSealedSesJob` run only after tenant.
  API-key keeps detailed 503/409 refusals.
- **Quote send reclaim cannot double-dispatch Resend.** Exclusive
  claim stores `send_resend_idempotency_key` (`quote-send:<token>`).
  Stale reclaim rotates `send_claim_token` and keeps that first-claim
  key (or `quote-send-doc:<id>`). Heartbeat refreshes `send_claimed_at`
  only for the current token. Resend sends `Idempotency-Key`. A lost
  lease returns `already_sent` instead of a second dispatch.
- **`/send-invoice` has an invoice-scoped send claim.**
  `invoice_email_send_claims` is operational mail state, not the Xero
  money mirror. Exclusive insert/update, stale reclaim that keeps the
  first `invoice-send:<token>` key, token-fenced heartbeat / publish /
  revert, and Resend `Idempotency-Key`.   Concurrent retries are
  `already_sent` or 409 `invoice_send_in_progress`.

## Review-14 locks (2026-09-06)

- **Quote-send rollback keeps the first-send provider key after Resend.**
  Exclusive claim leases without overwriting `send_resend_idempotency_key`.
  Definitive pre-send 4xx (except 408/409/429) may clear it. Network
  throws, 5xx/ambiguous provider results, persist failure, and
  publication-stamp failure revert with `keep_provider_key` so reclaim
  resumes the same Idempotency-Key.
- **Invoice-send rollback matches quote-send.** Exclusive update is
  lease-only; insert may mint the first key. `revertInvoiceEmailSendClaim`
  clears the key only on `pre_send`. Accepted-email persist/publication
  failure and ambiguous Resend outcomes keep `invoice-send:<token>`.
- **Allocated scope leftover prose is fail-closed.** After
  `stripTradePackMoney`, every allocated free-text leaf is refused when
  `tradeTextHasMoneyToken` or a numeric-only leftover remains. Short
  remnants of Unicode-currency / `tax included` / `invoice attached`
  originals also drop (`＄18 extra` → `extra`). ASCII `$` figures stay
  strip-and-keep (`Pat Client $9,999`, `Plus 80 +GST` → `Plus`). The
  sealed phrase is exempt only on a `payment_terms` path.
- **Money classifier includes Unicode currency (`\p{Sc}`).** FULLWIDTH
  DOLLAR `＄` and other Sc symbols drop on every projection/assertion
  path that uses `tradeTextHasMoneyToken`.
- **Extract prose rejects bare 1–2 digit amounts.** `extractProse` uses
  `allocatedTradePackProse`. Digits remain only on typed identity and
  quantity fields.
- **JWT `/send` and `/send-runs` hide missing vs foreign.** Both return
  generic 404 `{ error: 'Not found', code: 'not_found' }`. API-key office
  automation still sees `Document not found` / `Job not found` vs 403
  tenant.
- **Trade job access hides missing vs tenant-mismatch.** Both resolve to
  `tenant_mismatch` with `job: null` and throw `ApiError` 404
  `job_not_found` at the shared door, including `trade_quote_extract`.
  The outer 500 handler no longer receives distinguishable Error text.

Office-only `/send` / `/send-runs` / `/send-invoice` and sealed-phrase
exemption only on `payment_terms` stay locked.

## Review-15 locks (2026-09-06)

- **Inflected leftover money vocabulary fails closed.** After
  `stripTradePackMoney`, `tradeTextHasMoneyToken` refuses residual
  `total` / `totals` / `pricing` / `prices` / `rates` / `fees` / `costs`
  / `deposits` / `charged` and the rest of that inflection family on
  every allocated projection and leak assertion. Strip still leaves
  orphan vocab (`Approved total`, `Charge extra`). Bare `quote` /
  `quotes` / `quotation` stay off the classifier so `Quote note text`
  survives. The sealed phrase is exempt only on `payment_terms`.
- **Numeric-key allowlist cannot bypass leftover money language.**
  `sanitizeTradeAllocatedStringLeaf` refuses `tradeTextHasMoneyToken`
  leftovers before `qty` / `quantity` / `hours` keep. Finite numeric
  primitives and safe construction counts (`12`, `10m`, `2 trades`)
  stay. `labourers: "2 at $85/hour"` still keeps leftover `2 at /hour`.
- **`/send-invoice` validates delivery before claiming.** Missing
  `client_email` returns 400 without acquiring
  `invoice_email_send_claims`. Post-claim Resend / persist / publication
  rollback is unchanged: definitive pre-send 4xx may clear the provider
  key; ambiguous / post-send failure keeps `invoice-send:<token>`.
- **Construction holds restore with escaped carets.** `stripTradePackMoney`
  holds `10m` / `90x90` / `SWF-26101` as `^@n^@` and restores with
  `/\^@(\d+)\^@/g` after leftover 3+ digit strips. Extracts must not
  show placeholders.

Office-only `/send` / `/send-runs` / `/send-invoice` and sealed-phrase
exemption only on `payment_terms` stay locked.

## Review-16 locks (2026-09-06)

- **send-runs heartbeats every grouped document claim.** A recipient
  email covering several runs refreshes `send_claimed_at` on every owned
  document claim (`touchGroupedQuoteDocumentSendClaims`) before Resend.
  Refreshing only the first left secondary claims stale so `/send` could
  reclaim them with a distinct Idempotency-Key and duplicate the email.
  A missing claim in the group, or any lost token, skips that dispatch.
  A DB fault on any heartbeat is 500, not a skip.
- **Lease-refresh faults are 5xx, not already_sent.** `/send` and
  `/send-invoice` (and send-runs job/document heartbeats) treat a
  heartbeat `{ error }` as a lease error: HTTP 500, unpublished claim
  reverted with `keep_provider_key`. `already_sent` is reserved for
  explicit ownership loss (`updated: false`, no error). Job-lease
  ownership loss stays 409 `send_runs_in_progress`.

Office-only `/send` / `/send-runs` / `/send-invoice` and sealed-phrase
exemption only on `payment_terms` stay locked. Post-send provider keys
stay on ambiguous / persist / publication failure.

## Review-17 locks (2026-09-06)

- **Claim key-stamp must return the owned row.** Exclusive quote and
  invoice claims stamp `send_resend_idempotency_key` only after the
  lease lands. That token-fenced update now `.select()`s and confirms
  the returning id. Zero rows are `unavailable` (no dispatch). A DB
  fault stays `error`. An ephemeral payload key must never be treated
  as claimed — that is the reclaim race that minted a second Resend
  Idempotency-Key.
- **send-runs heartbeats grouped claims through persist and
  publication.** Review-16 refreshed every grouped claim before Resend.
  Persist and publication can still outlive the 15-minute lease, so
  `persistTradePacksWhileHoldingSendClaims` heartbeats the whole publish
  set before each pack write, and
  `publishQuoteDocumentsSendOrRevertWhileHolding` heartbeats again
  before `sent_to_client`. Lease miss / fault is 500
  `Failed to refresh quote send claim` and unpublished claims revert
  with `keep_provider_key`.

Office-only `/send` / `/send-runs` / `/send-invoice` stay locked.
Post-send provider keys stay. Lease errors are 5xx. Every grouped claim
is heartbeated before Resend. Money fences stay sealed.

## Review-18 locks (2026-09-06)

- **Amount strip must not leave payment-schedule prose.** After
  `stripTradePackMoney`, allocated customer / name / notes / summary /
  items drop leftovers that still say `on completion` / `upon
  completion` (`$50 on completion`, `AUD 50 on completion`, `50 dollars
  on completion`). The sealed phrase stays exempt only on
  `terms.payment_terms`. Work notes that already said "on completion"
  with no amount stay.
- **send-runs recipient keys are trim + lowercase.** Case-variant
  addresses are one inbox group. Publication matches the stored group
  email exactly so a success for `Pat@` cannot stamp a distinct `pat@`
  group's documents. Group provider-key reuse is Review-19.

Office-only `/send` / `/send-runs` / `/send-invoice` stay locked.
Post-send provider keys stay. Key-stamp ownership stays. Heartbeats
through publication stay. Money fences stay sealed.

## Review-19 locks (2026-09-06)

- **send-runs grouped email has a durable provider key.**
  `quote_group_email_send_records` stores the first Resend
  Idempotency-Key for job + normalized recipient + the original
  document set. send-runs uses that key, not `claims[0]`. A leftover
  retry after partial publication is a subset of the original set and
  reuses the same key. A later document set that is not a subset mints
  a new record. Partial group publish stays allowed; this is not a
  second lease and does not replace per-doc claims or heartbeats.
  Direct `/send` stays document-scoped.

Office-only `/send` / `/send-runs` / `/send-invoice` stay locked.
Post-send provider keys stay. Key-stamp ownership stays. Heartbeats
through publication stay. Money fences stay sealed.

## Review-20 locks (2026-09-06)

- **Payment-schedule remnants after strip are broader than completion.**
  Review-18 still drops leftover `on/upon completion`. Review-20 also
  drops leftover `on|upon|after|before|following` plus
  delivery / approval / acceptance / install(ation) / invoice / receipt
  / sign-off / handover when an amount was stripped (`$50 on delivery`,
  `$50 after completion`, `$50 upon approval`) or the leftover is only
  that remnant. Work notes that already said those schedule words with
  no amount stay. Sealed phrase stays exempt only on
  `terms.payment_terms`.
- **Money-token fence covers denomination leftovers and amount
  shorthand.** `euros` / `cents` / `pounds` / `pence` / `yen` / `yuan`
  / `rupees` / `francs` / `quid` fail closed on leftover prose
  (`100 euros` → `euros`). `10k` / `2.5K` are amount shorthand. `10m`
  stays a held construction count. Those words are not added to the
  strip list, so `100 euros extra` cannot collapse to leftover `extra`.
- **Definitive pre-send 4xx retires the group provider key.**
  `ensureQuoteGroupEmailSendKey` still persists before Resend. A
  definitive 4xx (not 408/409/429) deletes the matching
  `quote_group_email_send_records` row so a corrected retry of the same
  document set mints a new Idempotency-Key. Accepted or ambiguous
  provider outcomes keep the key. Per-doc claims still revert
  `pre_send` on that 4xx. Retire write faults log and continue.

Office-only `/send` / `/send-runs` / `/send-invoice` stay locked.
Post-send provider keys stay. Key-stamp ownership stays. Heartbeats
through publication stay. Money fences stay sealed.

## Review-21 locks (2026-09-06)

- **Payment-schedule remnants include at/by.** Review-20 still drops
  leftover `on|upon|after|before|following` plus the named events.
  Review-21 also drops leftover `at completion` / `by delivery`
  (`50 dollars at completion`, `50 dollars by delivery`) or the bare
  remnant. Work notes that already said those words with no amount
  stay. Sealed phrase stays exempt only on `terms.payment_terms`.
- **Money-token fence covers grand and uncommaed k shorthand.**
  `10 grand` / leftover `grand` and `1000k` fail closed.
  `10k` / `2.5K` stay covered. `10m` stays a held construction count.
  `grand` is not added to the strip list.
- **send-runs heartbeats every still-held claim before each Resend.**
  The grouped heartbeat set is every owned job claim plus the current
  recipient docs. An earlier successful group's unpublished claims
  stay fenced through later recipient sends and publication. Current
  recipient ownership is still required to dispatch. Definitive
  pre-send 4xx still retires the group key.

Office-only `/send` / `/send-runs` / `/send-invoice` stay locked.
Post-send provider keys stay. Key-stamp ownership stays. Heartbeats
through publication stay. Money fences stay sealed.

## Review-22 locks (2026-09-06)

- **`/send` pack-source job read fails closed before publication.** After
  Resend succeeds, a missing `job_id` or a failed/null jobs lookup
  keeps the provider key, reverts the owned claim, and returns 500
  before persist or publish. Transient read failure cannot mint an
  empty eligible extract.
- **send-runs primary recipient uses `quoteSendRecipientKey`.** The
  primary inbox is derived with the same trim+lowercase helper as
  recipient groups, so whitespace around the stored primary still
  marks `primarySent` and can advance the job off draft.

Office-only `/send` / `/send-runs` / `/send-invoice` stay locked.
Post-send provider keys stay. Key-stamp ownership stays. Heartbeats
through publication stay. Money fences stay sealed.

## Review-23 locks (2026-09-06)

- **Persist/publication heartbeats use current time each iteration.**
  `persistTradePacksWhileHoldingSendClaims` and
  `publishQuoteDocumentsSendOrRevertWhileHolding` refresh every still-held
  claim with `new Date()` before each write. A lost lease fails closed
  before the next persist or publication stamp. Grouped `sent_at` may
  still use the caller stamp; the lease must not.
- **Trade extract access is a generic 404.** Unassigned same-tenant jobs,
  missing ids, and foreign jobs share `Job not found` / `job_not_found`
  before any extract read. Other trade doors keep their existing
  not-assigned Error.

Office-only `/send` / `/send-runs` / `/send-invoice` stay locked.
Post-send provider keys stay. Key-stamp ownership stays. Heartbeats
through publication stay. Money fences stay sealed.

## Review-24 locks (2026-09-06)

- **Net-N payment terms fail closed outside payment_terms.**
  `tradeTextHasMoneyToken` refuses `Net 30` / `Nett 7` / `N/30` /
  `30 days net` and similar forms. `stripTradePackMoney` still leaves
  two-digit counts; the leftover must not ride allocated prose, identity,
  quote-pack projections, or extract leaves. Bare `net` / `netting` /
  `network` stay. Sealed phrase stays exempt only on
  `terms.payment_terms`.

Office-only `/send` / `/send-runs` / `/send-invoice` stay locked.
Post-send provider keys stay. Key-stamp ownership stays. Heartbeats
through publication stay. Money fences stay sealed.
