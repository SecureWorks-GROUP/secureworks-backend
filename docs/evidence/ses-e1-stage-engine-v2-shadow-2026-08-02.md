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
| Current columns (new/alloc/TRI/ready/comp/arch) | 36/30/12/24/2/303 | 36/30/12/24/2/303 (original stacked-branch snapshot) |
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

## Release 1 — publish the advisory field

**Behaviour change:** exactly one — the canonical board row gains advisory
`derived_stage_v2*` keys. Zero placements move.

**What landed**

- `supabase/functions/ops-api/ses_stage_engine_v2.ts` — the pure corrected
  engine. Its input type structurally omits `displayedStatus`, so it cannot
  take M1's terminal display short-circuit; the read model now builds the
  evidence input WITHOUT that key and appends it only for M1's own call.
- `makesafe_computed_status.ts` — pure extraction. `deriveMakesafeEvidenceStage`
  lifts the evidence half of the ladder (READY pack, report-in, allocation, new)
  out of `computeMakesafeStatus` verbatim so both engines consume ONE definition
  of what evidence proves. `docsReady`, `closeoutSatisfied` and `completedAt`
  became exported for the same reason. No logic moved; M1's output is identical.
- `makesafe_board_read_model.ts` — publishes `derived_stage_v2`,
  `derived_stage_v2_post_overlay`, `derived_stage_v2_overlay_binds`,
  `derived_stage_v2_agrees_with_canonical`, `derived_stage_v2_reasons`,
  `derived_stage_v2_missing`, `derived_stage_v2_conflicts` and
  `derived_stage_v2_engine_version`.
- `scripts/ses-stage-parity-harness.ts` — reads the published advisory value
  rather than recomputing it, and reports the corrected engine's prospective
  blast, its conflicts, and a Release 1 self-check.
- `supabase/functions/ops-api/ses_stage_engine_v2_test.ts` — 11 response-contract
  and boundary tests.

**Measured (2026-08-02T06:4xZ)**

| Fact | Design | Measured |
|---|---:|---:|
| Advisory values differing from today's published `computed_status` | 74 | 74 |
| Placements moved | 0 | 0 |
| Current columns (new/alloc/TRI/ready/comp/arch) | 36/30/12/24/2/303 | 36/30/12/24/2/303 |
| `derived_stage_v2` == uncorrected pure M1 | (identity) | 407 / 407 |
| `derived_stage_v2_post_overlay` == uncorrected candidate | (identity) | 407 / 407 |
| Prospective corrected moves | 71 | 71 |

Release 1 is a true no-op shadow: the corrected engine reproduces the newer
engine card for card, terminal faults included. That is deliberate — Release 2's
34-card blast has to be attributable to Release 2, not smuggled in here. An
early draft of this engine routed the raw-terminal branch through the clock and
the harness caught it immediately as 34 cards diverging at Release 1; the fix
was to keep the fault and let Release 2 own it.

**Exit condition met.** No consumer renders the advisory field:

- `projectTradeMakesafeBoard` is a strict allow-list and is asserted to carry no
  `derived_stage_v2*` key;
- `projectOpsMakesafeBoard` buckets on `canonical_stage` only, proven with a
  card whose advisory value is `new` while its column is `archive`;
- `makesafeStatusReviewCards`, the disagreement list, the canary and the status
  shadow all pick named `computed_status*` fields and are untouched;
- the frozen Release 0 baseline still verifies with the same `generation_id`,
  zero failures, zero moved hashes and zero added disputes.

Overlay behaviour is byte-identical: real binding still reads `declared_stage`,
and `sesStageV2OverlayCandidate` is a simulation with the same three guards that
binds nothing. The card whose overlay would unbind is reported, not rebound.

### Release 1 re-land — re-measured against `main`

Releases 1-3 were originally squash-merged into their own base branches rather
than into `main`, so none of the three reached production history. They are
re-landed one at a time, each based directly on `main`, and each re-measured
against a FRESH read-only snapshot rather than trusting the stacked-branch
numbers above.

Snapshot `2026-08-02T08:43:19Z`, population `ses-board-population/active-v1`,
407 cards, 13 SELECT-only Management API queries, base commit `2c471eb`
(`main` moved under this work; the branch was rebased and every number below
re-measured against the new base, not carried over).

| Fact | Expected | Measured |
|---|---:|---:|
| Advisory values differing from published `computed_status` | 74 | 74 |
| Placements moved | 0 | 0 |
| `derived_stage_v2` == uncorrected pure M1 | (identity) | 407 / 407 |
| `derived_stage_v2_post_overlay` == uncorrected candidate | (identity) | 407 / 407 |
| Prospective corrected moves | 71 | 71 |
| Frozen Release 0 disputed manifest | reproduces | 71 / 71, manifest id identical |

