# A re-attend card's own current-cycle AUTHORISED invoice was blanked (ladder v7)

**Date:** 2026-08-06
**Cards:** SWMS-26953 (Gidgegannup), SWMS-26902 (Ballajura), SWMS-261128
(Woodvale), SWMS-261131 (High Wycombe)
**Control:** SWMS-26651 (Nollamara)
**Ladder:** `makesafe-stage-ladder.v6-reattend-current-draft-visible` →
`makesafe-stage-ladder.v7-reattend-current-raised-visible`
**Payload contract:** unchanged (`MAKESAFE_BOARD_CONTRACT_VERSION` not bumped —
no key added, no key retyped)
**Migration:** none.

---

## 1. The report, and why the stated cause was not the cause

Four cards had shipped and been invoiced and could not reach Completed. The
reported mechanism was that `jobs.status` is gated on `report_status='processed'`
plus a report document plus `health='closed'`.

That reading is inverted. `report_status` and `health` are **outputs**, not
inputs:

- `makesafeReportStatus(boardStage, …)` returns `'processed'` *because* the card
  derived `completed`/`archive` (`index.ts`).
- `makesafeAge(…)` sets `health = boardStage === 'completed' ? 'closed' : …`.

Neither is writable and neither gates anything. Chasing them would have found
nothing wrong, and "fixing" either would have written a value the board
recomputes on the next read. The real gate is the stage ladder
(`_deriveMakesafeBoardStage`), and what it was missing was the invoice.

## 2. What each card was actually missing

Nothing. Every one of the four had, at the time of measurement:

| Card | Suburb | Builder | Cycle | Invoice | Status | Created | Route proofs |
|---|---|---|---|---|---|---|---|
| SWMS-26953 | Gidgegannup | mlb | 2 | INV-1135 | AUTHORISED | 2026-08-05 10:12 | report, photo, invoice |
| SWMS-26902 | Ballajura | mlb | 3 | INV-1136 | AUTHORISED | 2026-08-05 10:16 | report, photo, invoice |
| SWMS-261128 | Woodvale | mlb | 2 | INV-1137 | AUTHORISED | 2026-08-05 10:17 | report, photo, invoice |
| SWMS-261131 | High Wycombe | aj | 2 | INV-1111 | AUTHORISED | 2026-08-05 00:35 | report_invoice, photo |

All four also carry a `work_order` document and a current-cycle
`makesafe_report` document. Send truth was read via `ses_release_route_proofs`
(which carries `job_id`), never via `ses_external_effects.job_id`, which is NULL
on every `route_send` row, and never via `report_sent_at`, which is unreliable in
both directions.

Every invoice was created **after** its card's `last_reattend_at`, so by the
system's own predicate it is the current attendance's money.

## 3. The mechanism

All four are re-attend cards. `enrichMakesafeBoardJob` suppresses closeout
evidence on re-attend so an earlier visit cannot close the current one:

```ts
const invoiceForStage =
  (scoped.allowCloseoutFromEvidence || invoiceQualifiesForCurrentAttendance)
    ? invoice : null
```

`allowCloseoutFromEvidence` is a blunt `!hasReattendBoundary(detail)` — false for
any re-attend, saying nothing about *this* invoice. So the only way an invoice
reached the ladder on a re-attend card was
`invoiceQualifiesForCurrentAttendance`, i.e.
`qualifyMakesafeCurrentDraftInvoice`, which requires `status === 'DRAFT'`.

That function answers **two questions at once**:

1. *Is this invoice this card's own, for this attendance?*
   (`invoiceBelongsToCurrentAttendance` — created at/after `last_reattend_at`,
   missing stamp fails closed.)
2. *What stage of its life is it at?* (`status === 'DRAFT'`.)

Because they were fused, "not a DRAFT" and "not this cycle" produced the same
outcome. An AUTHORISED current-cycle invoice reported `wrong_status`, was
blanked, and the ladder was handed **no invoice at all**:

- `invoiceDone` false → no closeout branch reachable;
- `surf.invoiceAuthorisedLive` false → the Docs Ready positive unreachable;
- fall through to `hasActualReportEvidence` → **`trade_report_in`**.

