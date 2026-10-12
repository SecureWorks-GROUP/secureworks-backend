# Roof re-mint of three cards, 2026-08-07 — 0 minted, all three held by the item-14 portal-truth guard

Task: mint DRAFT invoices for `SWMS-261116` (Morley), `SWMS-261079` (Floreat),
`SWMS-261019` (Floreat). Drafts only, no authorise/send/void/re-price.

**Result: 0 of 3 minted.** All three are refused by the same guard, for the same
reason, and the refusal is correct. Nothing was created in Xero. No money moved.

## The money check passed — the PO grain is what made it pass

Checked by reference and route proofs only. The board's `missing_invoice` signal
was not used.

Each of the three claims hosts two cards: a physical make-safe (already billed)
and the roof report (unbilled, this task). The PO separates them.

| Card | Claim | Its PO | Sibling card | Sibling PO | Sibling invoice |
|---|---|---|---|---|---|
| SWMS-261019 | MLB-27037 | PO-56395 | SWMS-261020 | PO-56397 | INV-1127 AUTHORISED |
| | | | SWMS-261021 | PO-56459 | INV-1116 DRAFT (unlinked, do-not-touch) |
| SWMS-261079 | MLB-27148 | PO-57210 | SWMS-261080 | PO-57211 | INV-1126 AUTHORISED |
| SWMS-261116 | MLB-27387 | PO-57525 | SWMS-261115 | PO-57524 | INV-1128 AUTHORISED |

None of the three has a linked invoice or a release route proof. All three are on
the board in `trade_report_in`, `invoice_status: not_ready`.

`resolve_ses_invoice_duplicates` with the PO-grained reference returns
`allows_create: true` on all three, and SWMS-261019 names the sibling explicitly:

```
reason_codes: ["different_po_sibling_does_not_block"]     # vs INV-1116 MLB-27037PO-56459
```

**Control run, same three cards, claim-only reference (no PO grain):** all three
return `allows_create: false`, `match_tier: "reference"`, `blocked_duplicate_live`
— each blocked by its *sibling's* AUTHORISED invoice. The grain is load-bearing,
not decorative. Both PO sources agree per card (`jobs.metadata.builder_po_number`
and the single live `makesafe_intake_cases.builder_po_canonical`), so the composed
reference is the same whichever code path is deployed.

## Why nothing minted: the guard reads a marker column, not the capture table

One mint was attempted (SWMS-261116, against its already-prepared obligation
`61e73154`). It returned `xero_outcome_unknown`. The keyed retry returned the same.
The effect ledger carries the real cause:

```
operation_key ses:invoice_create:4d348659-…   state unknown   external_id null
failure.message:
  portal-truth guard (item 14): refusing to draft an invoice for report-type job
  b7abfb20-… — no portal-locked verification recorded for cycle 1. Verify the
  portal is submitted and record it via mark_makesafe_portal_report_done before
  invoicing.
```

The guard threw *inside* dispatch, before any Xero call. **No invoice was created**
— independently corroborated by invoice numbering: the 00:33:44 attempt consumed no
number, and the unrelated mint 110 seconds later took INV-1155.

`xero_outcome_unknown` is a misreport here. A guard refusal is a *known* outcome,
but it surfaces through the same `catch` in `executeSesExternalEffect` that a
transport timeout does, so it lands in `unknown` and the operation key is then
permanently non-dispatchable. The truth is only in `ses_external_effects.failure`.

### The gap

`portalVerificationSatisfied` (`makesafe_portal_guard.ts:47`) reads exactly two
columns — `makesafe_job_details.portal_verified_at` and `.portal_verified_cycle`.
It never consults `makesafe_portal_capture_revisions`.

All three cards have a compliant capture and neither marker column:

| Card | capture status | producer | current cycle | `portal_verified_at` | guard passes |
|---|---|---|---|---|---|
| SWMS-261019 | verified / done | `capture_portal_evidence.py/v1` | yes | null | no |
| SWMS-261079 | verified / done | `capture_portal_evidence.py/v1` | yes | null | no |
| SWMS-261116 | verified / done | `capture_portal_evidence.py/v1` | yes | null | no |

Each capture carries a form-locked signal ("form locked/submitted (form-locked
banner)", 21–22 of 24 answered) and a stored screenshot, bound to the card's
current attendance cycle. The producer is the compliant skill script, not the F7
observer. The captures are days old (2026-08-02 / 08-03); the marker was never
recorded in that time, so this is a standing gap, not a race.

Recording it is `mark_makesafe_portal_report_done`, which also advances substatus
to `admin_to_send_report` and closes open assignments as complete. That is an
operational state change and an attestation, so it was **not** done under a
drafts-only brief. Held for the Captain.

Recovery once the marker is recorded: SWMS-261116 needs a **fresh invoice
obligation revision** — its current one (`61e73154`) is welded to the stuck
`unknown` operation key and can never dispatch again. `prepare_ses_invoice_obligation`
supersedes it and mints a new key. The other two were never attempted, so their
keys are clean.

## Two link/detection gaps, for the next sweep

1. **`builder_portal`, not `roof_report`** — as briefed, and worse than a mislabel:
   every link on all three cards uses the key `kind`, and the `type` key does not
   exist on these rows at all. A sweep filtering `external_links[].type == 'roof_report'`
   matches nothing on any of them. Link counts: 1, 5, 5.
2. **The item-14 guard cannot see a compliant capture.** `makesafe_portal_capture_revisions`
   holds a `verified` / `done`, current-cycle, compliant-producer row for all three
   and the guard reads neither. Any sweep that treats "capture attached and verified"
   as "ready to mint" will keep producing this refusal. Whether the guard should
   consult the capture table, or whether the marker must stay a deliberate human
   attestation, is a Captain call — the guard exists to kill the "graf" class
   (roof DRAFTs cut before the portal form was submitted), so widening it is not a
   mechanical fix.

Not fixed here, per brief.

## Separately: SWMS-261079 carries a superseded price

Its docket revision (`fa895f77`, committed 2026-08-03) and its obligation
(`67ba8171`) both price Double Storey roof at **$350 ex / $385 inc**. The Captain's
2026-08-06 ruling sets double at **$300 ex / $330 inc**. That obligation also
predates the PO grain — its reference is the claim-only `MLB-27148`.

Minting it as it stands would put the wrong price and the wrong reference in front
of the Captain. It needs a fresh `prepare_ses_docket_revision` then
`prepare_ses_invoice_obligation` before any mint. The storey itself is not in
question and must not be re-derived from the capture — roof reports are priced off
the work order only.

The other two are correct at $250 ex / $275 inc single storey, and SWMS-261116's
obligation already carries the PO-grained reference `MLB-27387PO-57525`.

## Expected totals when these do mint

| Card | Storey (per work order) | Reference | Total |
|---|---|---|---|
| SWMS-261019 | Single | `MLB-27037PO-56395` | $275 inc ($250 ex) |
| SWMS-261079 | Double | `MLB-27148PO-57210` | $330 inc ($300 ex) — after re-prepare |
| SWMS-261116 | Single | `MLB-27387PO-57525` | $275 inc ($250 ex) |

## Not touched

INV-1149, INV-1150, INV-1155, INV-1116. Koondoola SWMS-261025, Clarkson SWMS-26931,
West Perth SWMS-261018, Queens Park SWMS-26845, Tuart Hill SWMS-261015, Floreat
SWMS-261021. No authorise, send, void, re-price or approve. No guard weakened. No
migration.
