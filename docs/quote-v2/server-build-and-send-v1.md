# Quote v2 server build and stamped send, v1 (stage 3)

Program branch `program/quote-v2` only. Nothing here is applied to production
or deployed until the owner carries the program over. Before that carry-over,
re-check the migration version against the live migration ledger (see
"Migrations Apply Before Edge Deploys" in `AGENTS.md`).

The iPad tools and the terminal send WHAT is being built; the server prices
it, freezes it, renders each party's quote and sends it, but only on the
owner's exact stamp. The legacy `send-quote` paths are untouched.

Schema and rules: `supabase/migrations/20260925030000_quote_v2_send.sql`.
Executable proof: migration contract
`supabase/tests/migration-contracts/20260925030000_quote_v2_send/` and
`scripts/quote-v2/test-server-build-local.sh`.

## Build from scope: `POST quote-v2?action=build`

Body: `{job_id, family, scope, parties, items, valid_until?}`. Planned by
`supabase/functions/quote-v2/scope_build.ts`, written by
`quote_v2_build_draft` in ONE transaction (draft, the scoper's markups, and
the freeze when `valid_until` is given). A refused item leaves nothing behind.

An item is one of:

| Item | Becomes |
|---|---|
| `price_book: {item_key}` + `qty` | one line costed by the database from the price book |
| `price_book: {item_key, cut: {pieces, stock_lengths_mm?, rule?}}` | the ONE cut-to-order function, then one line per stock length bought, each costed at that length's own price (`key@length_mm`) |
| `cost: {source: stated or tool, ...}` + `qty` | a stated or tool cost, as stage 2 |
| `sell: {basis: stated or adjustment, ...}` | an owner-stated sell or adjustment, as stage 2 |

Sell defaults to cost x markup. `markup: {multiplier, reason?}` is the
scoper's markup for that item (every generated line), recorded with the
signed-in caller as who set it; the family default applies otherwise. A
tool never supplies a sell. To re-quote the same people, name their
`party_id`s so their old links forward to the new revision.

## Rendering

`quote_v2_party_document(revision, party)` is the party view (never a cost,
markup, source, contact or token) plus the issue day. From it:

- `quote_document.ts`: the branded HTML (the approved round-2 quote design:
  slate header, white logo, prepared for, what it costs, your investment or
  your share, included and not included, how to accept, and the seventeen
  approved fencing terms for fencing and Stratco work only; patio has no
  approved terms yet, so none are printed).
- `quote_pdf.ts`: the same content as an A4 PDF (jsPDF, embedded Plus
  Jakarta Sans and logo from `brand/assets.ts`, generated from the fence quote
  skill's assets). Creation date and file id come from the revision, so the
  same revision renders the same bytes.

The party link page (`GET ?t=`) is that document plus Accept; `&format=pdf`
serves the PDF. Staff preview: `GET ?action=render&revision_id&party_id&format`.

## Stamped send

1. `POST ?action=prepare_send {revision_id, parties: [{party_id,
   recipients: [{channel: email|sms, to}]}], from_name?, note?, adapter?}`.
   The server renders every paying party's HTML and PDF, hashes both, builds
   their email and SMS (`send_message.ts`, carrying the literal
   `{{quote_link}}`), and `quote_v2_prepare_send` stores the preview: exact
   recipients (an SMS names the party's GHL contact), each party's amounts
   from the frozen totals, the messages, the document hashes, the adapter and
   an expiry. `preview_hash` is sha256 of the stored preview. Every party with
   a share needs a recipient; a party with none is sent nothing.
2. `POST ?action=approve_send {preview_id, preview_hash}`: the owner's stamp.
   Only a verified session whose email is on `QUOTE_V2_SEND_APPROVER_EMAILS`
   (default the owner) may stamp, never a server key; the echoed hash must
   match, the preview must be unexpired and its revision still current.
3. `POST ?action=send {preview_id, preview_hash}`: `quote_v2_execute_send`
   issues each party a fresh link, replaces `{{quote_link}}`, and writes every
   message to `quote_v2_outbox`, once. A retry returns the same send and
   writes, links and delivers nothing. A quote that changed after the stamp
   refuses `quote_send_revision_changed`.

## Delivery: capture by default

A send's adapter is fixed in its preview, so the stamp says whether anything
is delivered.

- `capture` (default): messages are written to `quote_v2_outbox` and nothing
  ever delivers them; the database refuses a delivery record for them.
- `live`: Resend email (idempotency key per outbox row) and GHL SMS through
  `_shared/sms_from_number.ts`. Allowed only when `QUOTE_V2_ENVIRONMENT=staging`,
  `QUOTE_V2_LIVE_DELIVERY=staging-only-enabled` and `SUPABASE_URL` is not the
  production project (`delivery.ts`). A timed-out provider call is recorded
  `unknown` and never retried automatically. No part of this program sets
  those flags.

The outbox holds the party's link in the body, so it is as private as sent
mail: service role only, append-only.

## Speed (local proof, disposable Postgres)

Gwelup SWF-261423, two parties, build + freeze + render both parties' HTML
and PDF + preview + stamp + send to outbox: about 150 ms cold and 80 ms warm
on one connection. Deployed, each of the four calls adds a network round trip.
The latest figures are in the proof's `proof-results.json`.