A card with committed, payable money and proven builder sends was placed by the
board as though it had never been billed.

## 4. Why the sanctioned close-out path could not have fixed it

`harness/ops/skills/secureworks-makesafe-reporting/references/close-out-contract.md`
step 5 attaches the invoice PDF, report and SWMS with correct document types;
step 7 moves the card to `completed` once that evidence is verified.

Measured counterfactual — real production rows, all close-out documents present,
invoice still blanked:

| Card | contract docs attached, v6 binding | result |
|---|---|---|
| SWMS-26953 | invoice + swms + makesafe_report | `trade_report_in` |
| SWMS-26902 | invoice + swms + makesafe_report | `trade_report_in` |
| SWMS-261128 | invoice + swms + makesafe_report | `trade_report_in` |
| SWMS-261131 | invoice + swms + makesafe_report | `trade_report_in` |

The contract's document step lands on a gate the card never reaches. The
contract is not *wrong*; it **predates attendance cycles** (U2-S1) and has no
notion of them, and its step 7 ("update stage/status to `completed`") describes
an era when the board stage was an operator-written field rather than derived.
Today there is nothing to write.

The one thing that *would* have worked — setting `jobs.status = 'invoiced'` or
substatus `complete`, which are operator-declaration terms of `invoiceDone` and
bypass `invoiceForStage` entirely — is exactly the hand-forced green the Captain
ruled out. It moves the lie one layer down.

## 5. The fix, and why it is not a weakening

`makesafeInvoiceIsCurrentAttendanceReceivable` (`makesafe_docs_ready_invoice.ts`)
separates question 1 from question 2. It runs every gate the DRAFT qualifier runs
— exact `job_id`, ACCREC, the identical cycle boundary, non-empty and card-owned
reference — and **omits only the lifecycle-status test**. `invoiceForStage` then
also admits an invoice that is `_makesafeInvoiceIsRaised` and passes that
identity check.

The argument that this is a correction rather than a relaxation:

- **The cycle boundary is byte-for-byte unchanged.** Every prior-cycle shape is
  refused by the same predicate that refuses it today. The control, SWMS-26651,
  holds a PAID invoice created 2026-06-19 against a boundary of 2026-07-17; it
  stays suppressed, and its derived stage is identical before and after.
- **It widens toward the stronger fact, not the weaker one.** v6 already admitted
  a DRAFT — money still being drafted, unpayable, editable in Xero. v7 admits
  AUTHORISED/SUBMITTED/PAID — money committed and payable. It would be incoherent
  to trust the weaker artifact and blank the stronger one.
- **The `wrong_status` reason was never a ruling.** No Captain decision says a
  re-attend card's own current-cycle raised invoice must be invisible. It is a
  side effect of the DRAFT-shaped test v6 reached cycle attribution through.
- **It does not close a card by itself.** The close-out doc gate, `verifiedSent`
  and the 7-day completion clock all still apply. `makesafe_reattend_current_draft_stage_test.ts`
  pins a live re-attend card with current-cycle AUTHORISED money, an unsent pack
  and no close-out docs at `report_ready` — not `completed`.
- **Everything else still fails closed.** Wrong job, ACCPAY, VOIDED, DELETED,
  foreign reference, missing reference, and an unparseable `last_reattend_at` are
  each refused, and each is pinned.

### A recorded control was changed, deliberately

`prior-cycle money never reaches the Captain's approve list` contained the row
`["authorised this cycle", invoice("AUTHORISED", AFTER_BOUNDARY)]` — a fixture
created **after** the boundary, i.e. current-cycle money, sitting in a test whose
stated invariant is about **prior-cycle** money. Its own label admits the
mismatch. That row was there because under v6 the two were indistinguishable.

It has been moved into its own test with the reasoning above recorded in the
test body. **Both prior-cycle rows in that control are untouched and still
pass**, and the control was *widened* with prior-cycle PAID, DELETED, wrong-job,
foreign-reference and ACCPAY cases. The invariant the control names survives
intact; only the mislabelled row moved.