Placement proof is an A/B over the same tree rather than an assertion: the
harness was run once at `2c471eb` and once at this branch's tip. Per card,
`legacy_canonical_stage`, `legacy_stage`, `m1_published`, `m1_pure`,
`post_cutover_stage`, `post_cutover_overlay_binds` and the whole `overlay`
object are identical on all 407 cards. Overlays stay 46 total / 42 binding.

Two drifts from the stacked-branch reading, reported rather than reconciled:

- Current columns read `35/30/13/24/2/303`, not the `36/30/12/24/2/303`
  recorded above. One card aged out of `new` into `trade_report_in` in live
  data between the two snapshots. It is NOT a code effect — the `2c471eb`
  baseline run in this same session reports the identical `35/30/13/24/2/303`.
- `ses-e1-freeze-stage-baseline.ts --mode=verify` passes with zero failures but
  a different `generation_id`, because six cards changed input facts since the
  freeze (`SWMS-261115`, `SWMS-26393`, `SWMS-26657`, `SWMS-26658`,
  `SWMS-26659`, `SWMS-26660`). The disputed manifest id is byte-identical,
  which is the invariant that matters: `disputed_missing`, `disputed_changed`
  and `disputed_added` are all empty, so no certified disputed card was lost,
  changed or added.

## Release 2 — one common clock

**Behaviour change:** exactly one — every terminal path in the shadow engine
runs through one `sesStageCompletedStage` helper, and a missing trusted
completion time is refused rather than guessed. Zero placements move.

**What landed**

- `sesStageCompletedStage` — THE common clock, called from both the raw
  `complete/completed/closed` shortcut and the durable close-out path. The newer
  engine applies the seven-day window on close-out and skips it entirely on the
  shortcut, which is why 34 jobs finished months ago would appear in "Completed
  This Week". Captain precondition 2: the clock applies on every path.
- `sesStageTrustedCompletionAt` — the named allow-list. Generic
  `jobs.updated_at` (a row touch, not completion proof) and
  `makesafe_job_details.invoice_ready_at` (a readiness marker, not an issue or a
  send) are dropped. What survives is a durable pack send, an issued invoice's
  date or creation, an explicit `jobs.completed_at`, or a durable report send.
  M1's own `completedAt` list stays where it is, unchanged, so the two are
  readable side by side.
- A missing trusted timestamp returns `decision_required` with conflict
  `completion_timestamp_missing`. The newer engine treats an unknown completion
  time as "within the window" and parks the card in Completed forever — a claim
  about this week that no evidence supports.
- 6 boundary tests: under seven days, exactly seven days, over seven days, on
  BOTH terminal paths; missing time; weak sources; per-source priority.

**Measured (2026-08-02T07:0xZ)**

| Fact | Design expected | Measured |
|---|---:|---:|
| Pure `completed -> archive` | 34 | **34** |
| Prospective corrected moves | 71 -> 37 | **71 -> 37** |
| Live placements moved | 0 | **0** |
| Raw-terminal missing-time blast | 0 | **0** |
| Pure Completed | 39 -> 5 | **39 -> 5** |
| Pure Archive | 229 -> 263 | **229 -> 263** |
| Any other pure stage changed | 0 | **0** |
| Overlay rows that would unbind | 9 | **9** |

Every number matches the design's isolated lab measurement. The 34 moved cards
are **identical** to the frozen manifest's G1 cohort, card for card.

Two findings worth recording, since both could have shown up as extra blast and
did not:

- Tightening the timestamp allow-list moved nothing on its own. All 34 changes
  are `completed -> archive` from the shortcut branch; no card lost a timestamp
  it was previously aged against, and no close-out card changed. That confirms
  the design's read-only finding that zero live cards depend on generic
  `updated_at`, and extends it: none depends on `invoice_ready_at` either.
- Zero cards reached `decision_required` at this snapshot, so the refusal is
  live but currently unexercised on production data. It is proven by test, not
  by a production card.

Exit condition met: boundary tests at `<7d` / `=7d` / `>7d` on both paths, a
fresh harness run, and the frozen Release 0 baseline still verifying with an
identical generation id. Tests: 2707 passed / 21 failed (same 21 pre-existing).

### Release 2 re-land — re-measured against `main`

Release 2 was re-landed on its own branch based directly on `main` at `570115e`
(the Release 1 squash), opened as its own PR, and re-measured against a FRESH
read-only snapshot rather than carrying the stacked-branch numbers forward.

