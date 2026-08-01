# SES C3 — the superseded PO ruling and suburb backfill (2026-08-01)

> Historical record only. The PO ruling recorded here was superseded later on
> 2026-08-01: `po` is now OPTIONAL in all 49 ruler rows and remains observed
> without gating. The current ruling, supersession chain, and bracketed
> measurement are authoritative in
> `docs/evidence/ses-b1-ruler-v2-2026-08-02.md`.

Two Captain rulings, both given verbatim on 2026-08-01, both applied here.

| Ruling | Words | What it changed |
|---|---|---|
| PO floor | "of course every card needs a po" | `po` is REQUIRED in all 49 ruler rows |
| Suburb backfill | "ye of course backfill suburbs" | 29 board cards now carry a real suburb |

---

## 1. What we are going to do

Two things the Captain asked for after poking the live board.

First: he looked at the evidence ruler and answered the one question that was
holding up every card on the board. The ruler had a column for the builder's
purchase order, and it did not know whether a PO was compulsory. So it refused
to grade it. He answered it: every card needs a PO. That answer is now written
into the ruler.

Second: thirty cards on the board were showing "Suburb TBC" even though the
builder's own email or PDF said the suburb plainly. He said backfill them. We
did, for the twenty-nine where the source actually names a suburb.

---

## 2. What "correct" means, in countable terms

- **49 rows.** The ruler is 7 job families × 7 board columns. The PO cell moved
  from "question" to "required" in every one of them — not most, all 49,
  including repair and restoration whose recipes are still unsealed.
- **29 suburbs written, 1 skipped.** Thirty cards had a blank suburb. Twenty-nine
  hold the suburb inside their own site address. One — SWMS-261124 — has the
  literal text "Legacy backfill - site evidence unavailable" where its address
  should be, and the Captain has already accepted that card as evidence-absent.
  We did not guess it.
- **0 cards moved.** All 407 board cards sit at exactly the display stage they
  sat at before, verified card by card.
- **0 emails, 0 texts.** No communication of any kind was sent.

---

## 3. What he will see with his own eyes

On the Ops make-safe board, twenty-nine cards that read **Suburb TBC** now read
their suburb: Dianella, Thornlie, Canning Vale, Bennett Springs, Alexander
Heights, and twenty-four more. One card still reads Suburb TBC, and that one is
honest — nobody ever told us where it was.

Nothing else on those cards changed. Same column, same status, same badges.

---

## 4. How we prove it is good

### 4.1 The PO ruling, measured against the whole live board

`scripts/ses-c2-measure-board-evidence.ts` sweeps all 407 current board cards
through the ruler in nine read-only queries. It was run immediately before the
change and again immediately after, against live production.

| Verdict | Before the ruling | After the ruling |
|---|---:|---:|
| **pass** | **0** | **17** |
| **undetermined** | 276 | 7 |
| **fail** | 112 | 364 |
| **refused** (family unknown, ruler declines) | 19 | 19 |
| Total | 407 | 407 |

Two things happened at once, and both are the ruling working as intended.

**Cards can now pass at all.** Before, `po` was a `question` cell in all 49 rows,
and the ruler degrades any card holding an unresolved question to
`undetermined`. That single unanswered question gated 100% of the board: a
perfect card could not reach `pass`. Seventeen cards now do.

**The board's real PO gap is now visible instead of hidden.** A builder PO is
recorded on only **29 of the 388 measured cards**. Under the old ruler that
absence was invisible — it read as "unresolved question". Under the ruling it is
what it actually is: 359 cards missing required evidence.

How the 364 failures decompose:

| Missing evidence | Cards |
|---|---:|
| `po` only | 252 |
| `po` + `invoice` | 99 |
| `po` + `builder_wo_doc` | 8 |
| `invoice` only | 5 |

So the ruling added exactly one new failure mode and it accounts for 359 of the
364. The 13 pre-existing work-order and invoice gaps are unchanged by it.

The 17 passes and the 29 cards holding a PO, by family:

```
pass:  physical_makesafe 10   ordinary_roof_portal 5   temporary_fencing 2
po held: physical_makesafe 19   ordinary_roof_portal 8   temporary_fencing 2
```

The 7 remaining `undetermined` cards are all short only on
`terminal_evidence` / `report_only_swms` question cells — six physical make-safe
cards at `completed`, one roof card at `archive`. Those are the Captain's next
questions, not defects.

### 4.2 The suburb backfill, proven three ways

**Dry run first.** Read-only, printed card by card:

```
card          current   new suburb         source quote
SWMS-261022   NULL      Helena Valley      , Helena Valley, WA 6056
SWMS-261064   NULL      Dianella           , Dianella WA 6059
…
SWMS-261124   NULL      (skip: no_locatable_suburb_in_source)
SWMS-26393    NULL      Beeliar            , Beeliar WA 6164
fill=29 skip=1 refuse=0
```

Full plan: `data/ses-c3-suburb-backfill-v1/dry-run.json`.

