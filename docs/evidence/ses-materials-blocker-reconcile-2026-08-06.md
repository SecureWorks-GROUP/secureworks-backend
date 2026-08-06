# Settled money and shipped packs answer the materials question (2026-08-06)

## The question

`materials_charge_figure_required` blocked Queens Park `SWMS-26845` and Herne
Hill `SWMS-26955`, both of which carry an AUTHORISED invoice that already prices
their materials. Is the blocker telling the truth?

**No. On both cards the blocker is spurious.** The materials figure is not
missing — it exists, itemised, on committed money, and it matches the trade
evidence line for line. The assembler could not see it because nothing joined
the docket pricing path to `xero_invoices`.

Two cards that arrived mid-task, Woodvale `SWMS-261128` and Ballajura
`SWMS-26902`, sharpened that into a second and stronger rule: both had already
SHIPPED to the builder and been billed, and were still being asked to price.

## What the money says (live, read-only, 2026-08-06)

| Card | Suburb | Trade recorded `materials_used` | Issued invoice materials lines |
|---|---|---|---|
| `SWMS-26845` | Queens Park | Temp fence panels x 2; Star picket x 2; Zip ties x 20; Fixings / consumables | `INV-0942` AUTHORISED — fence hire 2 panels $120, star pickets 2 units $27, cable ties and small consumables $25 = **$172 ex** |
| `SWMS-26955` | Herne Hill | 15mm Plyboard x 2; 90 x 35 H3 2.4m x 5; Bugles (25pk) x 1; Fixings / consumables | `INV-0994` AUTHORISED — "Materials: 15mm plyboard x2, 90x35 H3 framing x5, bugles, fixings/consumables" = **$270 ex** (disposal $35 is a service, excluded) |

Every recorded material has a priced counterpart on the authorised invoice. The
persisted docket proposals on both cards, meanwhile, are labour-only $510 —
which is exactly the silent omission the guard exists to prevent, and is also
not the money that was actually billed ($512 ex and $900 ex respectively).

Queens Park has **zero** release route proofs, confirming the Captain's ruling
that it was never sent. Herne Hill likewise.

## Two rules, not one

### 1. Terminal — a shipped and billed cycle is never asked to price

`readSesReleasedCycleEvidence` (`ses_invoiced_materials_evidence.ts`). A card
whose CURRENT attendance cycle has a release route proof AND an issued ACCREC
invoice has nothing left to price. Anyone who supplied a figure would have
double-billed the builder.

This rule reaches cards the invoice rule cannot: **all eight** already-sent
cards mirror ZERO invoice line items, so their money is unreadable line by line.
It holds regardless of where the materials decision was recorded, which is what
makes it stronger than chasing the `materials_charge` marker seam.

Two boundaries are load-bearing:

- **Proven, never inferred.** The proof is a `ses_release_route_proofs` row,
  which carries `job_id`. Do NOT reach for `ses_external_effects`: measured
  2026-08-06, its `job_id` is NULL on **all 41** `route_send` rows, so a job
  join there reads as "nothing was ever sent".
- **Cycle-scoped.** Only a proof naming the card's CURRENT cycle settles it. A
  re-attendance legitimately reopens a card that already shipped, and the new
  cycle's materials are a genuine new question.

### 2. Itemised invoice — committed money is an answer

`readSesInvoicedMaterialsEvidence`. A single issued ACCREC invoice bound to the
card, every line of which this reading can account for, and at least one of
which prices materials.

**The distinction that matters: a labour-only invoice must never silence a
materials question.** It does not, and cannot:

- Lines are classified labour → excluded service → materials → unrecognised,
  and **labour is checked first**, so a works narrative that mentions installed
  materials while billing hours can never pay for itself.
- Disposal and other charged services are recognised only so they cannot be
  silently counted into a materials figure. Labour + disposal is still
  `invoice_prices_no_materials`.
