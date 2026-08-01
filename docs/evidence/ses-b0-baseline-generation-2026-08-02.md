# SES plan v2 Batch 0 — green baseline, named denominator, self-describing measurement

Date: 2026-08-02
Authority: plan v2 §D "Batch 0" and §D.0 write-safety rules.
Scope: code only. **Zero production writes of any kind.** Every production read
in this batch went through the Management API `/database/query` with
`read_only: true`, which the database itself enforces, behind the harnesses'
own `assertReadOnlySql` / `assertNoPiiColumns` guards.

Batch 0 deliberately changes **no ruler rule**. The PO/SWMS ruling encode is
Batch 1, and D.0 rule 6 forbids shipping a ruler change together with anything
else that moves board-wide counts. The measured `fail 364` below is the
unchanged pre-Batch-1 baseline and is the proof of that.

---

## 1. The red baseline, and why it was red

`scripts/test/ses-measure-card-evidence_test.ts:444` asserted the rendered
measurement named `ses-evidence-requirements/c1-po-ruling-v2`, while
`SES_EVIDENCE_CONTRACT_VERSION` had correctly moved on to
`c1-unlinked-invoice-v3`.

```
FAILED | 21 passed | 1 failed   (before)
ok     | 22 passed | 0 failed   (after)
```

The bump was right; the test was stale. The assertion is about the render
**naming its ruler**, not about which ruler is current, so it now imports
`SES_EVIDENCE_CONTRACT_VERSION` rather than restating the literal. The
deliberate version pin stays in exactly one place — the ruler's own suite
(`makesafe_evidence_requirements_test.ts:700`) — where a bump is meant to be
felt. That is the general rule: **one pin, in the owning module's suite;
consumers import.**

### The three named suites

| Suite | Result |
|---|---|
| `supabase/functions/ops-api/makesafe_evidence_requirements_test.ts` | ok, 22 passed |
| `scripts/test/ses-measure-card-evidence_test.ts` | ok, 22 passed |
| `supabase/functions/ops-api/makesafe_invoice_reference_match_test.ts` | ok, 16 passed |
| `scripts/test/` (whole directory, incl. 23 new) | ok, 129 passed |

Pre-existing and **not** touched by this batch, confirmed identical on the base
commit by stashing this branch's work and re-running: `deno task test:ops-api`
fails type-check at `myjobs_all_means_all_test.ts:382` (TS2322), and
`deno test --no-check supabase/functions/ops-api/` returns
`2667 passed | 20 failed` both with and without this change. The
`deno check supabase/functions/ops-api/index.ts` gate is clean.

---

## 2. The population contract — named and versioned, NOT frozen

`scripts/ses-board-population-contract.ts`.

The same board predicate was hand-written in each harness. It is now one named,
versioned contract that every artifact records.

**This is a default, not a ruling.** Captain decision C.5 — is "the board" the
407 active cards, or all 440 including the 33 cancelled? — is open. Batch 0's
stated risk was "freezing the denominator at 407 when the Captain wanted 440
makes every later number quietly wrong by 33 cards". So `active-v1` carries a
non-null `pending_captain_decision`, and `describeSesBoardPopulation()` renders:

```
ses-board-population/active-v1 [NOT FINAL — pending C.5 (active-only vs
all-including-cancelled); this is not "the whole board"]
```

The caveat travels in the run banner **and** inside every artifact header, so a
count cannot be quoted out of context as board-complete. A test asserts the
caveat is present while C.5 is open.

When C.5 lands: add a **new** versioned contract and switch the export. Never
edit `active-v1` in place — past measurements carry that version string and must
stay attributable to the population that produced them, exactly as
`SES_EVIDENCE_CONTRACT_VERSION` keeps a reading attributable to its ruler.

**Naming it moved no number.** The refactor was verified as a pure one by
running the parity harness before and after against the same production state:
identical summary block, identical 407-card set, identical row-count banner.

---

## 3. Generation self-description (D.0 rule 3)

`scripts/ses-measurement-generation.ts`, consumed by
`scripts/ses-c2-measure-board-evidence.ts`. Every artifact header now carries
`generation_id`, `snapshot_at`, `population_contract_version`,
`population_contract`, `ruler_contract_version` and `card_count`, and every card
carries an `input_hash`.

