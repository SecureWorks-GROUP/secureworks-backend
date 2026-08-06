# SES reference identity: the purchase order joins the matcher (2026-08-07)

Read-only measurement against live production (Management API, `read_only: true`),
plus the served ops-api cockpit and Docs Ready queue. No client name, phone,
email or street address appears here.

## What was asked, and what the measurement found

The brief named one defect with three faces: the system disagreeing with itself
about what identifies a card, said to (1) block placement on two cards, (2)
invite a double-bill on 16 Docs Ready cards, and (3) cap tonight's funnel at 8
instead of 21.

The identity disagreement is **real and is now closed**. The three faces are
**three different mechanisms**, and the identity fix reaches none of them. That
is the central finding of this document, and it is measured rather than argued.

## 1. Every identity consumer, and the field each reads

| Consumer | Reads | Runtime? |
| --- | --- | --- |
| `makesafe_docs_ready_invoice.ts` `makesafeInvoiceReferenceMatchesCard` | `detail.external_ref`, `job.metadata.external_ref`, **`job.metadata.builder_po_number`**, `job.job_number` | **yes** — ladder + `enrichMakesafeBoardJob` |
| `makesafe_invoice_reference_match.ts` | `makesafe_job_details.external_ref` — **and now `jobs.metadata.builder_po_number`** | no |
| `makesafe_evidence_requirements.ts` (C1 ruler) | names the matcher in a comment only; consumes no identity field itself | no |
| `scripts/ses-measure-card-evidence.ts` (C1) | `external_ref` (deliberately, see below) | no |
| `scripts/ses-c2-measure-board-evidence.ts` (C2) | `external_ref` + `builder_po_number` | no |
| `scripts/derive-ses-c3-invoice-link-cohort-v1.ts` (C3) | `external_ref` + `builder_po_number` | no |
| `ses_review_cockpit.ts` | neither — it reasons from `docket.xero_binding` alone | **yes** |

Two structural facts fall out and are worth more than the fix itself:

- **Nothing under `supabase/functions/` imports the matcher.** Its only consumers
  are the three measurement scripts. It cannot place a card and cannot reach the
  cockpit.
- **The matcher only ever sees UNLINKED invoices.** `isUnlinkedIssuedAccrec`
  refuses any row carrying a `job_id`.

## 2. The change

`sesMatchJobIdentityDigits` unites the claim reference and the card's own
purchase order into one **de-duplicated** digit set, used by both the ownership
map (guard 2) and the candidate step (guard 1).

The de-duplication is load-bearing. 30 of the 67 PO-bearing production rows have
an `external_ref` that already embeds the same PO (`MLB-24881PO-56387` with
`builder_po_number: PO-56387`). Concatenating without a set yields the run
`56387` twice, the ownership map counts the card as two owners of its own digits,
and guard 2 reads that self-collision as a contest. Measured against live
production, the naive version **destroyed SWMS-261018's correct match to its own
AUTHORISED INV-1083**. Both regression tests were mutation-checked: they go red
when the `new Set` is removed.

## 3. Blast radius, with direction

| Measurement | Baseline | With the PO | Direction |
| --- | --- | --- | --- |
| Matches (2414 jobs x 176 unlinked issued ACCREC) | 51 | 51 | none |
| Exclusions | 30 | 30 | none |
| Matches gained | — | **0** | — |
| Matches lost | — | **0** | — |
| Matches reassigned | — | **0** | — |
| C2 board evidence, 420 cards | pass 150 / fail 62 / undetermined 189 / refused 19 | identical | none |

The C2 run's **content-derived generation id is identical on both sides**
(`51ac167b20088c09a6eeecfa47ee9a8c55a0dd8a29bc05377afaba774a56d701`), and the
normalised 420-card output files are byte-for-byte equal
(sha256 `2839e4b53bba6188da3e7f8a8c1736935ba1a7f6318c0b935aa8c7d51e7f632d`).

**Why zero:** all 67 PO-bearing jobs also carry an `external_ref`, so the PO
never supplies identity where none existed. It only widens it, and a widened
identity gives the guards strictly more ways to refuse, never a new way to match.

### Proof that no card became more approvable

Three independent arguments, any one of which is sufficient:

1. **Structural.** The matcher has no runtime consumer. Placement binds an
   invoice through `invoiceForStage`, which requires exact `xero_invoices.job_id`;
   the cockpit reasons from `docket.xero_binding`. Neither consults the matcher.
2. **Measured.** Not one of the 420 cards changed evidence verdict, in either
   direction. The measurement output is byte-identical.
3. **By construction.** A card can only gain a match by being *card-unique*, and
   guard 2 now has strictly more digit runs on which to find a contest. The four
   do-not-touch cards were checked individually and are unchanged
   (SWMS-261018 matched INV-1083; SWMS-261025 excluded `multiple_invoice_candidates`;
   SWMS-26931 matched INV-1051; SWMS-26845 silent).

