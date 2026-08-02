# SES instruction identity — conforming the key to the purchase-order grain

**Date:** 2026-08-02 AWST
**Ruling implemented:** `data/decisions/2026-08-02-purchase-order-is-the-job-grain.md`
**Supersedes for key purposes:** the composite `claim + PO` contract shipped on
PR 478 (`fm/ses-f9-instruction-identity-forward-v1`, head `b0a9413`)
**Production access:** Supabase Management API `/database/query`,
`read_only: true`, SELECT only. No write, no backfill, no re-key of any live card.

---

## 1. What changed, in one line

The canonical instruction key is now **builder scope + purchase order**
(`MLB:PO-54000`). The work order and claim reference are retained as grouping and
provenance and no longer appear in the identity.

Everything else PR 478 built — per-attachment key enumeration, the multi-key
draft refusal, the AJ one-number path, the terminal-card refusal, the atomic
reservation, the attach-time identity correction — is unchanged.

## 2. Why the composite key had to go

Under `claim + PO`, one purchase order carried under two spellings of its group
reference produced two keys, so one job became two cards:

```
MLB-10001PO-44444
MLB-10002PO-44444     <- same purchase order, different group reference
```

That is the exact twin the gate exists to prevent. The measurement below shows
production carries **zero** instances of that drift today, so the composite key
was closing no observed gap — but it was also **missing a real one**: see §4.

## 3. The measurement

`scripts/ses-identity-grain-measure.ts` re-proves all of this read-only and is
the tool to re-run after any new correction tranche. Run at 2026-08-02.

**Population** — `ses-identity-grain/membership-all-v1`: 440 SES board
membership cards **including** the cancelled/lost ones, minus terminal synthetic
live-fire. This is deliberately WIDER than
`ses-board-population/active-v1` (407): a cancelled twin is exactly the defect
the grain exists to prevent, so excluding it would hide the evidence. Captain
decision C.5 remains open.

**Two rules, reported separately, because the difference IS the finding:**

| Rule | Definition | Cards |
| --- | --- | --- |
| DECLARED | the card's OWN purchase order: `jobs.metadata.builder_po_number`, a PO parsed from its own `external_ref`, or its authoritative `makesafe_intake_cases.builder_po_canonical` | **62 / 440** |
| OBSERVED | additionally any PO the grammar reads from a `job_documents` work-order FILENAME — which the mint gate does read | **274 / 440** |

The gap is not noise. MLB routinely attaches every work-order PDF of a claim to
every card in that family, so an observed token is **not** proof of ownership.
212 cards have a PO only from an attached filename.

**Blind spots.** The grammar reads stored references and filenames only, never
rendered PDF text, so a PO existing only inside a document body is invisible
here. A builder reference in a spelling `BUILDER_REF_RE` / `PO_RE` cannot parse
counts as absent, not as unknown.

### Q1 — is a purchase order unique within a builder?

**Yes, with one named counter-example.**

- **5** DECLARED collisions over 57 (scope, PO) pairs.
- **23** OBSERVED collisions over 261 pairs.

Every one is accounted, and every one is either an adjudicated twin or the
artefact of both cards carrying both PDFs of a two-PO family. 21 of the 23
already sit in `scripts/ses-ab-certificate-v1.duplicate-accounting.txt`; the two
that do not are named in §6.

The single genuine counter-example is **`MLB:PO-54129`** (SWMS-26748 /
SWMS-26858). Its one work order declares TWO deliverables in its own text —
"Assessment Report & Quote" plus "temp fence required" — and each card carries
its own separately-priced invoice for a different one. That is one purchase
order that legitimately became two jobs. It is recorded, not smoothed over: see
§6 for what it means for the captain.

### Q2 — is a purchase order unique across builders?

**No collision observed — and the population can barely test it.**

Zero of 261 distinct PO digit runs appear under more than one builder. But only
two builders issue purchase orders at all (MLB 280 observations, Builderwest 5),
so this is weak evidence. The scope is therefore IN the key as a safety
property, not because a collision was seen. Stated, not assumed.

### Q3 — how often does the group reference drift for one purchase order?

**Zero times.** No (scope, PO) pair in production carries more than one group
reference, and the composite key would split **zero** of them. The probe's
failure is a latent hazard, not an observed loss. The new key closes it before
it can happen; that is the honest claim.

