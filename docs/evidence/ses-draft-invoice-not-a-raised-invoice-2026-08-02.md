# A DRAFT invoice is not a raised invoice — visible stage ladder, 2026-08-02

Owner of this change: `_makesafeInvoiceIsRaised` +
`MAKESAFE_STAGE_LADDER_VERSION` in `supabase/functions/ops-api/index.ts`.
Regression suite: `supabase/functions/ops-api/makesafe_draft_invoice_stage_test.ts`.
Measurement artifacts: `data/ses-draft-invoice-not-done-v1/`.

The captain's rulings this is graded against are NOT in this repository. They live
in firstmate's home and must be read by absolute path:
`/Users/marninstobbe/kun-agent-workspace/data/decisions/` (16 files, including
`2026-08-02-captain-card-by-card-review.md`) and
`/Users/marninstobbe/kun-agent-workspace/data/ses-docsready-screenshot-audit-v1/report.md`.
`data/decisions/` in this repo holds one file and is not the set.

## The defect

`invoiceDone` in `_deriveMakesafeBoardStage` — the ladder that produces
`declared_stage`, and therefore the column every card is rendered in — read its
invoice term through `hasActiveMakesafeInvoice`, which counts ANY ACCREC row
that is not `VOIDED`/`DELETED`. A Xero `DRAFT` passed.

A DRAFT invoice is not an invoice. Its OnlineInvoice link cannot take a card
payment and a bank transfer against it lands unreconciled — the same fact
CLAUDE.md already pins as the "Acceptance Deposit Invoice Invariant" and
`_acceptanceInvoiceChargeable` already enforces on the sending side. The board's
stage ladder was the one place that did not know it.

Two visible consequences:

1. **The Docs Ready column filled with cards nobody can send.** `invoiceDone`
   short-circuited the card past every evidence branch straight into the
   close-out doc gate, which then held it in `report_ready` for a missing invoice
   PDF. Measured on production: 15 of the 24 cards in Docs Ready arrived that
   way, with no pack, no report and nothing payable.
2. **A latent archive trap.** On a report-only (roof / assessment) card the gate
   wants ONLY the invoice PDF, so attaching that one DRAFT PDF satisfied it and
   sent the card to `completed`/`archive`. Work disappearing on the strength of
   an unsendable invoice.

## The change

```
invoiceDone = _makesafeInvoiceIsRaised(invoice) || jobStatus === 'invoiced' || normalizedSub === 'complete'
```

`_makesafeInvoiceIsRaised` = a live ACCREC row whose status is `AUTHORISED`,
`SUBMITTED` or `PAID`. It is the set the code already used in three restated
copies (`invoiceAuthorised`, `invoiceAuthorisedLive`,
`_MAKESAFE_CANCEL_LIVE_INVOICE_STATUSES`); those first two now derive from it
instead of restating it, which is behaviour-neutral and was proved so by the
before/after run.

**What was deliberately NOT changed, and why:**

- **`jobs.status = 'invoiced'` and substatus `complete` stay in `invoiceDone`.**
  They are OPERATOR declarations, not claims about Xero invoice status, and
  neither is reachable by merely creating a draft. Measured: of the 19 board
  cards carrying a DRAFT invoice, ZERO carry `jobs.status='invoiced'`, so keeping
  them does not weaken the fix by a single card. `SWMS-26832` carries substatus
  `complete` with no invoice row at all (the documented bundled-coverage card)
  and is untouched.
- **`invoiceIsDraft` and `readyForReview` are untouched.** The captain's
  2026-08-02 ruling makes a DRAFT invoice a PRE-condition of Docs Ready — "there
  should be a draft invoice that exists so I can see exactly what the invoice is
  gonna be like when I approve it". A drafted-not-sent pack with a DRAFT invoice
  still surfaces in Docs Ready, which is the column's entire purpose. Only the
  reading of a DRAFT as *closure* is removed.
- **`makesafeInvoiceStatus` is untouched.** It already reports a DRAFT invoice as
  `draft`, honestly.
- **The money seal is not involved.** This change reads `xero_invoices.status`
  and writes nothing. No invoice is created, authorised, changed, linked or sent,
  and `ses_money_sealed_at` is neither read nor bypassed.

