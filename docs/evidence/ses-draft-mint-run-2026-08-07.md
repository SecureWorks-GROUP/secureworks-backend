# SES draft mint run, 2026-08-07

Authority: the Captain's word for **all draft invoices** ("auto approve the drafts",
"draft minting is the skill's job"). Scope was DRAFTS ONLY. Nothing was authorised,
sent, voided, re-priced or approved by this run.

Run against production `ops-api` **v1068** (`ae4c469d`, deployed 00:18:48Z), so the
keyed Xero retry was live and a rate-limited retry could not become a duplicate.

## Result

**One draft minted. Eight cards refused, every refusal named.**

| Card | Suburb | Family | Outcome |
|---|---|---|---|
| `SWMS-261029` | Midland | repair | **MINTED `INV-1155` DRAFT $935 inc** |
| `SWMS-261116` | Morley | roof report | refused — no portal capture this cycle |
| `SWMS-261079` | Floreat | roof report | refused — no portal capture this cycle |
| `SWMS-261019` | Floreat | roof report | refused — no portal capture this cycle |
| `SWMS-261028` | Success | physical | refused — own AUTHORISED `INV-1050` $330 |
| `SWMS-261157` | Duncraig | physical | refused — curated source + materials charge |
| `SWMS-261140` | Ocean Reef | temporary fencing | refused — curated source + pricing floor |
| `SWMS-26804` | Booragoon | physical | refused — six spine blockers |
| `SWMS-261024` | Koondoola | physical | refused — AUTHORISED `INV-1081` $3,861 |

Exactly one row was created in `xero_invoices` during the run window, confirmed by a
read of everything created in the preceding two hours.

## Targets came from reference search and route proofs, never from `missing_invoice`

The board publishes `invoice_draft_qualification_reason: missing_invoice` on cards that
already hold live money, so it was not used to select anything. Every candidate was
screened two ways before any write:

1. A direct `xero_invoices` scan on the digit runs of the card's claim and PO.
2. The machinery's own duplicate probe, called with the **PO-grain** reference the
   obligation would compose.

Route proofs were read through `makesafe_release_revision_members` (never through
`ses_external_effects.job_id`, which is NULL on every `route_send` row). No candidate had
a route proof: nothing in this pool had been sent.

### Three candidate families share a reference run

Stated rather than resolved silently, because a claim-only match would have refused
mintable cards:

| Claim | Cards | Money on the claim |
|---|---|---|
| `MLB-27387` | `SWMS-261116` (own **PO-57525**), `SWMS-261115` | AUTHORISED `INV-1128` $525.25, attributed to `SWMS-261115` |
| `MLB-27148` | `SWMS-261079` (own **PO-57210**), `SWMS-261080` | AUTHORISED `INV-1126` $330, attributed to `SWMS-261080` |
| `MLB-27037` | `SWMS-261019` (own **PO-56395**), `SWMS-261020`, `SWMS-261021` | AUTHORISED `INV-1127` $374 (to `SWMS-261020`); unlinked DRAFT `INV-1116` `MLB-27037PO-56459` |

With the PO grain applied the probe returned `allows_create: true` for all three, naming
`different_po_sibling_does_not_block` on `SWMS-261019`. **None of the three was refused
for money.** The contrast case is `SWMS-261028`, blocked at tier `job_id` on its own
AUTHORISED `INV-1050` — money on the card itself, not on a sibling.

## Chunk 1 — four cards

Chunk size four, per the pre-positioned plan: a part-way failure is not cleanly
resumable, and four keeps recovery to minutes of hand-work.

### `SWMS-261029` Midland — minted

- Obligation prepared on docket `8795afb5`, revision `78353280-dad2-52ee-b8a0-b020445f6944`,
  no blockers, duplicate probe clear.
- `create_ses_invoice_draft` returned `xero_draft_created`: **`INV-1155`**, DRAFT, $935 inc,
  reference `MLB-25147`, line `MLB-25147 - make-safe attendance - 2 trades x 5 hours`
  (10 × $85 ex). Draft PDF stored as a docket artifact. `send_dispatched: false`.
- The full live-ACCREC duplicate guard scanned 1180 rows before the create.

