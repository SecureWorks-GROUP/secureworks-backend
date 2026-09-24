# Quote v2 quote records, v1 (stage 2)

Program branch `program/quote-v2` only. Nothing here is applied to production
or deployed until the owner carries the program over. Before that carry-over,
re-check the migration version against the live migration ledger (see
"Migrations Apply Before Edge Deploys" in `AGENTS.md`).

A quote is a record first: a revision on a job with its lines, the parties who
pay, and per-party totals computed once at freeze that sum to the job to the
cent. Each party reaches it through their own link, which can only ever show
and accept that party's own current revision. New tables and functions only:
the legacy `send-quote` paths, `job_documents`, `job_contacts` and
`quote_revisions` are untouched. Nothing here sends, emails, or writes jobs,
GHL or Xero. Stage 3 adds the server build, the branded page and PDF, and the
stamped send: [`server-build-and-send-v1.md`](server-build-and-send-v1.md).
Deposits are not built yet.

Schema and every rule: `supabase/migrations/20260925020000_quote_v2_records.sql`.
Executable proof: migration contract
`supabase/tests/migration-contracts/20260925020000_quote_v2_records/`.

## Records

| Table | Holds |
|---|---|
| `quote_v2_parties` | a stable person on a job (client or neighbour). Never keyed by position letter. Immutable. |
| `quote_v2_revisions` | job, revision number, family, customer-facing scope (`title`, `summary`, `inclusions`, `exclusions`, `notes` only), valid until, job totals, content hash, who prepared and froze it |
| `quote_v2_revision_parties` | which parties pay on this revision: role, name, GHL contact id at prepare time, share rule and default share in basis points |
| `quote_v2_lines` | description, qty, unit; cost to us with its source; sell basis and the markup or stated sell with who and when; line cost and sell |
| `quote_v2_line_splits` | a line's own split, overriding the default shares (a neighbour-only root removal) |
| `quote_v2_line_allocations`, `quote_v2_party_totals` | written only by the freeze |
| `quote_v2_party_links`, `quote_v2_link_revocations` | one link per party per revision; only the token's sha256 is stored |
| `quote_v2_acceptances` | one per party per revision, bound to the content hash that party accepted |

Stage 1's `quote_line_markup_overrides` now has its foreign key to
`quote_v2_revisions` and accepts rows only for a draft revision.

## Pricing a line

Cost (per unit, ex GST) comes from one of:

- `price_book`: read by the database itself through
  `quote_v2_price_book_line_cost`, never supplied by the caller. With a
  `stock_length_mm` the line buys whole stock lengths (unit `length`): the
  supplier's price for THAT length, else its generic $/LM rate, else the line
  is refused `quote_line_unpriced`. The line records item, cost row, supplier,
  rate date, blessed or provisional, and which rate basis priced it.
- `stated` (a named person and evidence), `tool` (a calculation id), or
  `none` (only with an owner-stated sell or adjustment; the owner's preview
  reads "no cost recorded", the party copy never shows it).

Sell is one of:

- `cost_markup`: unit sell = round(unit cost x markup, 4). The markup is the
  scoper's latest line override (`quote_v2_set_line_markup`, recorded with
  who, when, why and the default at the time) or the family default from
  `price_book_current_markup`. No markup (fencing today) refuses the freeze
  `quote_markup_unset`. Below 1.0 is refused.
- `stated`: a sell the owner names, with who and when (`kind: owner`, the
  only kind). A tool supplies cost and quantity, never a sell; any other
  kind is refused `quote_line_sell_kind_unknown`.
- `adjustment`: a signed amount by a named person with a reason (rounding).

Line sell = round(qty x unit sell, 2). `quote_v2_line_price_source` says in
words where every line's price came from.

## Freezing

`quote_v2_freeze_revision(revision, frozen_by, valid_until)` is the only
writer of prices, allocations and totals. It refuses: a replaced cost
(`quote_cost_stale`), a later revision already frozen, shares that do not sum
to 10,000 basis points, anything other than exactly one client, a $0 line, a
negative party share, a past valid-until date, and the same line twice (same
description and unit cost) unless the later copy carries `duplicate_ack`.

Money is split in whole cents by largest remainder, ties to the earlier party
(client first): each line across its split, then the job GST across the
parties' ex-GST shares. Job GST = round(job ex x 10%). The freeze then checks
from the stored rows that party ex, GST and inc each sum to the job and every
line's allocations sum to the line, and writes the content hash
(sha256 of `quote_v2_revision_content`). After that the revision and all its
rows are immutable, enforced by triggers even for direct SQL.

The job's current revision is its highest-numbered frozen revision.

## Party links and acceptance

- `quote_v2_issue_party_link` issues a link only for the current revision and
  a party with a non-zero share; the token is returned once.
- `quote_v2_open_party_link(token)` returns `current`, `forwarded` (a replaced
  revision's link opens the SAME party's current revision), `no_current_quote`
  (the party is not on the current revision: nothing is shown), `revoked` or
  `unknown`. The view (`quote_v2_party_view`) holds only that party's share,
  the job total, each line with their share, and the other parties by first
  name and percentage. Never a cost, markup, source, contact or token.
- `quote_v2_revoke_party_link(link, by, reason)` revokes per party per quote:
  every link that party holds for the job, forwarding links included. It
  returns how many were newly revoked; an unknown link is refused
  `quote_link_missing`. A link issued afterwards is fresh and live.
- `quote_v2_accept(token, revision_id, content_hash, name)` records one
  party's acceptance of the current revision, only if the echoed revision and
  hash are exactly current and it has not expired. Idempotent.
- `quote_v2_job_acceptance(job)`: fully accepted when every party with a
  non-zero share on the current revision has accepted it.

## Edge function `quote-v2`

`supabase/functions/quote-v2/handler.ts`. Deployed with `--no-verify-jwt`
because customers open links with no session, so staff actions never trust a
JWT claim: an exact server secret, or a session verified by
`auth.getUser`, with role admin, owner, ops_manager, estimator or sales. The
actor on a write is the signed-in user; a server caller must name
`acting_for`.

| Call | Who |
|---|---|
| `GET ?t=<token>` party page; `POST ?action=accept` | the link holder |
| `POST ?action=create_draft / set_line_markup / freeze / issue_link / revoke_link`, `GET ?action=revision / job_acceptance` | staff |

The accept response never says whether the whole job is accepted (it would
tell a neighbour whether the client has).

## Local proof

`scripts/quote-v2/test-quote-records-local.sh` applies both migrations to a
disposable local Postgres, freezes Gwelup SWF-261423 (two revisions),
SWP-26051 and Kiko (`quote_records_proof_fixture.sql`), then drives the real
handler (`quote_records_local_proof.ts`): Gwelup $4,763.00 with $2,381.50
each; SWP-26051 without the double-counted gutter beam $29,631.23 inc; Kiko
$5,786.00 inc; an old link forwards to the same party; acceptance per party.