`enrichMakesafeBoardJob` keeps its own copy of `invoiceDone` for the board's
`docs_missing` / `missing_docs` chip. It was changed in lockstep and a test pins
the two together at source, because a drifted copy would advertise a hard doc
hold on a card the ladder is no longer holding for docs.

## Engine version

The corrected shadow engine has carried `SES_STAGE_ENGINE_V2_VERSION` since it
was born. The ladder that actually places every card had **no version at all**,
so no past measurement could name the derivation that produced it. This change
gives it one:

`MAKESAFE_STAGE_LADDER_VERSION = 'makesafe-stage-ladder.v2-raised-invoice'`

- v1 is the implicit, unversioned original in which a DRAFT closed a card.
- Enrich stamps it on the base row; the read model publishes it as
  `declared_stage_engine_version`, the sibling of
  `derived_stage_v2_engine_version`. Additive, advisory, ops-payload only —
  the trade row is an explicit allow-list and cannot acquire it. A caller that
  builds a base row without enrich gets `null`, never a default that would
  attribute a v1 reading to v2.
- The literal is pinned in exactly one suite
  (`makesafe_draft_invoice_stage_test.ts`), per the CLAUDE.md one-place rule.
- `MAKESAFE_BOARD_CONTRACT_VERSION` is deliberately NOT bumped: it versions the
  payload SHAPE for consumers, and the shape only gained an additive key.

## Measurement

Read-only, Management API `/database/query` with `read_only: true`, SELECT only,
via `scripts/ses-stage-parity-harness.ts`. 407 active cards
(`ses-board-population-contract` `active-v1`; Captain decision C.5 on the 33
cancelled is still open, so this is not the whole 440-card board). 15 queries per
run, both runs pinned to `--now=2026-08-02T12:00:00.000Z` so the 7-day
completed/archive clock cannot move between them.

Artifacts: `data/ses-draft-invoice-not-done-v1/parity-before.json`,
`parity-after.json`, `e1-baseline-verify-after.json`.

### Per-column deltas — `canonical_stage`, the column a card is rendered in

| Column | Before | After | Delta |
|---|---|---|---|
| New | 35 | 35 | 0 |
| Allocated | 31 | 36 | **+5** |
| Trade Report In | 12 | 12 | 0 |
| Docs Ready (`report_ready`) | 24 | 20 | **-4** |
| Completed | 2 | 2 | 0 |
| Archive | 303 | 302 | **-1** |
| Cancelled | 0 | 0 | 0 |

### Per-column deltas — `declared_stage`, pre-overlay

| Column | Before | After | Delta |
|---|---|---|---|
| New | 63 | 63 | 0 |
| Allocated | 36 | 41 | **+5** |
| Trade Report In | 12 | 12 | 0 |
| Docs Ready (`report_ready`) | 30 | 25 | **-5** |
| Completed | 2 | 2 | 0 |
| Archive | 264 | 264 | **0** |
| Cancelled | 0 | 0 | 0 |

### Every card that moves

| Card | Family | Before | After | Cause |
|---|---|---|---|---|
| SWMS-26709 | ordinary roof portal | Docs Ready | Allocated | DRAFT invoice no longer reaches the close-out doc gate; card is allocated to a trade with no report in |
| SWMS-26754 | ordinary roof portal | Docs Ready | Allocated | same |
| SWMS-26803 | ordinary roof portal | Docs Ready | Allocated | same |
| SWMS-26848 | ordinary roof portal | Docs Ready | Allocated | same |
| SWMS-26782 | physical make-safe | **Archive** | Allocated | same derivation change; its `report_ready -> archive` display overlay stops binding because the overlay resolver requires `source_status == declared_stage`. A captain-ruled card — see the two dedicated sections below |

SWMS-26754 and SWMS-26782 are both captain-ruled. SWMS-26782's move honours its
ruling; **SWMS-26754's does not**. Both are treated in full under "Stop
conditions".

Nothing else in any published field moved. `m1_pure`, `stage_v2` and
`stage_v2_post_overlay` are byte-identical on all 407 cards — this change touches
the legacy visible ladder only. `m1_published` changed on SWMS-26782 alone,
because M1's published value takes its `displayedStatus` short-circuit and that
card's displayed status changed; that circularity is pre-existing and is exactly
what `SesStageV2Input` omits `displayedStatus` to avoid.

### Nothing is archived

