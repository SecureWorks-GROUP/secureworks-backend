# System-manufactured blockers on the SES board — 2026-08-07

Read-only measurement plus two code cures and one applied data correction.
Everything here is re-provable; each claim names the surface that proved it.

## Method rules that governed every measurement

- **Never** join `ses_external_effects` on `job_id`. It is NULL on every
  `route_send` row, so the join returns zero and reads as "nothing was ever
  sent" — which is how a shipped card looks unshipped. Join through
  `makesafe_release_revision_members`; cross-check `ses_release_route_proofs`,
  which does carry `job_id`.
- **Never** read `report_sent_at` as send truth in either direction (below).
- Prove money by **reference search**, never by the board's flag and never by a
  `job_id` join.

---

## 1. `report_sent_at` is wrong in both directions (CONFIRMED, board-wide)

`report_sent_at` was never send truth. Until Rescue SES T2 (`e71a324a`) removed
it, `updateMakesafeSubstatus` stamped it on the move to `ready_to_invoice` — an
operator CLAIM, not a send — while a card genuinely sent through the sealed
release graph gets no stamp at all.

Measured across the 419-card active board, 2026-08-06:

| | count |
|---|---|
| cards carrying a `report_sent_at` stamp | 33 |
| cards carrying a real route proof | 15 |
| **overlap between those two sets** | **0** |

Zero. The field is anti-correlated with send truth on the live population.

Of the 33 stamps, **28 are corroborated** by the legacy `MAKESAFE_PACK_SENT`
job_events marker (real pre-pack-table sends — those stamps are kept). The
remaining **5** are the auto-stamp's own output:

| card | stamp | its own `ready_to_invoice` event | send evidence |
|---|---|---|---|
| SWMS-26851 | 00:12:51.200 | 00:12:51.279 (+79ms) | none on 4 surfaces |
| SWMS-26852 | 00:12:52.782 | 00:12:52.901 (+119ms) | none |
| SWMS-26853 | 00:12:53.360 | 00:12:53.414 (+54ms) | none |
| SWMS-26855 | 00:46:35.841 | 00:46:36.195 (+354ms) | none |
| SWMS-26857 | 00:46:37.118 | 00:46:37.216 (+98ms) | none |

Each stamp precedes its own substatus event by 50–350ms: the same transaction.
This is the identical defect the Captain named on Floreat SWMS-261021, which a
prior agent cured at 2026-08-06 10:02 (`makesafe_evidence_correction` event).

### Consumers that read it as send truth

`_deriveMakesafeSurfacing.sentClosed` (`index.ts`) includes `!!report_sent_at`,
and `sentClosed` gates both `readyForReview` and `authorisedAwaitingSend`; a
false stamp therefore suppresses a card's Docs Ready terms. `ses_stage_engine_v2`
lists it as a terminal evidence source, `makesafe_draft_pack` skips any card
carrying it, and `isOpenTradeMakesafeDetail` drops it from the trade pool.
`_makesafeSentToBuilder` (the SENT chip) already excludes it, correctly.

### Cure applied

`scripts/apply-ses-false-send-stamp-v1.ts` — closed 5-card fixture, no
discovery step, live re-derivation of all four send surfaces at dry-run **and**
again immediately before each write, writing through the existing typed
`update_makesafe_details` action. Applied and verified 2026-08-07: 5 cleared, 0
refused, substatus unchanged on every card, ledger at
`scripts/ses-false-send-stamp-v1.ledger.json`. Board-wide readback afterwards:
28 stamped, **0 uncorroborated**.

None of the five moved into the Captain's queue: they sat in `allocated` (4) and
`archive` (1) before the cure and carry no docket, so they were never candidates.

The durable mechanism is the new ops-api action
`correct_makesafe_false_send_stamp` (`makesafe_false_send_stamp.ts`), which
enforces the same guard server-side, only ever CLEARS a stamp, and refuses any
card it cannot prove was never sent. **Tier 2 first-live-proof:** first
privileged call after `ops-api` deploys from `main` should return
`refused / no_stamp_to_clear` for all five (idempotence), and
`refused / send_evidence_present` for any card carrying a legacy marker.

---

## 2. The board says `missing_invoice`; Xero says PAID (MOST IMPORTANT FINDING)

The review cockpit decided whether a card had an invoice from `xero_binding`
alone. A hand-made Xero invoice never linked to the job, or linked but never
bound to the current docket, is invisible to that read — so the cockpit reported
no invoice and the APPROVE INVOICE control said *"Mint the draft first."*

Reference search over the 19 Docs Ready cards, 2026-08-06. **All 16 cards with
no bound invoice already had live money under their own reference:**

| status of existing money | cards |
|---|---|
| **PAID** | **7** |
| AUTHORISED | 6 |
| unlinked DRAFT | 3 |

And the proposal the cockpit offered differs from what was actually billed:

