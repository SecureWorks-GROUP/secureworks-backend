# PARKED — Docs Ready consumes `computed_status` — 2026-08-06

> ## STOP — READ THIS BEFORE REVIVING THIS BRANCH
>
> **Status: PARKED. Not merged, not abandoned, not broken. Superseded.**
>
> This branch (`fm/docsready-consume-computed-status-v1`) wires Docs Ready
> placement to consume `computed_status`. It is complete, tested and measured
> against production — and it must **not** land as written, for two reasons.
>
> **1. The target field is self-referencing.** An audit outside this fleet found
> that `computed_status` is **CIRCULAR**: the displayed stage is fed back into
> the computation that produces it. Wiring the Docs Ready column to consume
> `computed_status` would therefore make the column derive from a field that
> derives from the column. That is the whole premise of this branch, and it is
> the wrong target. If you are reading this because you independently reached
> "the board should just consume `computed_status`" — that is the same idea,
> and this is where it stops.
>
> The mechanism is visible in this repo and corroborates the finding.
> `buildCanonicalMakesafeRows` calls
> `computeMakesafeStatus({ ...statusInput, displayedStatus: <the displayed
> stage> })`, and the engine's first three branches short-circuit on that value
> ("displayed card is already archived / completed / cancelled"). It is also
> why `ses_stage_engine_v2.ts` exists: `SesStageV2Input` deliberately OMITS
> `displayedStatus`, which its own header describes as ending the circular
> "display determines computation" path. See the corrected-shadow-engine entry
> in `CLAUDE.md`.
>
> Note for whoever picks this up: the gate implemented here calls
> `computeMakesafeStatus` **without** `displayedStatus`, so the gate's own call
> is not circular. That does not rescue the approach — the published
> `computed_status` a consumer would read still is, and the two must not be
> allowed to mean different things.
>
> **Do not fix the circularity from this branch.** It belongs to the same
> owner.
>
> **2. Board truth has another owner.** An agent outside this fleet now owns
> board-placement, stage-derivation, substatus and Docs Ready column wiring.
> Anything in that area defers to their line so two hands are not writing the
> same code.
>
> **What is still worth keeping from this branch, whoever owns it next:**
>
> - the measured production premise below (it was verified, not assumed, and
>   the counts differ from the brief — see the section on that);
> - the finding that `docsReady()` accepts a roof card on a `READY` pack
>   without re-checking its capture, with two live cards on that branch;
> - the read-only verification script, which re-derives the pre-gate column
>   from `declared_stage` and so keeps working whenever it is run;
> - the "no verdict is not a failing verdict" partition, which any future
>   version of this gate still needs.
>
> Everything below this box was written before the stop and describes the
> branch as built. It is left unedited on purpose.

Evidence key: `report-ready-column-11-of-15-not-ready`

The board placed cards in Docs Ready from the declared ladder plus the display
overlay. Neither reads portal-capture evidence. `computed_status` already
computed that evidence per family and already named the exact captures a card
was short of; the column did not consume it. This wires the column to that
existing rule. No new completeness computation was written.

## The premise, measured before changing anything

Production, `GET ?action=makesafe_board&fields=full`, 2026-08-06 09:11 UTC:

| | count |
|---|---|
| cards the declared ladder puts in Docs Ready | **15** |
| cards the board actually shows in Docs Ready (`canonical_stage`) | **14** |
| of those, ready by the board's own `computed_status` | **4** |
| held out by this change | **10** |

The 15th declared card (SWMS-26855, Eaton) was already moved to `archive` by an
existing display overlay, which is why the served column was 14 rather than 15.

Held, by family and by what each card is short of:

| family | held | missing per card |
|---|---|---|
| `assessment_quote` | 7 | all three captures (assessment, photos, quote/scope) |
| `ordinary_roof_portal` | 3 | the one roof-report capture |

Held cards (suburb and job reference only): SWMS-26857 Dalyellup, SWMS-26853
Myalup, SWMS-26852 Glen Iris, SWMS-26759 Myalup, SWMS-26748 Dalyellup,
SWMS-26740 Preston Beach, SWMS-26736 Usher, SWMS-26735 Glen Iris, SWMS-26732
Glen Iris, SWMS-26728 Dalyellup. Each publishes its own sentences, e.g.
SWMS-26857:

- The assessment link still needs a headless capture proving the Prime form is
  submitted and locked.
- The work order email contains no photos link - ask the builder to send it.
- The work order email contains no quote/scope link - ask the builder to send it.

The brief predicted 11 of 15 (8 assessment + 3 roof). The measured figure is 10
of 14 served (7 assessment + 3 roof) — one assessment card left the column
between the brief and this run. **The board is live and these counts move**;
re-measure rather than quoting them.

## Is `computed_status` authoritative for every family reaching Docs Ready?

No, and the gate is scoped to where it is.

- **`roof_report` / `assessment_report_quote`** — yes. Report-in evidence IS the
  set of Prime portal captures, and every input is on the card-shape base row.
  These are the two families the gate covers.