- Archive: 303 -> 302 pre-overlay 264 -> 264. The only movement is **out** of
  Archive.
- Structurally, not just measurably: the only two paths to `archive` are
  `jobs.status === 'archived'` (untouched, early-return) and the `invoiceDone`
  branch. Narrowing `invoiceDone` can only ever remove cards from that branch.
  A test sweeps three families x four doc combinations x two invoice dates and
  asserts no combination of a DRAFT invoice and close-out docs can produce
  `archive` or `completed`.

### The archive trap named in the brief

`_makesafeMissingCloseoutDocs` + `invoiceDone` + `_deriveMakesafeBoardStage` was
the path where attaching a draft invoice PDF to a roof or assessment card
satisfied the gate and archived the card. **That path is now closed for a DRAFT
invoice**: the card never enters the `invoiceDone` branch, so the gate is never
consulted and the attachment cannot archive anything. A raised invoice plus its
PDF still closes the card exactly as before. The trap is strictly harder to fall
into, and the exhaustive sweep test is what holds it shut.

Worth stating plainly: the branch histogram shows `13519` (invoiceDone, gate
satisfied, close the card) at **128 before and 128 after**. No live card was
being archived by a DRAFT invoice today — the trap was latent. What was actually
firing is the doc-gate hold, `13517`, which drops from **22 to 5**.

## The honest shortfall: 4 cards left Docs Ready, not 15

The brief expected roughly 15. Four moved. The audit's mechanism attribution was
right about which branch fires today and incomplete about what happens when it
stops.

| Card | Family | After | Why |
|---|---|---|---|
| SWMS-26709 | roof | Allocated | moved |
| SWMS-26754 | roof | Allocated | moved |
| SWMS-26803 | roof | Allocated | moved |
| SWMS-26848 | roof | Allocated | moved |
| SWMS-26728 | assessment | Docs Ready | held by branch 13521, substatus `ready_to_invoice` |
| SWMS-26732 | assessment | Docs Ready | same |
| SWMS-26735 | roof | Docs Ready | same |
| SWMS-26736 | roof | Docs Ready | same |
| SWMS-26740 | assessment | Docs Ready | same |
| SWMS-26748 | assessment | Docs Ready | same |
| SWMS-26759 | roof | Docs Ready | same |
| SWMS-26851 | assessment | Docs Ready | same |
| SWMS-26852 | assessment | Docs Ready | same |
| SWMS-26853 | assessment | Docs Ready | same |
| SWMS-26857 | assessment | Docs Ready | same |

Eleven of the fifteen are held in Docs Ready by a **second, independent
mechanism**: `hasSubmittedReport` counts substatus `ready_to_invoice` as
submitted-report evidence, and the fall-through at branch 13521 returns
`report_ready` on its own. That is F4's residue — F4 stopped intake writing
`ready_to_invoice` and switched new cards to
`MAKESAFE_SUBSTATUS_AWAITING_PORTAL_COMPLETION`, but the pre-F4 rows still carry
the old stamp. It is a claim about REPORT evidence, not about invoice status, so
it is not this change's predicate and folding it in silently would hide a second
behaviour change inside this one.

It was measured rather than guessed at. Dropping `ready_to_invoice` from the
ladder's `hasSubmittedReport` **in addition** to this change gives:

- Docs Ready 24 -> **4**; 22 cards move (vs 5 here);
- five of those 22 carry no invoice at all (SWMS-261079/261113/261114/261116/261123
  go Docs Ready -> New), so they are pure F4 residue and nothing to do with a
  DRAFT invoice;
- a **second** captain display overlay stops binding: SWMS-26855 goes
  Archive -> New.

That is a separate release with its own blast and its own overlay casualty. It is
not in this PR.

### What the five no-invoice cards actually are, and where they belong

Firstmate refused the naive version of that second change on the strength of
those five cards, and was right to: a card carrying a report is not a New card.
Investigated read-only, all five are one identical shape —
`SWMS-261079`, `SWMS-261113`, `SWMS-261114`, `SWMS-261116`, `SWMS-261123`:

- family `ordinary_roof_portal`, `jobs.status = 'accepted'`, substatus
  `ready_to_invoice` (the pre-F4 intake stamp);
- **work order attached**, and **five builder portal links** on the card;
- zero assignments, no service report, no `report_received_at`, no report
  document, no completed portal capture, and **no invoice of any kind**;
