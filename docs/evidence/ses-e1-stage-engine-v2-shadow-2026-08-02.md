# SES E1 — the corrected stage engine, Releases 0-3 (shadow only)

**Design authority:** `data/ses-f10-stage-engine-v2-design-v1/report.md`
**Captain ruling:** `data/decisions/2026-08-02-stage-engine-ruling.md`
**Scope:** Releases 0, 1, 2 and 3 of the design's section 7 landing plan. One
counted behaviour change per release. Nothing here is a cutover authorisation.

## Why this exists

The board runs two stage engines. `_deriveMakesafeBoardStage` (ops-api
`index.ts`) places the cards people see. `computeMakesafeStatus`
(`makesafe_computed_status.ts`) is what every measurement and certificate grades
against. They disagree on 71 of 407 active cards, so the board and the numbers
describing the board have been describing different boards.

These four releases build the one corrected evidence-derived engine that will
replace both. They do NOT cut over to it. Through all four:

- `canonical_stage` stays legacy-authoritative and byte-identical;
- zero cards move;
- overlay binding is untouched — re-anchoring is Release 9;
- `makesafe_evidence_requirements.ts` (the independent evidence ruler) is not
  read, written or imported by anything added here;
- the SES money seal is not read around, and no invoice write exists in this
  work at all;
- every production access is a Management API `SELECT` with `read_only: true`,
  naming no client name, phone, email or street address.

## Standing invariants this work adds

**The shadow engine is pure and has no authority.** `ses_stage_engine_v2.ts`
receives no displayed stage, queries no overlay, and its output is published as
advisory fields only. `projectOpsMakesafeBoard` still buckets on
`canonical_stage`, which still comes from the legacy ladder plus the existing
overlay resolver. There is deliberately no flag, env var or config switch that
could promote the advisory value; the authority flip is Release 12 and is a
separate captain-approved decision that must be written, not thrown.

**The advisory post-overlay candidate is a simulation, never a binding.**
`sesStageV2OverlayCandidate` recomputes what the existing overlay resolver WOULD
do if the derivation changed. It reuses the same terminal guards and the same
source-equality predicate, and it writes nothing. Real overlay binding continues
to read `declared_stage`, exactly as before.

**The freeze is an identity manifest, not a pinned count.**
`scripts/ses-stage-baseline-contract.ts` fails only when a certified card leaves
the population, stops being disputed, or changes its adjudication. New cards,
new disputes and moved input hashes are reported. Never re-snapshot the frozen
file to make a drifted run green — a missing certified identity is the defect
the freeze exists to catch.

**Every number here names its snapshot.** Live data drifts. The design's numbers
were taken at 2026-08-02 05:06Z; these were taken at 2026-08-02 06:18Z onward.
Where they differ, the difference is reported below rather than reconciled.

## Release 0 — freeze the baseline

**Behaviour change:** none. No product file was touched.

**What landed**

- `scripts/ses-stage-baseline-contract.ts` — pure freeze/verify contract:
  content-derived `generation_id`, per-card input hash covering card INPUTS and
  never either engine's verdict, and the disputed-card identity manifest.
- `scripts/ses-e1-freeze-stage-baseline.ts` — offline freeze/verify CLI over a
  parity-harness JSON.
- `scripts/ses-e1-stage-baseline-v1.json` — the frozen artifact.
- `scripts/test/ses-stage-baseline-contract_test.ts` — 13 offline tests,
  including assertions pinned to the committed artifact.

**Measured**

| Fact | Design (05:06Z) | Measured (06:18Z) |
|---|---:|---:|
| Population (`ses-board-population/active-v1`) | 407 | 407 |
| Post-overlay cards changing column | 71 | 71 |
| Pure M1 vs legacy canonical disagreements | 104 | 104 |
| Overlay rows / binding today / would unbind | 46 / 42 / 9 | 46 / 42 / 9 |
| Current columns (new/alloc/TRI/ready/comp/arch) | 36/30/12/24/2/303 | 36/30/12/24/2/303 |
| Uncorrected candidate columns | 40/57/9/0/39/262 | 40/57/9/0/39/262 |

The 71-card manifest is **identical** to the design's section 4 table, card for
card. Transition histogram: `archive -> completed` 34 (G1),
`report_ready -> allocated` 23 (G2 17 + G3 6), `trade_report_in -> completed` 2
and `report_ready -> completed` 1 (G4), `trade_report_in -> allocated` 2 (G5),
`archive -> new` 2 and `archive -> allocated` 4 (G6 5 + G7 1),
`archive -> trade_report_in` 1 (G7), `allocated -> new` 2 (G8).

**Exit condition met.** An independent rerun of the harness reproduced the same
content-derived `generation_id`
(`90d11faa…`) and `disputed_manifest_id` (`59d16ae3…`), with zero failures,
zero moved input hashes and zero added disputes. Test baseline is unchanged:
2690 passed / 21 failed under `deno test --no-check` both with and without this
branch (the 21 failures and the `myjobs_all_means_all_test.ts` TS2322 are
pre-existing on `96ac2ef`).

Reproduce:

```sh
SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read \
  --allow-write scripts/ses-stage-parity-harness.ts --out=.audit/parity.json
deno run --allow-read scripts/ses-e1-freeze-stage-baseline.ts --mode=verify \
  --parity=.audit/parity.json --baseline=scripts/ses-e1-stage-baseline-v1.json
```