Snapshot `2026-08-02T08:51:18Z`, population `ses-board-population/active-v1`,
407 cards, 13 SELECT-only Management API queries, base commit `570115e`.

| Fact | Expected | Measured |
|---|---:|---:|
| Pure `completed -> archive` | 34 | 34 |
| Prospective corrected moves | 71 -> 37 | 71 -> 37 |
| Live placements moved | 0 | 0 |
| Raw-terminal missing-time blast | 0 | 0 |
| Pure Completed | 39 -> 5 | 39 -> 5 |
| Pure Archive | 229 -> 263 | 229 -> 263 |
| Any other pure stage changed | 0 | 0 |
| Overlay rows that would unbind | 9 | 9 |
| Frozen Release 0 disputed manifest | reproduces | 71 / 71, manifest id identical |

The 34 moved cards are **exactly** the frozen Release 0 manifest's
`archive -> completed` cohort — set equality, no card in one and not the other.

Placement is proved by A/B rather than asserted: the harness was run once at
`570115e` and once at this branch's tip. Per card, `legacy_canonical_stage`,
`legacy_stage`, `m1_published`, `m1_pure`, `post_cutover_stage`,
`post_cutover_overlay_binds` and the whole `overlay` object are identical on all
407 cards, and overlays stay 46 total / 42 binding / 9 would-unbind on both
sides. The only diff between the two runs is the shadow engine's own value.

One boundary re-confirmed on the new base: `completedAt` in
`makesafe_computed_status.ts` loses its `export` because the corrected engine
now owns its own `sesStageTrustedCompletionAt` allow-list rather than borrowing
M1's. That is a visibility narrowing only — M1's own list and output are
untouched, which the zero `m1_pure` / `m1_published` diff above measures
directly.

Zero cards reached `decision_required` at this snapshot, so the missing-timestamp
refusal remains live but unexercised on production data, proven by test rather
than by a production card. That is unchanged from the original reading.

## Release 3 — corroborate the terminal shortcut

**Behaviour change:** exactly one — the shadow engine's raw
`complete/completed/closed` shortcut now requires an issued invoice. Zero
placements move.

**What landed**

- The shortcut runs only when the current invoice is `AUTHORISED`, `SUBMITTED`
  or `PAID`. `DRAFT` never qualifies; the captain ruled that explicitly.
- Uncorroborated, the engine records conflict `terminal_without_issued_invoice`
  and continues through READY pack, report-in, allocation and New. The raw
  terminal value is a claim, not proof, and it was burying stronger evidence
  sitting on the card.
- A mechanical fall-through to New is NOT evidence that the job is new. When
  the card carries no later-stage evidence at all, the raw terminal claim and
  the empty evidence contradict each other and the engine returns
  `decision_required` with `terminal_without_supporting_evidence`. This is a
  general rule about contradiction, not a card-specific special case.
- `sesStageCutoverGate` — a card the engine refuses to place STOPS a cutover.
  It reads the published advisory value, grants nothing, and passing it is not
  a cutover authorisation. The parity harness now runs the real gate over the
  real canonical rows and publishes the result.

**Measured (2026-08-02T09:00:05Z)**

| Fact | Design expected | Measured |
|---|---:|---:|
| Pure changes from the corroboration guard | 3 | **3** |
| Resolving to Trade Report In | 2 | **2** |
| Becoming decision-required | 1 | **1** |
| Prospective corrected moves | 37 -> 35 | **37 -> 35** |
| Pure Completed | 5 -> 2 | **5 -> 2** |
| Pure Trade Report In | 9 -> 11 | **9 -> 11** |
| Live placements moved | 0 | **0** |
| Cutover gate | blocked | **blocked, 1 card** |

The three-card cohort reproduces exactly: `SWMS-261024`, `SWMS-261025`,
`SWMS-261059`, all carrying `terminal_without_issued_invoice`.

**One reported difference from the design's numbers.** The design's C2 lab line
records pure New moving `66 -> 67`. Measured, New stays at **66** and
`decision_required` is **1**. That is not a divergence in the data — it is the
difference between the design's *mechanical* lab patch (which let
`SWMS-261059` fall through to New) and the design's own *final* ruling in
section 4, which converts that card to `decision_required` precisely because a
fall-through is not evidence. This build implements the ruling, so the
mechanical New count in C2 is the number that does not apply. Every other C2
number matches.

**Exit condition met.**

- Draft-invoice test: a `DRAFT` invoice does not close a card; it falls through
  to the proved evidence column and records the conflict.
- Non-issued test: no invoice at all does not pre-empt a submitted current-cycle
  report and the photo floor.