**Docs Ready after mint: still Trade Report In, and correctly so.** The card now reads
`invoice_raw_status: DRAFT` / `qualifying_draft`, but the v2 engine's Docs Ready rule for
physical-shaped families also requires the invoice DOCUMENT on the pack
(`closeout_documents.invoice` is false). That PDF is attached at APPROVE INVOICE, which
this run deliberately did not do. Roof cards `SWMS-261114` / `SWMS-261081` place at
`report_ready` on a draft alone because the non-physical branch does not require it.

Noted, not acted on: `INV-1155` carries the bare claim `MLB-25147` because the card has no
intake-case PO to compose from, although its work-order filename carries `PO-56236`. No
collision exists today, and the reference composition is the machinery's to change.

### `SWMS-261116` / `SWMS-261079` / `SWMS-261019` — refused, portal capture

Portal-truth guard (item 14): a report-type card cannot have a draft cut without a
portal-locked capture recorded for the current cycle. All three have `portal_verified_at`
NULL; the two cards that DO place (`SWMS-261114`, `SWMS-261081`) both carry a recorded
locked-form observation.

The refusal was proved live on `SWMS-261116`: it returned before any Xero call, and no
invoice exists under `MLB-27387PO-57525`. The attempt was **not** repeated on `SWMS-261079`
and `SWMS-261019` — the guard reads exactly the two columns already read, and each attempt
costs an obligation revision plus an `unknown` effect for no new information.

Two consequences worth carrying forward:

- `SWMS-261116` now holds one `invoice_create` effect in state `unknown`
  (`external_id: null`, nothing in Xero). Per the documented behaviour, minting it later
  needs a fresh obligation revision — which `prepare_ses_invoice_obligation` produces anyway.
- The board reports `pre_xero_docs_ready: true` on all three. That signal does not include
  the portal capture, so these cards look ready and cannot be invoiced. Recording a
  compliant capture has no sanctioned writer today, so this was left alone rather than
  improvised.

## Chunk 2 — four cards, none minted

Money checked first with the PO grain on all four. `SWMS-261157`, `SWMS-261140` and
`SWMS-26804` carry no money at all; they fail on pack, not on money. Their reasons come
from `prepare_ses_docket_revision` dry runs, which write nothing.

| Card | Reason codes |
|---|---|
| `SWMS-261157` Duncraig | `curated_source_missing`, `materials_charge_figure_required` |
| `SWMS-261140` Ocean Reef | `curated_source_missing`, `pricing_evidence_missing` |
| `SWMS-26804` Booragoon | `spine_missing_source` ×2, `spine_missing_lineage`, `spine_missing_deliverables`, `swms_generation_facts_missing`, `invoice_reference_missing` |
| `SWMS-261024` Koondoola | `blocked_duplicate_live` — AUTHORISED `INV-1081` $3,861 under its own `PO-56479`, unlinked |

- **Duncraig** is a Captain question, not a defect. The trade recorded materials and the
  proposal prices labour only; the guard wants one ex-GST figure or an explicit no-charge
  decision. It was not answered on the Captain's behalf.
- **Ocean Reef** is the temporary-fencing pricing floor: panel and base counts have a
  reader and no producer anywhere in the system. No rerun clears it.
- **Booragoon** has no canonical builder reference at all. That is spine repair, not
  invoicing.
- **Koondoola `SWMS-261024`**'s money is unlinked (`job_id` NULL), which is why it presents
  as a duplicate block rather than as the card's own invoice.

## Pool exhaustion

All 11 active Trade Report In cards are adjudicated. Allocated held exactly two packs that
looked ready and both are accounted for: `SWMS-261025` is a Captain hold, and
`SWMS-261131` High Wycombe already holds AUTHORISED `INV-1111` $286.

Untouched throughout, as instructed: `SWMS-261025`, `SWMS-26931`, `SWMS-261018`,
`SWMS-26845`, `SWMS-261015`, `SWMS-261021`, and the two approvable cards behind
`INV-1149` / `INV-1150`.

## What the run says about the board

The realistic pool was single figures and it produced one draft. The binding constraint
was never minting capacity — it was evidence:

- Three cards are one recorded portal capture away, and the capture has no sanctioned
  writer.
- One card is one Captain figure away.
- One card is a pricing input that no producer writes.
- One card needs its spine repaired before money can be described at all.
- Three cards already have their money.

None of that is fixable by minting harder.