The C1 single-card entrypoint deliberately still supplies `external_ref` alone.
That is safe by construction, not by luck — an absent PO contributes no digits,
pinned by `an absent PO leaves the production cohort byte-identical`. Plumbing it
needs a `SUPABASE_SERVICE_ROLE_KEY` this lane does not hold, so it could not be
proved live; see Tier 2.

## 4. The three faces, as measured

**Face 1 — placement.** Tuart Hill SWMS-261015 and Floreat SWMS-261021 do have
real unlinked Xero invoices — INV-1115 ($464.75) and INV-1116 ($330.00) — but
both are **DRAFT**. The matcher's scope is issued money only
(`SES_ISSUED_INVOICE_STATUSES`), and placement requires the `job_id` link the SES
money seal refuses to write. The identity field is not what blocks them. Every
route to unblocking them is a widening: extend the matcher to DRAFT, wire it into
placement, or backfill the seal. All three make cards more approvable, which the
brief forbids and the money seal separately forbids.

**Face 2 — the double-bill invitation.** Reproduced live: 16 of the 19 Docs Ready
`needs_review` cards return `"No Xero DRAFT invoice is bound to this card yet.
Mint the draft first, then approve it."` **11 of those 16 already carry a LINKED
live ACCREC** — 7 PAID, 4 AUTHORISED — including SWMS-26841, whose invoice
INV-0850 is PAID at $882.20. Because those invoices are linked
(`xero_invoices.job_id` set), the matcher is structurally incapable of reaching
them. This is a cockpit-binding defect, and its cure is the additive cockpit
refusal landing on `fm/system-manufactured-blockers-v1`.

**Face 3 — the 8 → 21 ceiling.** Depends entirely on face 1, so it does not move.

**The shared claim is not rescued by the PO.** The three Floreat cards
(SWMS-261019 / 261020 / 261021) share `MLB-27037` and differ only by PO. The one
eligible invoice still names the shared claim, so it is a candidate for all three
and none owns it uniquely. Withholding is the correct answer;
`siblings on one claim stay excluded when the PO cannot separate them` pins it so
nobody later "fixes" it by preferring the PO-matching candidate — that would
attribute money to a card on evidence that does not single it out.

## 5. The caseless portal capture

Rode with this change, as diagnosis only.

`buildSesAssemblerInput` falls back to `makesafe_job_details.external_ref` only
behind a `legacy_job_record` identity revision, so a card with neither an intake
case nor an identity revision derives an empty `builder_reference` — and stores
its portal captures under it. Measured: **21 of the 28 persisted capture rows,
across 8 cards** (SWMS-26728, 26732, 26740, 26748, 26852, 26853, 26859, 26934),
every one caseless with no identity revision, while each card carries a perfectly
good `external_ref`.

`resolvePersistedPortalCapture` compares `builder_reference` as one of five
selection coordinates but the "missing" signal named only the other four. Those
21 rows resolve today only because both sides derive the same empty string; the
moment a card gains an intake case or a seeded identity revision they all become
unmatchable at once and read as "no capture was ever taken" — whose apparent cure
is to capture again, producing another row rejected identically and invisibly.

The fix names the coordinate that rejected the capture and rules out re-capturing
in the same sentence. **The verdict is untouched**: the capture stays `missing`,
the blocker still fires, no card becomes more sendable. The signal is
byte-identical on every card not hit by this defect, so no other docket's output
moves.

Both alternative repairs were rejected and should stay rejected: accepting a
reference-mismatched row admits evidence the selector rejects, and widening the
adapter's fallback changes `source.builder_reference`, which is inside the docket
INPUT hash and would re-key every revision and drop every Docs Ready signoff.

## 6. Re-proving this

```bash
# identity cohort, read-only (Management API)
SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read --allow-write \
  scripts/derive-ses-c3-invoice-link-cohort-v1.ts --out=/tmp/c3.json
# board-wide evidence; the generation id must reproduce
SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read --allow-write \
  scripts/ses-c2-measure-board-evidence.ts
deno test --allow-read --allow-net --config deno.jsonc \
  supabase/functions/ops-api/makesafe_invoice_reference_match_test.ts
```

## 7. Tier 2 — named first-live-proofs

| Item | Trigger |
| --- | --- |
| C1 `ses-measure-card-evidence.ts` supplying `builder_po_number` | needs `SUPABASE_SERVICE_ROLE_KEY`; prove on the next single-card C1 run, and expect no change (the C2 batch already measures the PO-aware universe) |
| `missingCaptureSignal` firing on a real rejected capture | fires the first time one of the 8 caseless cards gains an intake case or a seeded identity revision; until then it is unreachable in production by construction |

## 8. Out of scope, deliberately

No mint, void, approve, authorise, send or re-price. No migration. The duplicate
guard, the sealed money fence, the evidence checks and every send gate are
untouched. `fm/system-manufactured-blockers-v1` and
`fm/docsready-placement-gap-v1` were not touched.
