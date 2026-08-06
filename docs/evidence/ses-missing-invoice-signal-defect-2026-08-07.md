# DEFECT — `missing_invoice` is published for cards whose invoice exists

Status: **OPEN, fixable.** Found 2026-08-07. Not a documentation item — the
signal itself must be cured.

## The defect in one line

The board publishes `invoice_draft_qualification_reason: "missing_invoice"` for
a card whose invoice **does exist** in the Xero mirror under that card's own
reference, because two modules in the same directory disagree about what
identifies a card.

## Why this cannot be handled by warning agents

`missing_invoice` and "an invoice exists but is not bound to this card" imply
**opposite actions**, and the wrong one is money-adjacent: acting on
`missing_invoice` by minting produces a **second live draft** against work that
already has one. Three agents were warned about this by hand on the night it was
found. That protects that night only. The next agent, or the reporting skill
tomorrow, gets no warning and reads the signal at face value. A wrong signal
that is only safe because someone remembers to say so is not safe.

## Root cause — two files disagree about card identity

Both files live in `supabase/functions/ops-api/` and both answer "which
references does this card own". They answer differently.

`makesafe_docs_ready_invoice.ts:50-55` — the full card identity:

```ts
const expected = [
  detail?.external_ref,
  job?.metadata?.external_ref,
  job?.metadata?.builder_po_number,
  job?.job_number,
].map(normalizedReference).filter((value) => value.length >= 4);
```

`makesafe_invoice_reference_match.ts:148,160` — the unlinked-invoice matcher,
which reads **only** `makesafe_job_details.external_ref`:

```ts
for (const digits of builderReferenceDigits(job.external_ref)) { ... }
const referenceDigits = builderReferenceDigits(job.external_ref);
```

The narrower reading is what makes real matches disappear. It also runs against
the Captain's own 2026-08-02 ruling that **the purchase order is the instruction
key** (`CLAUDE.md`, "The Purchase Order Is The Instruction Key; The Work Order
Is The Group"): the PO is the identifying fact, and the matcher is the one place
that does not read it.

### The worked case

Three Floreat cards share the bare claim reference `MLB-27037` — SWMS-261019,
SWMS-261020, SWMS-261021 — and are distinguished only by
`jobs.metadata.builder_po_number`: `PO-56395`, `PO-56397`, `PO-56459`. Each also
carries the PO-suffixed form in `jobs.metadata.external_ref`.

Unlinked draft INV-1116 has reference `MLB-27037PO-56459`. It is unambiguously
SWMS-261021's. The matcher sees only `MLB-27037`, finds it owned by three jobs,
and excludes all three as `builder_reference_shared_with_other_job`. The
discriminator was in the card the whole time, one field over.

## Second, independent contributor

`makesafe_invoice_reference_match.ts:28-32,112-118` restricts eligibility to
`SES_ISSUED_INVOICE_STATUSES` (AUTHORISED / SUBMITTED / PAID). An unlinked
**DRAFT** is never a candidate, so no card can ever learn that its draft exists.
The board is a further step behind: `index.ts:16161-16169` loads `xero_invoices`
chunked by `job_id`, so unlinked rows are never fetched at all, and
`makesafe_docs_ready_invoice.ts:207` drops any row without a `job_id`. `CLAUDE.md`
already states that the C4 board UI must consume this matcher; it does not.

## The cure

**One producer of card-owned references, consumed by both modules.** Extract the
identity list from `makesafe_docs_ready_invoice.ts:50-55` into a single exported
function and have `builderReferenceDigits` take its input from that, so the
matcher and the qualifier can no longer disagree.

Then, separately and in this order:

1. **Cure the signal first.** Give the board the ability to say
   `unlinked_reference_match` instead of `missing_invoice` — a distinct reason
   naming the invoice it found. This is diagnosis only and **moves no card**.
2. Let the matcher resolve a contest when one matched digit run is uniquely
   owned. Guard 2 currently excludes on *any* contested run, which is what
   discards the Floreat PO discriminator.
3. Only then consider widening eligibility to unlinked DRAFT for the board's
   invoice binding.

## Blast radius, and why the order matters

Step 1 is safe: additive, placement-neutral, and independently verifiable.

Steps 2 and 3 are **not** cosmetic. The matcher is consumed by the C1 measure
entrypoint, the C2 board batch and the C3 cohort deriver
(`scripts/ses-measure-card-evidence.ts`, `scripts/ses-c2-measure-board-evidence.ts`,
`scripts/derive-ses-c3-invoice-link-cohort-v1.ts`), all of which feed a
certificated surface. Production currently holds **176** unlinked issued ACCREC
rows (158 PAID, 18 AUTHORISED) against **3** unlinked drafts, so a guard change
moves the issued population far more than the draft one. Any change to steps 2
or 3 must be bracketed by a before/after `ses-c2-measure-board-evidence.ts` run
and must bump `SES_EVIDENCE_CONTRACT_VERSION`. Those counts are read-only
production reads taken and re-read unchanged on 2026-08-07; see the provenance
section of `ses-docsready-placement-gap-2026-08-07.md` for how to re-verify them.

Do **not** fix this by relaxing the matcher's uniqueness guards wholesale. A
wrong invoice attributed to a card is worse than a card reporting its invoice
missing — that is the matcher's founding rule and it still holds.

## Verification

- Reproduce: any card with an unlinked ACCREC naming its own reference publishes
  `missing_invoice`. Live examples on 2026-08-07: SWMS-261015 (INV-1115,
  exact-reference match) and SWMS-261021 (INV-1116, PO-discriminated match).
- Fixed when: those cards publish a reason naming the invoice found, and the
  Floreat trio resolves to exactly one claimant for INV-1116 with its two
  siblings still excluded.
- Regression to add: a card whose bare claim is shared by siblings and whose PO
  uniquely names the invoice must match; the siblings must not.

## Related

- `ses-docsready-placement-gap-2026-08-07.md` — the diagnosis this came out of.
- `ses-c3-invoice-link-seal-conflict-2026-08-01.md` — why the fix is read-side
  and never a `job_id` backfill.