### Q4 — how many cards can a purchase-order key even reach?

| Builder scope | Cards | Declared PO | Observed PO | Cards with a key |
| --- | --- | --- | --- | --- |
| MLB | 282 | 60 | 269 | 269 |
| AJ | 143 | 0 | 0 | 138 |
| BWCWA (Builderwest) | 7 | 2 | 5 | 5 |
| WB (Western Building) | 5 | 0 | 0 | 0 |
| KBA | 1 | 0 | 0 | 0 |
| no builder scope | 2 | 0 | 0 | 0 |

Scope comes from the reference PREFIX first, so 13 cards whose company slug
disagrees with their reference are scoped by the reference. That is deliberate —
see §5.

**412 of 440 cards carry a conforming key.** But keyed does not mean
PO-keyed: 138 of them are AJ cards keyed on a job number, and only **62 cards
declare a purchase order of their own**. On the captain's own board, the PO grain
is DECLARED on 14% of cards and reachable-by-filename on 62%.

**The exception pile is worse and must not be quoted as PO coverage:**

| Case state | Cases | With a PO | `BOX` token | Real PO |
| --- | --- | --- | --- | --- |
| exception | 623 | 312 | **308** | **4** |
| accounted_non_wo | 592 | 27 | 27 | 0 |
| confirmed_live_job | 163 | 27 | 0 | 27 |

308 of the 312 exception-state PO tokens are the known-false `BOX` token read out
of a postal address. Four exception cases carry a real purchase order.

### Q5 — the AJ and repair paths, and who else is on a claim-only fallback

- **AJ confirmed.** 143 AJ-scope cards, **zero** carrying any PO token from any
  source. The `AJBR` number is the grain, as the ruling states.
- **Repair unexercised.** **Zero** of the 440 cards carry the `repair` family.
  The branch is implemented as ruled and fires only when a caller states the
  family, so nothing can reach it by accident. The ruling itself flags its repair
  reading as provisional ("i think"), so this is deliberately not sealed by code.
- **WB and KBA lose their claim-only fallback.** Production companies are
  `bw` = **Builderwest Pty Ltd** and `wb` = **Western Building** — two different
  builders whose prefixes are near-anagrams. Western Building's references carry a
  SECOND per-instruction number that a claim-only key silently discards:
  `work_order_WB69684-178656_…pdf`, `WB68926-177447`, `WB68792-177207`,
  `WB69372-178134`. That is the same job-number + instruction-number shape as MLB
  and Builderwest, so WB is **not** a proved one-deliverable builder. KBA has no
  production row using a `KBA` reference at all, so it is not proved either. Only
  AJ keeps a one-number identity.

## 4. What the new key gains and what it costs

Measured card by card over all 440:

**Gains a key (4 cards, all Builderwest)** — the composite key could not see any
of these, because the group reference and the purchase order sit on different
sources:

```
BWCWA6781   [archived]  -> BWCWA:PO-20877
SWMS-26585  [scheduled] -> BWCWA:PO-20919
SWMS-26692  [archived]  -> BWCWA:PO-20854
SWMS-26693  [archived]  -> BWCWA:PO-20864
```

`BWCWA6781` matters most: it is **the captain's own confirmed duplicate**. The
archived card declares only `BWCWA6781` and carries `PO20877` in its work-order
filename; the live card `SWMS-261103` declares `PO20877`. Under the composite key
the archived card yielded NO key and the pair was invisible to the gate. Under
the PO grain both are `BWCWA:PO-20877` and the duplicate is caught. Pinned by
probe 5 in `makesafe_instruction_key_po_grain_test.ts`.

**Loses its key (5 cards, all Western Building)** — the removed claim-only
fallback:

```
SWMS-26416  [archived]  was WB-68926
WB68792     [archived]  was WB-68792
SWMS-26491  [archived]  was WB-69372
SWMS-26559  [archived]  was WB-69684
SWMS-261051 [accepted]  was WB-69684
```

**This is a real cost, not a free win.** `SWMS-26559` and `SWMS-261051` share the
attachment `work_order_WB69684-178656_…pdf`, so the claim-only key was catching
that pair as one instruction. It no longer does. The trade is deliberate and is
the one the task ruled: a fallback that discards a builder's per-instruction
number can refuse a legitimate second deliverable, and no data proves Western
Building only ever issues one. Both cards stand aside rather than being keyed
under a rule that might be wrong. **Reading Western Building's second number as
its grain is a captain decision plus a replay revalidation, not a code tweak** —
widening `BUILDER_REF_RE` is a fate-moving change under the AGENTS.md rule.

