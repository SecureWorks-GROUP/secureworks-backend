# SWMS-261059 — the captain's sign-off, recorded as evidence

Date: 2026-08-02
Ruling: `data/decisions/2026-08-02-swms-261059-and-draft-invoice.md`
Contract: `ses-261059-captain-signoff/v1`

`SWMS-261059` was the single card blocking the corrected stage engine's cutover
gate, on `terminal_without_issued_invoice` and
`terminal_without_supporting_evidence`. The captain opened it, read what is
attached, and signed it off. This document records how that decision was
written down, what each engine then derived from it, and what the card's own
linkage says about the separate manual-completion question.

## 1. What the card actually carries

All read-only, Management API `/database/query` with `read_only: true`.

| Fact | Value |
| --- | --- |
| `jobs.status` | `complete` |
| `jobs.completed_at` | 2026-07-31 06:48:39.196+00 |
| `jobs.metadata.makesafe_job_family` | `general_makesafe` (SES family `physical_makesafe`) |
| `makesafe_job_details.substatus` | `company_contact_required` |
| attendance cycles | 1 (`cycle_number` 1) |
| `job_assignments` | 0 |
| `job_service_reports` | 0 |
| `job_media` completion photos | 0 |
| `makesafe_report_packs` | 0 |
| `job_documents` | 4: `work_order`, `makesafe_report`, `swms`, `invoice` |
| `xero_invoices` with `job_id` = this job | 0 |
| `ses_money_sealed_at` | 2026-07-27 13:39:58+00, source `job_spine_backfill` |

The card also carries a stale display overlay
(`makesafe_board_status_applications` id 10, `new` → `archive`, applied
2026-07-28). It does not bind today, because the card's derived legacy stage is
`report_ready`, not `new`. It is untouched by this work — and it is worth noting
that a captain-era ruling had already said this card should be archived.

## 2. The producer question, answered before anything was written

The brief required the captain's sign-off to be recorded through an existing
evidence contract with the producer recorded, and to stop rather than invent or
borrow a producer term. Two closed vocabularies govern SES evidence:

**`makesafe_portal_capture_revisions.capture_producer`** is closed to the single
machine producer `capture_portal_evidence.py/v1`, pinned by a database CHECK
(`20260728500000_makesafe_portal_capture_bridge_u4.sql`). It has no
human-authority member, and its own header says widening it is a migration plus
a captain ruling, never a code edit. It also cannot express this card at all:
its roles are Prime portal forms and this is a physical make-safe with no portal
role, and its results are `done` / `not_done` / `unreachable`. Using it would
have been borrowing a producer that means something else.

**`makesafe_terminal_proofs`** is the terminal-evidence contract
(`20260728000001_makesafe_state_authority_u2.sql`): append-only, exact job,
exact attendance-cycle SET plus its hash, a `evidence_refs` list the CHECK
requires to be non-empty, and `proven_by` / `proven_at`. Its producer field is
free text, which is precisely how an actor is attributed without widening
anything — so the captain CAN be the recorded producer here, and nothing had to
be invented.

What is closed on that table is `kind`, the evidence TYPE, not the producer.
Three members exist. `release_closeout` means the sanctioned send/release path
produced the closeout, which is not what happened. `approved_nonwork_archive`
means the card was decided to be non-work, which is false — this job was work,
it was done, and it was invoiced. `verified_historical_closeout` means a
closeout that happened outside the release flow has been verified, which is
exactly this card: done manually through the back end, then verified against the
four artifacts on it. Its only existing writer (the U2 reconcile path) reaches
that verdict from durable records rather than from a human reading, but the
verifier is what `proven_by` records, and the table held **zero rows in
production** before this write, so there was no established production meaning to
contradict.

Minting a fourth `kind` was also outside what this task authorised: it would
require altering the table's CHECK constraint, and the only production write
authorised here was the single evidence record for one job.

**So: no term was invented and no producer was borrowed.** The one judgement
call is the `kind`, and it is stated here so a later ruling can overturn it
without archaeology.

## 3. The write

`scripts/apply-ses-261059-captain-signoff-v1.ts` — closed one-job fixture, no
discovery step, live re-derivation of every fact at both dry-run and apply time,
fail-closed refusals, committed ledger, and a `--mode verify` re-read.

Written row:

```
id                        e235171c-533f-4113-b68e-8aad2b7db034
job_id                    b88809b7-ee6e-497f-a586-25aea586047c
kind                      verified_historical_closeout
proven_by                 captain-signoff:2026-08-02-swms-261059-and-draft-invoice
proven_at                 2026-07-31 06:48:39.196+00
attendance_cycle_set_hash sha256:84c308706bc740b06366f4da38475a9559d0b5ad8ca1d57bda4ff2f434c27dfb
evidence_refs             job_documents x4 (work_order, makesafe_report, swms, invoice)
                          xero_invoices:bc532ac9-71d8-4518-96ac-016c337b1a51  (INV-1084)
                          decision:data/decisions/2026-08-02-swms-261059-and-draft-invoice.md
```

`proven_at` is the closeout time, not the sign-off time: the U2 reconcile writer
likewise stamps a proof with when the work actually closed, and the display
clock ages the card from it. It names the ruling rather than a person so the
record stays attributable when people change.

After the write, `makesafe_terminal_proofs` holds exactly one row in the whole
table. `jobs.status`, `jobs.completed_at`, `ses_money_sealed_at`,
`makesafe_job_details.substatus`, the linked-invoice count (still 0) and the
board status ledger are all unchanged — proved by
`scripts/apply-ses-261059-captain-signoff-v1.verify.json`. A re-run refuses with
`terminal_proof_already_recorded`
(`...post-apply-dry-run.json`) rather than writing a second row.

## 4. What each engine derives from that evidence

Read straight off the parity harness, which runs both engines over one set of
production reads.

| Engine | Before the proof | After the proof |
| --- | --- | --- |
| **Legacy ladder** (`_deriveMakesafeBoardStage`) — places every card today | `report_ready` | `report_ready` — **unchanged** |
| **Legacy + overlay** (`canonical_stage`, the rendered column) | `report_ready` | `report_ready` — **unchanged** |
| **M1** (`computeMakesafeStatus`) | `completed` | `completed` — unchanged, byte-identical |
| **Corrected shadow engine** (`ses_stage_engine_v2.ts`) | `decision_required` | **`completed`**, no conflicts |

**The legacy engine does not honour the sign-off, and it was not forced to.**
It reads substatus, raw job status, assignments, a report row, an invoice, the
document flags and the pack — it has no reader for the terminal-proof ledger,
and giving it one would be building a new path into the engine the corrected
engine exists to replace. So the card still renders in Report Ready on today's
board. That is the honest answer, and the captain can now choose: either wait
for the Release 12 authority flip (after which the corrected derivation places
it in Completed / Archive on its own), or apply an ordinary display-overlay
transition through the existing `makesafe_board_status_applications` ledger.
Nothing here reached past the derivation to place the card.

The corrected engine's reasons, in full:

- `a verified_historical_closeout terminal proof covers this card's exact attendance-cycle set`
- `completion time from terminal_proof.proven_at is under 7 days old`

It will roll to `archive` on its own once `proven_at` is seven days old, on the
same common clock every other terminal path uses. The captain named Completed or
Archive as equally acceptable.

## 5. The gate, re-run across all 407 active cards

Population `ses-board-population/active-v1` (a DEFAULT, not a ruling — captain
decision C.5 is open, so this is not "the whole board").

| | before | after |
| --- | --- | --- |
| `cutover_gate.ok` | `false` | **`true`** |
| `checked` | 407 | 407 |
| `blocked` | 1 — `SWMS-261059` | **0** |

`SWMS-261059` no longer blocks it, and **nothing surfaced behind it**. That was
not assumed: the before run was taken with the engine change already in place
and the write not yet made, so the two runs differ only by the evidence row.

**No other card moved.** A full-field diff of the 407 before/after harness cards
shows exactly one card with any field change, and only in the corrected engine's
advisory fields plus the new input-fact key:

- `stage_v2`: `decision_required` → `completed`
- `stage_v2_post_overlay`: `decision_required` → `completed`
- `stage_v2_conflicts`: both conflicts → `[]`
- `facts.terminal_proof_kinds`: absent → `["verified_historical_closeout"]`

Every legacy, M1, post-cutover and overlay value on every card, including this
one, is identical. The column counts for all five engine views are unchanged.
The frozen E1 baseline verifies `ok`, with all 71 certified disputed cards
reproducing and an identical `disputed_manifest_id`.