- **`physical_makesafe`** — the engine covers it, but on a submitted service
  report plus the completion-photo floor, and the board's card shape loads
  neither (photo counts are a full-mode-only read). Running the engine on such
  a card here would demote it for missing INPUTS, not missing evidence. Those
  cards keep today's placement and record `applies: false` — an explicit
  no-opinion, not a silent pass. Two live cards are in this class
  (SWMS-261131, SWMS-261034); both stay.
- **No family reaching Docs Ready lacks a computed opinion entirely.** Every
  card classifies into one of the three kinds, so there is no "unknown family"
  case to decide.

Three shapes deliberately produce **no verdict**, and a no-verdict card is
never treated as not-ready:

1. `applies: false` — family out of scope, as above.
2. `satisfied: null`, `portal_capture_evidence_unreadable` — the capture ledger
   read failed. `makesafe_portal_capture_revisions` is read behind a try/catch
   that fails closed to an empty list, so an unreadable ledger and a card with
   genuinely zero captures are byte-identical at this layer; only the loader
   knows which happened, and it now says so. Demoting on a transient fault
   would empty the column and look like a rule.
3. `satisfied: null`, `computed_status_ahead_of_docs_ready` — the engine puts
   the card at `completed` / `archive` / `cancelled`. Further along than ready
   is not short of ready, and dragging such a card backwards answers a
   different question.

## The one place the gate deliberately does NOT enforce

`docsReady()` accepts a roof card whose draft-pack record is `READY` without
re-checking its portal capture. Two live cards sit on exactly that branch —
White Gum Valley SWMS-261114 and Mindarie SWMS-261081, both
`computed_status: report_ready` with `has_current_portal_capture: false`.

Reading `reportInEvidence` directly at the placement layer would evict them,
under a rule **stricter than the system computes**, invented here. The brief
says to consume `computed_status`, not to out-strict it, and the roof exemption
is another worker's branch. So the gate consumes the engine's verdict and both
cards stay in Docs Ready. That is why the served column lands at 4 rather than
2. Pinned by `makesafe_docs_ready_capture_gate_test.ts` ("the gate defers to
M1's roof pack shortcut instead of out-stricting it") so a later change cannot
quietly tighten it.

## Both halves shipped

1. **Placement + label.** `canonical_stage` is declared ladder → overlay →
   gate. A held card is placed at the engine's own `computed_status`, and
   `canonical_stage_label` follows the placement — it never keeps "Report
   Ready" after leaving the column.
2. **The card says what it is missing.** Every entry of
   `computed_status_missing` is republished as a `portal_capture_not_proven`
   blocker in `blockers.real[]`, with its `fact`, a `recovery_action`, and the
   `held_from_stage` → `held_to_stage` move. In card mode too: a card that
   vanishes must explain itself on the surface it vanished from. The full
   verdict also rides on `docs_ready_capture_gate`.

The reviewer-display half of this (rendering those blockers) is a
`secureworks-ux` change and is dispatched separately.

## Safety properties, each pinned by a test

- **One reading, not two.** The gate and the published `computed_status` are
  built from the same `statusEvidence` object and the same engine, so they
  cannot disagree about a card.
- **Card and full mode place identically.** The loader reads the capture ledger
  in card mode for the gate's candidate ids only
  (`docsReadyCaptureGateJobIdsForBoard`) — ~13 of 155 active rows on the day,
  one bounded chunked read, and none at all when the column is empty. The board
  TTFB rule is respected: no new board-wide fan-out.
- **The gate can only subtract.** It never places a card in `report_ready`, so
  the F7 promise that the observer cannot promote work is intact. The F7 test
  `no board stage can move because a capture exists` was **narrowed, not
  deleted**: its structural half (the legacy ladder takes no capture input) is
  unchanged, and the behavioural half now asserts that a capture never reaches
  Docs Ready and moves no other stage. A capture CAN now move a held card
  within the stages below Docs Ready — that is the evidence becoming visible.
- **No migration, no write.** Read-model only. No production write of any kind
  was made building this.

## Versions

`MAKESAFE_BOARD_CONTRACT_VERSION` unchanged (the payload addition is additive)
and `MAKESAFE_STAGE_LADDER_VERSION` unchanged (the declared ladder is untouched;
the gate runs after it, exactly as the overlay resolver does). The gate carries
its own `DOCS_READY_CAPTURE_GATE_VERSION = docs-ready-capture-gate/v1`,
published on every row, so a measurement can name the rule that placed a card.

## Re-run it

```
SW_SUPABASE_URL=... SW_API_KEY=... \
  deno run --allow-env --allow-net scripts/ses-docs-ready-capture-gate-verify.ts
```

Read-only, one authenticated GET, suburb and job reference only. It recovers
the pre-gate column from `declared_stage`, so it reports the same before/after
whether it runs before this ships or a month after. It exits non-zero on an
unreadable capture ledger rather than reporting an incomplete count, and
refuses to report any count at all on a non-200 (a non-200 from
`makesafe_board` is a board-truth outage, not an empty board).

Caveat that outlives this change: `ops.html` falls back to `makesafe_pipeline`
after two failed `makesafe_board` attempts, and that path applies neither this
gate nor any captain display transition. A board that looks un-gated is that
fallback, not a reverted deploy.
