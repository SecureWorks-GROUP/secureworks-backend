# Quote v2 price book, v1 (stage 1)

Program branch `program/quote-v2` only. Nothing here is applied to production
or deployed until the owner carries the program over. Before that carry-over,
re-check the migration version against the live migration ledger (see "Migrations
Apply Before Edge Deploys" in `AGENTS.md`).

## What it is

One database home for what materials and labour **cost us**, with full history,
that every quoting tool and the terminal read. Owner, 24 Sep 2026: "I just want
the tools to capture the accurate pricing of the costs to us. And we can add the
markup of what we want."

- Cost is the primary value. Markup is a separate layer: a default per family,
  adjustable per quote line by the scoper, recorded with who set it.
- A sell rate is never stored as a cost and never back-computed into one. The
  tools' current sell rates (fencing $125/m and the rest) are listed as legacy
  sell rates in the import diff report.

## Tables (`supabase/migrations/20260925010000_quote_price_book.sql`)

| Table | Holds |
|---|---|
| `price_book_items` | item identity: key, family (fencing, patio, stratco, misc), category, unit. Immutable. |
| `price_book_costs` | cost ex GST per item unit, supplier and code, the stock length it was for (`per_length_mm`), as-at date, evidence, provisional or blessed |
| `price_book_stock_lengths` | lengths a supplier sells an item in (mm, ascending) |
| `price_book_cut_rules` | `one_per_stick`, `nest` (with saw kerf) or `cut_to_size` |
| `price_book_markup_rules` | one markup multiplier default per family |
| `price_book_allowances` | job-family allowances: flashing by girth band per metre, per m2 of girth, fixings per m2, sundries per job |
| `price_book_proposals`, `price_book_proposal_decisions` | a proposed change (old vs new, who proposed) and its decision |
| `price_book_approvers` | who may approve, by scope (any, family, supplier, target). Seeded empty: who approves is an open owner call. |
| `quote_line_markup_overrides` | the scoper's markup for one quote line, who set it and why. No foreign key until quote records land (stage 2). |

Rules the database enforces:

- **Append-only.** UPDATE, DELETE and TRUNCATE raise `price_book_append_only`
  on every table. A change is a new dated row.
- **No zero cost.** `cost_ex_gst > 0`. An item with no cost reads `unpriced`.
- **Evidence on every row**, and a blessed row names who blessed it and when.
- **Private.** RLS on; no `anon` or `authenticated` access; `service_role` may
  read and append only.
- A line markup below 1.0 (selling under cost) is refused.

## Which price is current

`price_book_current_costs(item_keys?, family?)`:

1. the newest **blessed** row; otherwise
2. the provisional row with the strongest evidence (invoice or purchase order,
   then supplier quote or estimate, then price list, then owner stated, then
   tool constant), newest first, then the longest stock length;
3. no row at all: `status = 'unpriced'`, cost null.

A provisional row newer than the blessed current row is returned as
`newer_provisional_row_id`, so nobody mistakes a blessed price for the latest
evidence. Stock lengths follow the current cost's supplier when that supplier
has a list.

`price_book_current_markup(family)`, `price_book_line_markup(...)`
(the line override, else the default, and which one it used) and
`price_book_current_allowances(family?)` follow the same blessed-first rule.

## Changing a price

`price_book_propose(target, subject, new_value, reason, evidence_ref, proposed_by)`
captures the row it would replace. `price_book_decide_proposal(id, decision,
decided_by)` approves, rejects or withdraws (withdraw: proposer only). Approval
needs a matching active row in `price_book_approvers`, refuses a proposal whose
current row changed since it was made (`price_book_proposal_stale`), and inserts
the new value as a blessed row. Nothing is overwritten.

## Default markups (seeded by the migration)

| Family | Default | Status |
|---|---|---|
| patio | x1.35 (patio tool) | provisional, for the patio lead to set. The unused engine says 1.5 (10 Aug); a real April quote used 1.25. |
| stratco | x1.40 | provisional (hold H4) |
| fencing | not set | fencing sells by an agreed rate per metre today; the owner sets markup once costs are reviewed |
| misc | not set | |

## Cut to order

`supabase/functions/_shared/price_book/cut_to_order.ts` is the ONE function that
turns required lengths into order lengths plus waste. Ported from the patio
tool's `nestCuts` (commit `884a208`) and parity-tested against a verbatim copy.
Waste is what we pay for and do not install (kerf included).

Proofs (`cut_to_order_test.ts`): Kiko slats 101 pieces nest into 27 bars of
6100 mm at 4.1% waste; 6 m of 100x50 buys one 6.5 m length from 5500/6500/8000
(the 0.5 m offcut costs $13.29 at $26.57/LM); 4.8 m buys 5.5 m.

## Read action: `price-book` edge function

`supabase/functions/price-book/handler.ts`. Read-only. Server secrets and staff,
estimator and sales sessions only (cost prices are internal; trades and the
public `SW_API_KEY` are refused). Deploy with JWT verification on.

| Call | Returns |
|---|---|
| `GET ?action=current[&item_keys=a,b][&family=]` | current cost per item, counts by status, unknown keys named |
| `GET ?action=markup&family=` | default markup |
| `GET ?action=allowances[&family=]` | current allowances |
| `POST ?action=cut {item_key, pieces, stock_lengths_mm?, rule?}` | order lengths and waste from the item's stock list and cut rule, costed when the item is priced per metre |

## Import from the ten current stores

`scripts/quote-v2/price_book_import.ts`, dry run by default; `--apply` only to a
localhost database. Extractors: `price_book_sources.ts`; which item an
observation is about: `price_book_catalog.ts`; rows and the diff report:
`price_book_plan.ts`. All rows load provisional; a source comment saying
"blessed" is reported, not trusted. Delivery lines on supplier invoices carry
client street addresses and are replaced, never copied. Local proof:
`scripts/quote-v2/test-price-book-local.sh`. First diff report:
`docs/quote-v2/price-diff-2026-09-24.md`.