- every link is typed `builder_portal` rather than `roof_report`, so M1 reports
  "the work order email contains no roof report link — ask the builder to send
  it".

**They belong in Allocated**, on three independent authorities: the captain ruled
it directly for SWMS-261114 ("Correct work order attached, which is good. Nothing
written on the roof report. **Not Docs Ready. Allocated.**"), and both `m1_pure`
and `stage_v2` already derive `allocated` for all five today.

They dropped to New in the naive experiment for a reason that has nothing to do
with `ready_to_invoice`: **the legacy ladder has no portal-link branch.** M1 and
the corrected engine both gained one — a non-physical family with at least one
external link is Allocated — and the legacy ladder never did. Removing the
`ready_to_invoice` crutch simply exposed the missing branch, exactly as removing
the DRAFT-invoice crutch exposed SWMS-26754's missing report evidence.

Measured, read-only, same population and same pinned `--now`:

| | Before | Drop `ready_to_invoice` alone | Drop it **and** add the portal-link branch |
|---|---|---|---|
| New | 35 | **43** | **35** |
| Allocated | 31 | 45 | 53 |
| Trade Report In | 12 | 12 | 12 |
| Docs Ready | 24 | 4 | 4 |
| Completed | 2 | 2 | 2 |
| Archive | 303 | 301 | 301 |
| cards landing in New | — | 5 | **none** |

So the follow-up release is not "drop `ready_to_invoice`". It is **"drop
`ready_to_invoice` and give the legacy ladder the portal-link Allocated branch
M1 and v2 already have"**, which puts all five where the captain and both other
engines say they belong and demotes nothing. In that shape the captain-ruled
movers are SWMS-261114 (Docs Ready -> Allocated, **matching his ruling exactly**)
and SWMS-26754 (the same conflict as here). Two overlays unbind, SWMS-26782 and
SWMS-26855.

SWMS-26754 is therefore the single blocker common to both releases, and it is an
evidence problem rather than a ladder problem.

## The one overlay this change unbinds: SWMS-26782

`makesafe_board_status_applications` is the captain-approved display ledger, and
an overlay binds only while `application.source_status` equals the freshly
derived `declared_stage`. SWMS-26782 carries
`report_ready -> archive` from run `ses-u7-three-net-close-20260728-0755`. This
change derives `allocated`, so the overlay stops binding and the card leaves
Archive.

Three facts bear on whether that is a captain decision being voided:

1. **It is already the certified destination.** The frozen E1 baseline
   (`scripts/ses-e1-stage-baseline-v1.json`, snapshot 2026-08-02T06:18:52Z)
   certifies SWMS-26782 as a disputed card with `current: archive`,
   `newer_pure: allocated`, `post_cutover: allocated` and
   `post_cutover_overlay_binds: false`. The corrected engine and M1 both already
   say Allocated, and the freeze already recorded that this overlay stops binding
   under a corrected derivation. All five movers land on their own certified
   `post_cutover` value. This change does not invent a destination for any card;
   it makes the visible ladder agree with the one already adjudicated.
2. **It is one of the nine already-flagged unbinds.**
   `overlays_binding_today_that_would_unbind` goes 9 -> 8. Re-anchoring those
   nine rows is Release 9 of
   `data/ses-f10-stage-engine-v2-design-v1/report.md`, per
   `docs/evidence/ses-e1-stage-engine-v2-shadow-2026-08-02.md`.
3. **It moves the safe direction.** The card reappears in Allocated with two
   assignments, no service report, no report PDF and an unmet SWMS requirement.
   Nothing is archived and no work disappears.

Firstmate's decision, 2026-08-02: ship it, and name it. The full statement is
under "Stop conditions" below, kept there so a reader checking the stop
conditions finds it without having to reach this section.

## Effect on the frozen E1 baseline

`scripts/ses-e1-freeze-stage-baseline.ts --mode=verify` against the AFTER
snapshot reports 6 failures. They decompose cleanly, and **v1 was not
re-snapshotted** — per CLAUDE.md, a frozen manifest is never re-cut to make a run
green:

- **1 pre-existing.** `SWMS-261081` is already "no longer disputed" against the
  BEFORE snapshot, i.e. on unmodified `main`. Live drift since the 06:18Z freeze,
  not this change.
- **5 caused by this change, all convergence.** SWMS-26709 / 26754 / 26782 /
  26803 / 26848 stop being disputed because the legacy ladder now derives the
  same stage the certified corrected engine did. The contract's
  "no longer disputed" check exists to catch a dispute VANISHING under data
  drift; it cannot distinguish that from a dispute being RESOLVED by an
  intentional engine correction, which is the programme's goal. Disputed count
  71 -> 65; `disputed_changed` and `disputed_added` are both empty, so no
  certified adjudication was contradicted and no card was lost.

Whether to cut a `ses-e1-stage-baseline-v2.json` re-frozen against
`makesafe-stage-ladder.v2-raised-invoice` is Release-9-adjacent and belongs to
the owning E1 document, not to this PR.

## Stop conditions from the brief

| Condition | Result |
|---|---|
| Zero captain-ruled cards move | **ONE MOVES: SWMS-26754, against its ruling.** See below. SWMS-26782 also moves, and that one HONOURS its certification. The other nine ruled cards are unmoved. |
| No card may be archived | **PASS**, measured (Archive 303 -> 302, pre-overlay 264 -> 264) and structurally (narrowing `invoiceDone` can only remove cards from the sole non-`jobs.status` archive path), with an exhaustive sweep test. |
| Production reads only | **PASS.** Management API `/database/query`, `read_only: true`, SELECT only, through `assertReadOnlySql` + `assertNoPiiColumns`. |
| No PII anywhere | **PASS.** Job references, builder scope and family only. The only match for an email-shaped pattern in the artifacts is the literal word "email" inside M1's own explanatory sentences ("The work order email contains no roof report link"). |
| Regression test fails on the old shape | **PASS, proved.** See below. |
| Engine version bumped | **PASS.** `MAKESAFE_STAGE_LADDER_VERSION`, introduced because the visible ladder had no version to bump. |

### Stop condition 5, run against every card the captain read personally

The rulings live in firstmate's home, not in this repository:
`/Users/marninstobbe/kun-agent-workspace/data/decisions/` (16 files) and
`/Users/marninstobbe/kun-agent-workspace/data/ses-docsready-screenshot-audit-v1/report.md`.
The eleven cards he read with his own eyes on 2026-08-02, checked against this
change:

| Card | His ruling | Before | After | Verdict |
|---|---|---|---|---|
| SWMS-261114 | Not Docs Ready. Allocated. | Docs Ready | Docs Ready | unmoved |
| SWMS-261025 | Completed. Shaun already sent it. | Trade Report In | Trade Report In | unmoved |
| SWMS-261021 | Docs Ready once the skill runs | Trade Report In | Trade Report In | unmoved |
| SWMS-261015 | Run the skill, author the report | Trade Report In | Trade Report In | unmoved |
| SWMS-26832 | Needs investigation before anything moves | Docs Ready | Docs Ready | unmoved |
| **SWMS-26754** | **Invoice it. "That one probably we should be invoicing."** | **Docs Ready** | **Allocated** | **VIOLATES** |
| SWMS-26707 | Waiting on the trade. Follow up. | Allocated | Allocated | unmoved |
| SWMS-26619 | Waiting on the trade. Follow up. | Allocated | Allocated | unmoved |
| SWMS-261065 | Run the skill | Trade Report In | Trade Report In | unmoved |
| SWMS-261109 | Run the skill | Docs Ready | Docs Ready | unmoved |
| SWMS-261059 | Completed or Archive, both acceptable | Docs Ready | Docs Ready | unmoved |

**SWMS-26754 Karrinyup (MLB-26323) is a genuine stop-condition hit.** He opened
it, found the roof report done 40 days ago and a DRAFT invoice (INV-0932, $330)
on it, and ruled: invoice it — "the expired link is not a reason to hold a
completed roof job". This change moves it to **Allocated**, which is the board's
"waiting on the trade" state and is precisely the end state his standing
instruction rejects: *"There should be no way that I come tomorrow and see
there's a job with a report in it that we don't send to Docs Ready."*

The mechanism is worth stating exactly, because it is not a defect in this
change:

- Our records hold **no** report evidence for the card — no `job_service_reports`
  row, no `report_received_at`, no report document, no completed portal capture.
  The only report that exists is the one the captain saw in the builder's portal.
- The portal link is expired, and per the audit's own root-cause finding
  `capture_portal_evidence.py` cannot currently distinguish an expired link from
  an unsubmitted form, so the deterministic reader cannot recover the fact
  either.
- The DRAFT invoice was therefore the *only* thing holding the card in Docs
  Ready. It was in the right column for the wrong reason, and removing the wrong
  reason exposes the missing evidence.

So the card's correct destination cannot be DERIVED tonight; it is only KNOWN,
by the captain. Under the repository's own rule for exactly this situation —
never resolve such a card in code, resolve it by recording the ruling as evidence
and letting the engine derive from it — the fix is a record, not a predicate.
That is a production write, which this task is forbidden from making, so it was
escalated. Note also that "invoice it" is his own APPROVE INVOICE click: per
`2026-08-02-sealed-jobs-cannot-be-invoiced-by-an-agent.md` no agent can mint an
invoice on a sealed card, so honouring the ruling means putting the card in front
of him, not billing it.

The other three cards this change moves out of Docs Ready — SWMS-26709,
SWMS-26803, SWMS-26848 — land in exactly the destination the screenshot audit
itself assigned to that group: *"Belongs in Allocated / blocked on builder."*
The single conflict is the one card where the captain overrode the audit.

### SWMS-26782 is a captain-ruled card that moves, and the move honours the ruling

Recorded here explicitly so nobody later reads it as a stop condition that was
walked past.

The card carries a captain-approved display overlay, `report_ready -> archive`
from run `ses-u7-three-net-close-20260728-0755`. This change derives `allocated`,
so the overlay stops binding and the card leaves Archive.

That is the ruling being **honoured**, not violated. The frozen E1 baseline
(`scripts/ses-e1-stage-baseline-v1.json`, snapshot 2026-08-02T06:18:52Z)
certifies SWMS-26782 with `current: archive`, `newer_pure: allocated`,
`post_cutover: allocated` and **`post_cutover_overlay_binds: false`** — the
overlay was already certified as non-binding once the derivation is corrected,
and Allocated is already its certified destination. The card is going exactly
where the certification says it should, one release earlier than expected. It is
one of the nine already-flagged Release 9 unbinds (9 -> 8), and un-archiving
surfaces work rather than hiding it, which is the safe direction.

Firstmate's decision, 2026-08-02: ship it.

## Test evidence

`supabase/functions/ops-api/makesafe_draft_invoice_stage_test.ts`, 11 tests, all
passing. Reverting **only** the behaviour — putting `hasActiveMakesafeInvoice`
back into both `invoiceDone` terms and changing nothing else — makes 4 of the 11
fail:

- `a DRAFT invoice + its attached PDF no longer archives a report card` (the
  archive trap: derives `archive` on the old shape)
- `a DRAFT invoice no longer parks an unsendable card in Docs Ready` (derives
  `report_ready` on the old shape)
- `no combination of a DRAFT invoice and close-out docs can archive a card` (the
  exhaustive sweep)
- `enrichMakesafeBoardJob's invoiceDone uses the same raised-invoice term` (the
  source-level anti-drift pin)

The remaining 7 are the no-regression half — raised invoices still close cards,
the doc gate still holds a raised invoice with no PDF, `readyForReview` still
reads a DRAFT, the operator terms still work — and they pass on both shapes by
design.

Full ops-api suite: 2873 passed / 18 failed. The same 18 fail on unmodified
`main` at `7f7cb5f` (extracted and diffed by test site: zero new failures, and
`+11` passing is exactly this file). One of the 18,
`ses_artifact_hash_budget_test.ts`, needs `--allow-run`, which
`deno task test:ops-api` does not grant.

`deno check --config deno.jsonc supabase/functions/ops-api/index.ts` is clean.
`deno lint` and `deno fmt --check` pass on every touched file that is not
excluded by `deno.jsonc`.

## Reproducing

```bash
SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read \
  --allow-write scripts/ses-stage-parity-harness.ts \
  --out=/tmp/parity.json --now=2026-08-02T12:00:00.000Z

deno run --allow-read scripts/ses-e1-freeze-stage-baseline.ts --mode=verify \
  --parity=/tmp/parity.json --baseline=scripts/ses-e1-stage-baseline-v1.json
```

`--now` is required for a comparable run: without it the 7-day
completed/archive clock advances between snapshots and the delta is not
attributable to the change.