## 5. Design decisions worth keeping

- **The scope is in the key, not around it.** `builderInstructionScope()` is the
  one place that answers "which builder". A bare PO string is only unique inside
  one builder and Q2 cannot prove otherwise on this population.
- **Reference prefix outranks the company slug.** The slug is measurably
  unreliable: `WB68792` sits on a card slugged `bw`, and `WB68926` on one slugged
  `kba`. The slug is consulted only when the reference carries no prefix at all,
  which is Builderwest's bare `PO20919` shape.
- **The slug map is closed.** An unknown slug yields no scope and therefore no
  key, never a scope invented from whatever intake happened to store.
- **`MLB-RR` / `MLB-MW` are one scope with `MLB`.** The business unit is a
  routing label inside one builder. Under the composite key it split the identity;
  it is now group provenance.
- **`PO-` / `WO-` / `JOB-` are separate namespaces**, so a repair work order can
  never collide with a purchase order sharing its digits.

## 6. Open items the captain owns — none blocking this change

1. **`MLB:PO-54129` — one purchase order, two billed deliverables.** The grain
   says one PO is one job; this PO's own text declares two, and both cards carry
   real invoiced work (INV-0820 $786.50 temp fence, INV-0880 $165.00 assessment).
   The gate would now refuse the second mint LOUDLY and a human would split or
   bind it, which is a visible outcome rather than a lost job — but the captain
   should know his grain has one adjudicated counter-example on his own board.
2. **`MLB:PO-54309` is a collision the duplicate ledger does not carry.**
   `SWMS-261121` owns PO-54309; `SWMS-26998` names it in its `external_ref` while
   having been adjudicated the PO-54007 twin of `SWMS-26736`. That is a stale
   reference on `SWMS-26998`, identical under the old and new keys, and it is
   absent from `ses-ab-certificate-v1.duplicate-accounting.txt`.
   `BWCWA:PO-20877` is the other unaccounted pair, and it is unaccounted only
   because the composite key could not see it.
3. **Western Building's second number** (§4) — adopt it as the grain, or accept
   that WB cards stand aside.
4. **Attachment-derived keys are not ownership.** 212 cards' only PO comes from an
   attached filename, and `SWMS-26998` names two POs it does not declare. The gate
   still matches on those, which keeps "nothing doubles" but means a refusal can
   point at a card that merely holds a sibling's PDF. That refusal is loud
   (HTTP 409 / a visible intake exception), never a silent drop. Narrowing
   existing-card matching to declared identity only would trade doubles for
   losses and is a separate decision.
5. **Leading-zero PO spellings** (`PO-054000` vs `PO-54000`) still key
   differently. Zero production rows exhibit it; normalising is a fate-moving
   change with its own revalidation.

## 7. Proof

- `supabase/functions/ops-api/makesafe_instruction_key_po_grain_test.ts` — ten
  hostile probes: drifted group reference collapses to one key; distinct POs
  under one group stay separate; no cross-builder collision; each of the
  captain's three worked examples asserted as a CARD COUNT
  (`MLB-26183` × 3 POs → 3, `BWCWA6781` × 2 → 2, `AJBR 67009`/`67010` → 1 each);
  the Builderwest duplicate the composite key missed; only AJ keeps a one-number
  identity; repair unreachable without its family; multi-PO input enumerates
  both keys rather than choosing one.
- `deno check --config deno.jsonc supabase/functions/ops-api/index.ts` — clean.
  Two pre-existing type errors on the PR 478 branch were fixed to get there
  (`InstructionMintConflictError.candidateKeys` readonly variance, and an
  `assertRejects` result typed `unknown`); a third, in `myjobs_all_means_all_test.ts`,
  is pre-existing on main since #446 and blocked `deno task test:ops-api` from
  type-checking at all.
- `deno task test:ops-api` — 2716 passed, 21 failed. The same 21 fail on
  unmodified `main` (`96ac2ef`) and on the unmodified PR 478 head, so this change
  adds none of them.
- `scripts/ses-identity-grain-measure.ts` — re-runs the whole §3 measurement
  read-only. `--json` for a machine-readable artifact.