Two inversions are load-bearing, and both are the opposite of the obvious
choice:

- **`generation_id` is content-derived, never random or clock-derived.** The
  plan's independent-verification step is "a second agent re-runs the harness and
  reproduces the same generation hash", which is only possible if the id is a
  function of the measured state. It hashes the two contract versions plus the
  job_id-sorted per-card hashes; `snapshot_at` is recorded *beside* it, not
  inside it. Sorting means PostgREST read order cannot change the id.
- **The per-card hash covers card INPUT facts, never the ruler's verdict.**
  Hashing the verdict would make Batch 1's `SES_EVIDENCE_CONTRACT_VERSION` bump
  look like "all 407 cards changed underneath us", and an apply would skip its
  entire approved set for the wrong reason. Card state moves the hash; ruler
  opinion moves the version.

The hashed projection is an allow-list of structural facts — family, stage,
computed stage, overlay stage, job status, archived, substatus, company slug,
cycle number, reattend boundary, photo count, and per-item
`present`/`substitute_present`/`transit_record_without_artifact`/`count`. It
carries no client name, phone, email or address (asserted by test), and it
deliberately **excludes** the inventory's free-text `detail` provenance so that
rewording a measurement message cannot invalidate an approved apply set.

### Measured, two consecutive read-only runs

```
generation ffbe713a18256d7ec56de000fabebf2b32a571c4d7292a7db281aa00bf0b75e9 @ 2026-08-01T21:02:23.056Z
generation ffbe713a18256d7ec56de000fabebf2b32a571c4d7292a7db281aa00bf0b75e9 @ 2026-08-01T21:02:35.304Z
population ses-board-population/active-v1 [NOT FINAL — pending C.5 …]
ruler      ses-evidence-requirements/c1-unlinked-invoice-v3
407 cards, 11 queries
```

Generation id identical across runs; `snapshot_at` differs by design; 407 of 407
per-card hashes unique and stable across both runs.

Verdicts at this generation: **fail 364 · pass 17 · undetermined 7 · refused
19**, and unlinked invoice matching **51 matched / 28 excluded as ambiguous** —
the unchanged pre-Batch-1 baseline. Batch 1 predicts fail 364 → 59–62 once the
PO ruling is encoded; that comparison is now anchored to a named generation.

---

## 4. The parity harness, committed

`scripts/ses-stage-parity-harness.ts`, taken from
`ses-stage-parity-measure-v1` report Appendix D. That scout wrote it and
deliberately did not commit it; it is the only tool that can answer "did the
divergence move?", and it should not have died with the scout worktree.

Its imports-not-reimplementations discipline is intact: it runs the real legacy
ladder through `buildCanonicalMakesafeRows` and the real
`computeMakesafeStatus`, over one set of production reads.

**Reproduced from a clean checkout, verbatim, before any edit:**

```
board cards: 407
rows: details=406 reports=78 invoices=209 documents=937 packs=65 pack_cycles=61
      dockets=0 assignments=368 note_candidates=322 status_apps=46 photo_rows=84 holds=0

total                                                   407
cards_changing_column_m1_pure_vs_legacy_canonical       104
cards_changing_column_after_cutover_with_overlays_reapplied  71   ← [SP]'s number
overlays_total                                           46
overlays_binding_today                                   42
overlays_that_would_unbind_under_m1                      13
overlays_binding_today_that_would_unbind                  9
```

**71 of 407**, matching the scout exactly, as do all four overlay tallies. The
only change made to the file afterwards was routing its board predicate through
the population contract; re-running proved the summary block and card set
byte-identical, so the 71 is a property of the committed file, not of the
verbatim copy.

---

## 5. What this batch did not do

- No production write of any kind, no migration, no deploy.
- No ruler rule changed; `SES_EVIDENCE_CONTRACT_VERSION` is untouched at
  `c1-unlinked-invoice-v3`. Batch 1 owns the PO/SWMS encode and its version bump.
- The denominator is **not** frozen. C.5 remains open and the contract says so
  in every artifact it stamps.
- The 20 pre-existing `ops-api` test failures and the pre-existing
  `myjobs_all_means_all_test.ts` type error are left exactly as found.