**Applied with a committed before/after ledger.** Every card records its previous
value (`null` in all 29 cases), the value written, the verbatim source token, the
suburb-and-postcode source quote, and the corroborating intake case id:
`data/ses-c3-suburb-backfill-v1/apply-ledger.json`.

**Verified by re-read.** `--mode verify` re-queried production and matched every
ledger row against the live value, and every card's board shape against the
pre-apply snapshot: `data/ses-c3-suburb-backfill-v1/verify.json`.

```
verified applied=29 skipped=1 failures=0
```

An independent board-wide count confirms it from outside the script:

```
board cards 407   site_suburb still blank 1
```

**Board stage parity.** The C2 sweep's per-card stage was diffed before and after
across all 407 cards — `job_ref | stage | computed_stage | display_overlay_stage`
— and is byte-identical. Nothing moved.

### 4.3 Where each suburb came from

| Evidence tier | Cards | Source |
|---|---:|---|
| A — job address corroborated by its own intake case row | 27 | `makesafe_intake_cases.site_address` independently holds the same address the deterministic intake extracted from the builder's email/PDF |
| B — builder work-order PDF text | 1 | SWMS-261022: `work_order_MLB-26195PO-56431_…pdf` extracted text reads `Site Address <street>, Helena Valley, WA 6056` |
| C — job's own make-safe report document | 1 | SWMS-26393: a manually created 2026-06-02 AJ job predating deterministic intake; its report file name embeds `<street>-Beeliar-WA-6164` |

`evaluateCard` refuses to write when the tier-A intake-case identity or address
no longer agrees with the fixture and job address, so a card whose sources
disagree is a loud refusal rather than a coin toss.

---

## 5. The rules this work must not break

- **Suburb only.** The card field is suburb-scoped (`ops.html` renders
  `j.site_suburb`), so a full address written there would put a client's street
  address on the board. The script extracts the suburb and writes nothing else.
  The committed fixture and ledger likewise carry only the
  suburb-and-postcode tail — no street number, no street name.
- **Never overwrite.** A card whose suburb is already populated is skipped, not
  corrected. The 28 board rows whose `site_suburb` is polluted with a trailing
  `, WA 6xxx` are a real but *separate* defect: they render something, so they
  were never in this fixture and were not touched.
- **Closed fixture, no discovery.** `FIXTURE` is the hand-checked 30-card list.
  The script cannot find its own work, so it cannot widen its blast radius.
- **Production decides, the fixture only authorises.** Every suburb is
  re-derived from live data at both dry-run and apply time. A disagreement with
  the fixture is a refusal.
- **Typed write path.** Writes go through the existing ops-api
  `update_job_field` action, which allow-lists `site_suburb`. No new endpoint, no
  raw SQL write; the Management API is used read-only throughout.
- **The forward fix is a separate ticket.** `makesafe_deterministic_intake.ts`
  still derives `site_suburb` from the email subject only, and no builder
  parsing rule defines the field, so a body-address builder will keep producing
  blank suburbs. `deriveSuburb()` here is deliberately wider than the in-repo
  `addressSuburb()` (it tolerates a comma before `WA` and a trailing
  `, Australia`); folding that widening into the runtime helper is the
  extraction fix, and it changes intake behaviour, so it is not done here.

---

## 6. Reproduction

```sh
# whole-board evidence measurement (read-only, 9 queries, ~3 s)
deno run --allow-env --allow-net --allow-read --allow-write \
  scripts/ses-c2-measure-board-evidence.ts --out=/tmp/ses-c2.json
jq -r '[.cards[]] | group_by(.verdict) | map("\(.[0].verdict): \(length)") | .[]' /tmp/ses-c2.json

# suburb backfill
deno run --allow-env --allow-net --allow-read --allow-write \
  scripts/apply-ses-c3-suburb-backfill-v1.ts --mode dry-run --plan plan.json
deno run --allow-env --allow-net --allow-read --allow-write \
  scripts/apply-ses-c3-suburb-backfill-v1.ts --mode apply \
  --plan plan.json --ledger ledger.json          # needs SW_API_KEY
deno run --allow-env --allow-net --allow-read --allow-write \
  scripts/apply-ses-c3-suburb-backfill-v1.ts --mode verify \
  --plan plan.json --ledger ledger.json --output verify.json
```

Both scripts need `SUPABASE_ACCESS_TOKEN`; only `--mode apply` needs
`SW_API_KEY`. The ruler contract version is now
`ses-evidence-requirements/c1-po-ruling-v2`, so any measurement taken after this
change is distinguishable from a `c1-draft-v1` one by its own output.

---

## 7. Then we move on

The PO floor is answered and measured. The board reads its suburbs. Eight
Captain questions remain open in the ruler — and the two that touch live cards
today are `terminal_evidence` and `report_only_swms`, which together hold the
last 7 undetermined cards. The next chunk is either those, or the 359-card PO
gap the ruling just made visible.