- `SWMS-261059` **stops the cutover gate** — `ok: false`, one blocked card,
  both conflicts named, and its true column left unresolved. It is not placed in
  New, Docs Ready, Completed or Archive, and this work takes no position on
  which it should be; that adjudication is the captain's.
- The card's rendered column is unchanged (`report_ready`), and
  `decision_required` never enters an ops column — `unmapped_stage_job_ids`
  stays empty because nothing buckets on the advisory value.

Targeted validation: 63 tests passed across `ses_stage_engine_v2_test.ts`,
`makesafe_computed_status_test.ts` and `makesafe_board_read_model_test.ts`;
`deno check` and lint were clean. The frozen Release 0 baseline re-verifies
with an identical generation id, so all four releases measured the same 407
cards and the same certified 71.

## Where this leaves the next task

Releases 4-6 and 8 are the remaining code-only/shadow work and can be picked up
without re-deriving anything above:

- **Release 4** — replace `classifyMakesafeJobType`'s three-kind guess with the
  canonical `ses_family` already on the row (7 real families plus unknown). 136
  diagnostic job-kind corrections expected, 0 column changes.
- **Release 5** — own-template roof current-cycle submitted-draft reader. 0
  current cards.
- **Release 6** — land the portal capture reader. 0 capture rows exist, so 0
  immediate evidence-driven moves; the rule seam covers 111 roof/assessment
  cards.
- **Release 8** — overlay re-anchor metadata and the no-op attestation read
  path. No ledger rows.

Release 7 (Docs Ready authority) and Release 9 (the nine-row re-anchor apply)
are both captain-gated and are not code-only.

Standing measurement after Releases 0-3, as read on the ORIGINAL stacked
branches: 407 cards; live columns 36/30/12/24/2/303 unchanged throughout;
corrected prospective moves **35**; corrected column candidate New 66 /
Allocated 64 / Trade Report In 11 / Docs Ready 0 / Completed 2 / Archive 263 /
decision-required 1; cutover gate **blocked** on `SWMS-261059`; 9 overlay rows
still due re-anchoring at Release 9. The re-land section below carries the
current reading against `main`.

### Release 3 re-land — re-measured against `main`

Release 3 was re-landed on its own branch based directly on `main` at `8928c18`
(the Release 2 squash), opened as its own PR, and re-measured against a FRESH
read-only snapshot rather than carrying the stacked-branch numbers forward.
This completes the three-release re-land; all of Releases 1-3 now reach `main`
one counted behaviour at a time, never stacked.

Snapshot `2026-08-02T09:00:05Z`, population `ses-board-population/active-v1`,
407 cards, 13 SELECT-only Management API queries, base commit `8928c18`.

| Fact | Expected | Measured |
|---|---:|---:|
| Pure stage changes | 3 | 3 |
| Resolving to Trade Report In | 2 | 2 (`SWMS-261024`, `SWMS-261025`) |
| Becoming decision-required | 1 | 1 (`SWMS-261059`) |
| Prospective corrected moves | 37 -> 35 | 37 -> 35 |
| Live placements moved | 0 | 0 |
| Cutover gate | blocked on `SWMS-261059` | blocked on `SWMS-261059` |
| Frozen Release 0 disputed manifest | reproduces | 71 / 71, manifest id identical |

`SWMS-261059` STOPS the gate rather than being placed, which is the point of
this release. `sesStageCutoverGate` returns `ok: false` over the real canonical
rows with that single card blocked, carrying both
`terminal_without_issued_invoice` and `terminal_without_supporting_evidence`.
Its live column is untouched at `report_ready` on both sides of the A/B. Its
true column remains an open captain question and is **not** resolved here.

Placement is proved by A/B rather than asserted: the harness was run once at
`8928c18` and once at this branch's tip. Per card, `legacy_canonical_stage`,
`legacy_stage`, `m1_published`, `m1_pure`, `post_cutover_stage`,
`post_cutover_overlay_binds` and the whole `overlay` object are identical on all
407 cards, and overlays stay 46 total / 42 binding / 9 would-unbind on both
sides.

One drift from the stacked-branch reading, reported rather than reconciled: the
corrected column candidate reads New 65 / Allocated 64 / Trade Report In 12 /
Docs Ready 0 / Completed 2 / Archive 263 / decision-required 1, against the
New 66 / Trade Report In 11 recorded above, and live columns read
`35/30/13/24/2/303` against `36/30/12/24/2/303`. Both are the same single card
ageing `new -> trade_report_in` in live data, first seen during the Release 1
re-land. It is NOT a code effect: the `8928c18` baseline run in this same
session reports the identical live columns, and the total stays 407.