If the Captain reads this differently, the revert is a one-line removal of
`invoiceRaisedForCurrentAttendance` from the `invoiceForStage` condition — the
four cards return to Trade Report In and nothing else changes.

## 6. A second contradiction the fix surfaced

Letting these cards reach the close-out doc gate exposed pre-existing drift.
Ladder v5 dropped `substatus === 'complete'` from `verifiedSent` (SES U6R
closeout writes the pack-sent marker but never flips that substatus). The
`enrichMakesafeBoardJob` copy still required it, so on a pack-sent card the
ladder completed while the same row published `docs_missing: true` — a hard doc
hold advertised on a card nothing was holding.

Both copies now read `(packSent === true && invoiceAuthorised) || gateSoftenSent`,
and both `invoiceDone` and `verifiedSent` are pinned at source in
`makesafe_draft_invoice_stage_test.ts`. Effect on the four:

| Card | v7 stage | docs_missing | docs_warning | outstanding |
|---|---|---|---|---|
| SWMS-26953 | completed | false | **true** | invoice PDF, SWMS |
| SWMS-26902 | completed | false | **true** | invoice PDF, SWMS |
| SWMS-261128 | completed | false | **true** | invoice PDF, SWMS |
| SWMS-261131 | report_ready | **true** | false | invoice PDF |

The three MLB cards complete under the verified-sent regime with an honest soft
warning naming what is still unattached; High Wycombe is not pack-sent, so it
holds in Docs Ready with a hard `["invoice"]`. Both are the close-out contract's
step 5 becoming actionable for the first time — the documents now have a gate to
satisfy.

## 7. Re-proving this

`scripts/ses-reattend-raised-invoice-closeout-verify.ts`, read-only, two modes.

- `--mode=served` reports the live defect population: re-attend cards owning a
  raised current-cycle invoice that the board presents as having none. **After
  deploy it must be empty**; it exits 1 while it is not. Measured 2026-08-06,
  pre-deploy: 456 board cards, 8 re-attend, 4 owning a raised current-cycle
  invoice, **4 blanked** — the whole class, and exactly the four reported.
- `--mode=derive` pulls the real rows and runs the real
  `enrichMakesafeBoardJob` from the working tree, twice per card, and
  **validates its v6 answer against the live board's `declared_stage`** before
  reporting the v7 one. Compare against `declared_stage`, never
  `canonical_stage`: the latter carries the Captain's display-ledger overlay, and
  SWMS-26651 is the worked example (declared `allocated`, overlaid to `archive`).

Result, 2026-08-06, input-fidelity mismatches 0:

| Card | live board | v6 (invoice blanked) | v7 (this tree) | presents |
|---|---|---|---|---|
| SWMS-26953 | trade_report_in | trade_report_in | **completed** | AUTHORISED |
| SWMS-26902 | trade_report_in | trade_report_in | **completed** | AUTHORISED |
| SWMS-261128 | trade_report_in | trade_report_in | **completed** | AUTHORISED |
| SWMS-261131 | trade_report_in | trade_report_in | **report_ready** | AUTHORISED |
| SWMS-26651 (control) | allocated | allocated | allocated | NULL |

## 8. Scope, and what this does not touch

Trade Report In held 13 cards. Four are this class. The other nine each have
**no invoice at all** (`missing_invoice`), so they are awaiting an invoice mint —
correct ladder behaviour, a different problem, and explicitly out of bounds here
(no mint). The Captain's standing order that all of Trade Report In reach
Completed or Report Ready needs that mint step for the remaining nine.

**Superseded 2026-08-07 on the inference only:** `missing_invoice` is NOT
evidence that a card needs a draft — it reads `xero_binding` alone, and every
measured card carrying it already held live money in Xero under its own
reference. Check by reference before minting any of those nine; the guard, the
measurement and the retraction are in
`docs/evidence/ses-manufactured-blockers-2026-08-07.md`. The stage findings
above are unaffected.

Nothing here sends, mints, voids, approves, authorises or re-prices. No
migration. No board write, no document attach, no status write of any kind: the
entire change is board derivation, and every production interaction was a SELECT
or a board GET.