| card | cockpit proposal | reality |
|---|---|---|
| **SWMS-26841** | **$561.00** | **INV-0850 already PAID $882.20** |
| SWMS-26891 | $352.00 | INV-0918 PAID $621.50 |
| SWMS-26894 | $352.00 | INV-0916 PAID $528.00 |
| SWMS-26875 | $561.00 | INV-0846 PAID $880.00 |
| SWMS-261015 | $404.25 | INV-1115 DRAFT $464.75, unlinked, exact reference |

That is not a stale flag. It is an invitation to double-bill a customer who has
already paid us, shown to the Captain as the next action.

**Root cause**, the same two-files-disagree shape as the placement defect one
layer up: `ses_review_cockpit.ts` does not consume
`makesafe_invoice_reference_match.ts`, which `makesafe_evidence_requirements.ts`
already uses.

### Cure applied

`ses_existing_card_money.ts` reads the Xero mirror **by reference** and the
cockpit refuses on it (`invoice_exists_unbound`), replacing the mint invitation
with the invoice that already exists. It consumes the matcher's reference
GRAMMAR rather than its unique-match entrypoint, per that module's own rule —
*a matcher for attribution must be unique; a matcher for refusal must be
inclusive* — so a contested claim refuses, and DRAFT counts.

**One-way by construction:** the blocker list only grows and `clean` is only
forced false, so nothing here can make a card more approvable. A card whose
docket binds its invoice is never touched; an unreadable mirror refuses.

Live proof, real classifier over real production rows: **16 refuse, 3
unaffected** (the three carrying a bound DRAFT). **Tier 2 first-live-proof:**
after deploy, `query_ses_review_cockpit` on SWMS-26841 must carry blocker
`invoice_exists_unbound` naming INV-0850 PAID $882.20, and SWMS-261114 must be
unchanged.

### For the Captain, above both of us

**Seven cards have been PAID for work the board still presents as needing an
invoice.** That is an accounting question, not an engineering one:
SWMS-26841, SWMS-26867, SWMS-26875, SWMS-26884, SWMS-26887, SWMS-26891,
SWMS-26894.

---

## 3. Reference normalisation: nothing left to normalise

`scripts/ses-po-suffix-duplicate-census.ts` (read-only, re-runnable), run live
after the PO-insensitive guard shipped:

| | count |
|---|---|
| cards measured | 420 |
| references differing from a live invoice only by a PO suffix | 31 |
| newly refused by the PO-insensitive fix | 2 |
| permitted because the sibling is another card's money | 11 |

Both newly-refused cards (SWMS-26931 Clarkson, SWMS-261018 West Perth) are on
the do-not-touch list. Every remaining park is either the card's **own** real
money or an invoice whose attribution is genuinely missing evidence — which the
sealed money fence forbids repairing at write time (Captain 2026-08-01).

**Nothing here is our data disease. No change made, and that is the finding.**

---

## 4. The honest Docs Ready count

The Captain's four criteria are: complete pack, qualifying draft, capture per
family rules, and no open money question. Counted from
`list_ses_docs_ready_reviews` (19 dockets), not from the board column
(`report_ready` shows 2 — Docs Ready is a queue, not a column):

| meets all four | cards |
|---|---|
| **SWMS-261114** (roof, INV-1149 DRAFT $330, portal capture ready, sole invoice on `RR-26836`) | ✅ all four |
| **SWMS-261081** (roof, INV-1150 DRAFT $330, portal capture ready) | ✅ all four, with one caveat below |
| SWMS-261025 Koondoola | clean per cockpit, but **do-not-touch live finding** — two unlinked AUTHORISED invoices totalling $4,290 sit on its claim |
| the other 16 | ❌ — already billed (§2) |

**The honest number that meets all four is 1–2, not 15 and not 25.**

Caveat on SWMS-261081: its INV-1150 carries the bare claim `MLB-27100` while
sibling card SWMS-261057 carries `MLB-27100PO-56960`. The guard permits it, but
the bare-claim reference is the F07 grain issue and worth a look before send.

Caveat on SWMS-261114: `c49e547a` records the Captain's ruling that this card
stays at $300 while the bound draft is $330. Not touched — repricing is out of
bounds here.

### What the gap is NOT

An earlier reading of this run concluded the 16 needed their invoices minted.
**That was wrong and is retracted.** It was derived from the cockpit's absent
`bound_invoice`, which is exactly the unsafe inference §2 exists to prevent.
Acting on it would have double-billed 16 cards, seven of them already paid.

---

## 5. For the board-placement owner (not touched here)

- `report_ready` holds 2 cards while the review queue holds 19. Cards whose job
  finished more than seven days ago derive `canonical_stage: archive`, so ready
  packs are invisible in the live columns.
- `route_draft_missing` is reported on the invoice route whenever the invoice is
  not AUTHORISED, and its recovery text says *"Prepare a new docket revision."*
  That instruction is unsatisfiable for this cause — the route can only become
  ready once money is authorised — and it is the same trap already documented
  for SWMS-261114, which took three prepares in one morning. The refusal should
  name the money, not invite a prepare.
- Two pre-existing type errors in `cp1_drag_reschedule_test.ts` (from PR #367)
  fail `deno task test:ops-api` at the type-check step. Unrelated to this work,
  confirmed present at base commit `cb1deee4`.