Artifact: `scripts/ses-261059-captain-signoff-v1.parity-bracket.json`.

This is also structurally guaranteed, not just measured: the proofs table held
zero rows before and holds exactly one after, and every new code path is gated
on a bound proof.

## 6. Linkage observations for `ses-manual-backend-completion-visibility-v1`

Not fixed here. Recorded because the open question is how many cards are in this
shape and nobody has measured it.

The contradiction resolves cleanly once you see which invoice each side is
looking at. **The captain is reading a PDF; the engine is reading a mirror row.**

- `INV-1084` exists in `xero_invoices`, is **`AUTHORISED`**, is **`ACCREC`**, is
  dated 2026-07-31, and carries the **PO-referenced identity**
  `MLB-25857PO-53193` — builder scope `MLB` plus purchase order `PO-53193`,
  which is the instruction key this repo already keys cards on. Its `job_id` is
  **NULL**.
- The card carries `job_documents` type `invoice` — the rendered PDF of that same
  invoice, attached 2026-07-31 06:48:05.
- `ses_money_sealed_at` is set (source `job_spine_backfill`, as it is on all 440
  SES cards), and `linked` is one of the sealed verbs. So setting
  `xero_invoices.job_id` on this card is a sealed write that every sanctioned
  writer refuses. **The card is unlinkable by design, not by accident.**
- Both stage engines read `evidence.invoiceStatus` from the LINKED mirror row,
  so both see no invoice at all. The evidence ruler does not have this problem —
  `makesafe_invoice_reference_match.ts` was built for exactly this, matching a
  card to its card-unique unlinked issued ACCREC on the READ side — but the
  stage engines are not among its declared consumers (C1 entrypoint, C2 batch,
  cohort deriver, C4 board UI). **That is the whole gap, in one sentence.**

The rest of the card's shape is the signature to search for:

- Every artifact arrived within 12 minutes on 2026-07-31 (`work_order` 06:36,
  `makesafe_report` 06:47:53, `swms` 06:48:03, `invoice` 06:48:05), and
  `jobs.status` went to `complete` at 06:48:39 — 34 seconds after the last
  document. That is a human working a card by hand end to end.
- The captain is right that the attached "trade report" is not a raw trade
  report: there are **zero** `job_service_reports` rows and **zero** completion
  photos. The `makesafe_report` document is a finished report PDF, not the
  trade's submission.
- `makesafe_job_details.substatus` is still `company_contact_required` — the
  first substatus in the ladder. The card was completed without ever advancing
  through it.
- There are zero `job_assignments` and zero `makesafe_report_packs`.

A cheap first measurement of the population, therefore, is: SES board cards with
a terminal `jobs.status`, zero `job_service_reports`, zero linked
`xero_invoices`, a `job_documents` row of type `invoice`, and an unlinked issued
ACCREC whose reference matches the card. That is a read-only query and it needs
no ruling to run.

### Two boundaries this release deliberately does not cross

**The reference matcher is NOT wired into either stage engine here.** Naming the
gap is not the same as closing it: adding `makesafe_invoice_reference_match.ts`
to a stage engine's inputs would change what `evidence.invoiceStatus` means for
every card that has an unlinked issued ACCREC, which is a fate-moving change
needing its own bracketed measurement and its own ruling. The captain is filing
it as its own release. Nothing in this branch touches the matcher or its
declared consumer list.

**No display overlay was applied for this card.** The corrected engine now
derives `completed` from the recorded proof, but `canonical_stage` is still the
legacy ladder plus the existing overlay resolver, so the card renders in Report
Ready today. Whether the signed-off card moves NOW — via an ordinary
`makesafe_board_status_applications` transition — or waits for the Release 12
authority flip is the captain's call, and it has not been pre-empted. The stale
`new` → `archive` overlay already on the card (id 10, 2026-07-28) is untouched
and still does not bind.

## 7. Open follow-up

`ses_stage_engine_v2.ts`'s advisory value is still advisory. This work did not
change the authority boundary: `canonical_stage` remains the legacy ladder plus
the existing overlay resolver, `projectOpsMakesafeBoard` still buckets on it
alone, and there is still no flag that promotes the corrected engine. The
authority flip is Release 12 and still has to be written.