## Release 4 — canonical family as a real engine input

**Behaviour change:** exactly one — the shadow engine reads the canonical SES
family instead of inferring one of three kinds, and refuses to advance a card
whose family cannot be identified. Zero placements move.

**What landed**

- `resolveSesStageV2Family` — an EXHAUSTIVE switch over `SesFamilyId`. The
  `never` check in its default arm is load-bearing: adding a family to
  `ses_family_matrix.ts` without deciding how it proves a stage is a type error
  here, not a silent fall-through to physical.
- `ses_family` on `MakesafeStatusInput`, supplied by the board read model, which
  already computed it. `computeMakesafeStatus` DELIBERATELY IGNORES the key and
  keeps its own `classifyMakesafeJobType` guess, so M1's published value stays
  byte-identical to what today's certificates grade against.
- An unidentifiable family returns `decision_required` with conflict
  `family_unknown`, placed AFTER every terminal branch so an explicit raw
  cancelled / archived / corroborated-complete state still resolves — those are
  facts about the job that hold whatever the family is.
- Three advisory keys published: `derived_stage_v2_family`,
  `derived_stage_v2_family_kind`, `derived_stage_v2_family_recipe_state`.
- The harness now counts the family distribution and the diagnostic corrections.

**The captain's ruling supersedes the design here.** The F10 design had repair
and restoration returning unsealed-recipe blockers. The ruling of 2026-08-02
(`data/decisions/2026-08-02-docs-ready-repair-restoration.md`) closed both
before this release landed — repair "match[es] the whole existing system",
restoration is "exactly the same as any other job, so it is a different family
type" — and named Release 4 as one of the things it unblocks. Both therefore
take the standard evidence path and keep their own family identity. Encoding a
blocker would have contradicted the ruling AND moved the one live restoration
card, which this release must not do. `recipe_state` has no `unsealed` member
as a result; re-opening a family needs a ruling, not a code edit.

**Measured (2026-08-02T09:24:38Z)**, base `1a33708`, 407 cards, 13 SELECT-only
Management API queries.

| Fact | Design expected | Measured |
|---|---:|---:|
| Diagnostic family-kind corrections | 136 | **136** |
| Live placements moved | 0 | **0** |
| Pure `derived_stage_v2` changes | 0 | **0** |
| Prospective corrected moves | 35 -> 35 | **35 -> 35** |
| Cutover gate | blocked on `SWMS-261059` | **unchanged** |

The 136 corrections decompose exactly as the design predicted:

| M1 called it | Canonical family | Cards |
|---|---|---:|
| `physical_makesafe` | `temporary_fencing` | 116 |
| `physical_makesafe` | `unknown` | 19 |
| `physical_makesafe` | `restoration` | 1 |

Full family distribution: physical 160, temporary fencing 116, ordinary roof
portal 60, assessment/quote 51, unknown 19, restoration 1. Own-template roof
and repair have 0 cards, as the design said.

Placement is proved by A/B rather than asserted: the harness was run once at
`1a33708` and once at this tip. Per card, `legacy_canonical_stage`,
`legacy_stage`, `m1_published`, `m1_pure`, `post_cutover_stage`,
`post_cutover_overlay_binds`, the whole `overlay` object AND `stage_v2` itself
are identical on all 407 cards. The corrected column counts are unchanged at
new 65 / allocated 64 / trade report in 12 / decision-required 1 / completed 2 /
archive 263.

Two findings worth recording, both reported rather than reconciled:

- **The `family_unknown` refusal is live but unexercised.** All 19
  unidentifiable cards sit in raw terminal states, so every one of them returns
  above the refusal and none reaches `decision_required`. That is why the pure
  stage blast is 0 rather than 19. It is proven by test, not by a production
  card — the same shape as Release 2's missing-timestamp refusal.
- **A measurement trap worth naming.** The first version of the harness metric
  compared the delegated evidence PATH and scored only 19 corrections, because
  temporary fencing, repair and restoration all delegate to physical and so
  "matched". The design counts family IDENTITY. Comparing paths would have
  reported this release as a sixth of the size it is.

**A pre-existing type defect fixed in passing.** `SesStageGateRow.derived_stage_v2`
was declared `string | null`, but the Release 3 regression test asserts the gate
handles a non-string (`42`), so `deno test` failed to type-check on `main`. CI
did not catch it because `deno check supabase/functions/ops-api/index.ts` never
reaches a test file. The field is now `unknown`, which is what the gate's own
fail-closed branch already believed — it proves the value is a non-empty string
before using it. A narrower type was the declaration telling callers something
the runtime does not.