- An unrecognised line refuses the WHOLE reading rather than yielding a partial
  total presented as a whole one. Two real production wordings ("Mould
  remediation spray", "polyweave and staples") do exactly this today.
- DRAFT / SUBMITTED / VOIDED, ACCPAY bills, two issued invoices on one card,
  absent mirrored lines and a $0 materials line all refuse.

Pinned in `ses_invoiced_materials_evidence_test.ts` (15 tests) and
`ses_materials_charge_guard_test.ts`.

## Precedence, and what does NOT change

```
released cycle (no standing decision)  -> already_released   record, add nothing
standing operator decision             -> unchanged behaviour
typed priced materials lines           -> unchanged behaviour
issued invoice prices materials        -> already_invoiced   record, add nothing
otherwise                              -> ask (today's blocker, unchanged)
```

- **Neither reading ever adds money to a proposal.** The materials are already
  billed; a second charge line is what a later mint would double-bill. Both
  record a provenanced marker naming the invoice, so the proposal is explicit
  rather than silently labour-only.
- **Neither reading rewrites a decision a card already carried.** Mosman Park
  `SWMS-261147` and Gidgegannup `SWMS-26953` shipped WITH a materials charge
  line; terminal stands aside so they reproduce the figure they were billed
  under. Overriding would rewrite a shipped docket and drop its signoff.
- A figure supplied on THIS request against a released cycle is refused loudly
  as `materials_charge_figure_unsupported` — the Koondoola trap.
- Neither marker is ever inherited (`carriedMaterialsChargeDecision` returns
  null for both), so a voided invoice or a re-attendance can reopen the
  question, and a zero-charge marker can never read back as an operator NONE
  nobody decided.
- A card nobody can settle hashes **byte-identically to today**, so no
  still-to-be-priced revision is re-keyed and no Docs Ready tick is lost. A
  settled one does move identity, deliberately: otherwise a blocked revision and
  the settled one collide on a single revision id.

## Measured effect (33 `standard_labour_materials` cards, live 2026-08-06)

Reproduce read-only with
`SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read
scripts/ses-materials-blocker-reconcile-measure.ts`. It runs the shipped
readers over live rows rather than restating their rules.

| Outcome | Cards |
|---|---|
| `already_released` (terminal) | **8** — Maylands 261017, Floreat 261020, Munster 261065, Floreat 261080, Morley 261115, Woodvale 261128, Carine 261129, Ballajura 26902 |
| `already_invoiced` (itemised) | **17** — including Queens Park 26845 ($172) and Herne Hill 26955 ($270) |
| `ask` (honest refusal, unchanged) | 4 — Tuart Hill 261015, Midland 261029 (no issued invoice); Tapping 261038, Morley 26919 (unrecognised invoice line) |
| already carries a decision (untouched) | 4 — Floreat 261021, Koondoola 261025, Mosman Park 261147, Gidgegannup 26953 |

**25 cards clear, of which the two this task asked about are 2.** The terminal
rule alone clears **8**, and it is the only rule that reaches any of them.

### The 4 that still ask are CORRECT, not unfinished

They are not a gap in the change; they are the change working. Nothing has
settled these cards, so a human still has to price them — which is exactly what
the guard is for.

| Card | Suburb | What it still asks for | Why that is right |
|---|---|---|---|
| `SWMS-261015` | Tuart Hill | one materials figure ex GST | No AUTHORISED or PAID ACCREC invoice exists. There is no committed money to read, and no send. Nothing has answered. |
| `SWMS-261029` | Midland | one materials figure ex GST | Same: no issued invoice, no send. |
| `SWMS-261038` | Tapping | one materials figure ex GST | `INV-1039` is issued, but its `Mould remediation spray` line is not classifiable as labour, materials or a charged service. Reading a total from the rest would present a partial reading as a whole one. **Fails closed on purpose.** |
| `SWMS-26919` | Morley | one materials figure ex GST | Same shape: `INV-0971`'s `polyweave and staples` line is unrecognised. |

The last two are the deliberate design decision. The materials vocabulary is
generic (`materials`, `consumables`, `fixings`, `supplied`, `hire`, `sundries`)
rather than a goods catalogue, because a product list is always incomplete and
an incomplete list fails OPEN — it would silently drop real materials out of the
total. Widening it to recognise these two wordings is a judgement about money on
a builder invoice, and the honest answer is to let a human make it.

Koondoola `SWMS-261025` is provably untouched: it already carries a `none`
decision, so both readings stand down.

## Permanent rule, or interim bridge?

**Permanent, and it must sit ABOVE derivation.**

The Captain's 2026-08-06 ruling reshapes the blocker into a derived, proposed
priced line the Captain approves in the cockpit
(`data/decisions/2026-08-06-materials-proposed-not-blocking.md`). That path is a
separate task, blocked on the rate card. It does not replace either rule here:

- **Terminal is permanent by construction.** Deriving a proposed materials price
  for a cycle that has already shipped and been billed would put a second figure
  in front of the Captain for money already committed. The correct behaviour on
  a settled cycle is to propose nothing, forever.
- **The itemised-invoice reading is permanent for the same reason.** Where a
  human already priced the materials, authorised the invoice and billed the
  builder, a derived figure is not a better answer — it is a competing one, and
  approving it is the double-bill. Committed money outranks derivation.

So the precedence the derived path should inherit is: **released cycle →
operator decision → committed invoice money → derived proposal → ask.**
Derivation replaces only the last step, the bare ask.

The labour-only distinction is the guard the derived path will need too, in the
same shape: before proposing a materials price, it must establish that the
materials are not already priced somewhere. `classifySesInvoiceLineDescription`
and its unrecognised-fails-closed rule are reusable for exactly that.

## Files

- `supabase/functions/ops-api/ses_invoiced_materials_evidence.ts` — both pure
  readers and the line classifier.
- `supabase/functions/ops-api/ses_materials_charge_guard.ts` — `already_released`
  / `already_invoiced` actions, markers, and the precedence.
- `supabase/functions/ops-api/ses_prepare_docket_revision.ts` — resolution gate
  and revision-identity fold.
- `supabase/functions/ops-api/ses_assembler_input_adapter.ts` — the read-only
  binding. Note `xero_invoice_id` is the LIVE column name; there is no
  `invoice_id` on `xero_invoices` and selecting one is a production 400 that
  reads as "this card has no invoice".
- `scripts/ses-materials-blocker-reconcile-measure.ts` — read-only re-measure.

No migration. No production write. The sealed SES money fence is not engaged:
both readers inspect records that already exist and write nothing — no Xero
call, no mirror write, no invoice link.
