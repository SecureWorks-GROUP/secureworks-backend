# Materials rate card

**Canonical materials price source for this skill.** `pricing-and-invoice-rules.md` points here for
materials in the same way it points at `scripts/builder_pricing_policy.py` for builder labour.

This card lives inside the skill's own files on purpose. `path-manual.md` and `path-board.md` are
loaded as alternatives and never as co-authority, so a materials price kept anywhere else gets read
by one path and not the other. Both paths load `SKILL.md`, `SKILL.md` indexes this card, and this is
the only file in either path's load-set that carries a materials rate. **One source, no drift.**

## What this card is, and is not

- It **prices**; it does **not decide**. It never turns an unevidenced line into a billable one.
- If quantity, material use or scope is not evidenced, the guards still hold rather than invent.
  A price on this card is not evidence that the material was used.
- **Price never proves scope.** Nothing here relaxes any existing evidence requirement, guard or gate.
- Nothing on this card auto-applies. It is a priced reference, not a rule that bills.
- Every price carries its provenance and a date. **A price with no provenance does not go in the
  card** — it goes in *Unpriced in v1* below, or it holds.

## Status at a glance — every rate is ruled and in force

| Section | State |
|---|---|
| Star pickets | **SETTLED** — sealed precedent, unchanged by this card |
| Cable ties and small consumables | **SETTLED** — sealed two-step tier, unchanged by this card |
| Flashing tape | **SETTLED** — Captain ruling 2026-08-07 (D2) |
| Sikaflex / silicone | **SETTLED** — Captain ruling 2026-08-07 (D2) |
| Combined tape + Sikaflex line | **SETTLED** — Captain ruling 2026-08-07 (D2) |
| Make-safe tarpaulin (standard HD 160gsm) | **SETTLED** — Captain ruling 2026-08-07 (D3) |
| Make-safe tarpaulin (heavy / Xtreme grade) | **HOLD** — deliberately not banded, see its row |
| Make-safe tarpaulin above 55.5 m², standard grade | **HOLD** — no band, see its row |
| Polyweave / builders film | **HOLD** — evidence recorded, no rate ruled |
| Disposal / tip and glass disposal | **SETTLED as evidenced pass-through**, no fixed rate |
| Non-round line-amount styling | **SETTLED** — Captain ruling 2026-08-07, applied by `scripts/materials_line_composer.py` |

A `HOLD` row is not a price. A line needing one still holds and asks the Captain, exactly as it did
before this card existed. Do not bill a `HOLD` and do not invent a figure to fill one.

## The evidence beside the rulings

The Captain's figures are in force. The evidence they were ruled against is recorded **beside**
them, not deleted because it was superseded. **A ruling that overrides evidence sits next to the
evidence it overrode** — otherwise the next reader sees a number with no basis, which is the exact
defect this card exists to remove.

### What the record showed before the ruling: we have been billing materials below retail cost

| Material | Bunnings **retail** ex (2026-08-06) | What we actually billed | Result |
|---|---|---|---|
| Sikaflex 11FC 300ml cartridge | **$24.55** | **$20** (INV-0980), $25 (INV-0984) | **billed below retail cost** |
| Flashing tape, 100mm x 10m roll | **$45.00** | **$25** (INV-0967, INV-0981) | **just over half the roll's retail cost** |

The `$45` tape-and-silicone pair in our own accepted invoice history (INV-1004, INV-1003, INV-1001,
INV-1005, INV-1040, INV-1050) sits **below the $69.55 ex combined retail cost of the two materials**.
The `$20` Sikaflex line (INV-0980) sits below the retail cost of the cartridge outright; the `$25`
Sikaflex lines clear it by 45 cents; the `$25` tape lines recover just over half a roll.

### The flashing tape flag — live, and deliberately not resolved by the ruling

**The Captain's ruling is `$25 ex` per roll on a TRADE-price basis.** The only acquisition price this
card has on file for a 100mm x 10m flashing tape roll is **`$45.00 ex` retail** (Bunnings, checked
2026-08-06).

**Trade price and retail price are not the same thing, so both figures may be right.** But we hold
no invoice, supplier price list or receipt evidencing a `$25` trade acquisition for this roll. Until
one is on file:

> **Every flashing tape line billed at `$25 ex` is potentially `$20` below what we pay to acquire the
> material.** If tape is in fact bought at or near retail, the ruling bills it at roughly 56% of cost.

**What closes this flag:** a supplier invoice, trade account price list or receipt showing the
acquisition price actually paid for a 100mm x 10m flashing tape roll, filed against this row with its
date. If it confirms `$25` or lower, the flag is struck and the ruling stands unqualified. If it
confirms a higher figure, the gap is real and the Captain is deciding a below-cost line knowingly.
This is recorded so the fact is visible the next time he reads the card, not living in a status
message.

Sikaflex carries no such flag: `$25` against `$24.55` retail clears cost by 45 cents even before any
trade discount.

### Superseded, written out rather than quietly overwritten

| Figure | Was proposed | **Ruled 2026-08-07** | Why the proposal was made |
|---|---|---|---|
| Flashing tape floor | `$50 ex` | **`$25 ex` per roll** | `$50` was proposed above the Captain's earlier `$30` because `$30` is below the `$45.00 ex` retail roll cost. The `$25` ruling rests on trade price instead, and carries the flag above. |
| Sikaflex floor | `$30 ex` | **`$25 ex` per cartridge** | `$30` was the Captain's own earlier figure and clears retail cost by 22%. |
| Combined tape + Sikaflex line | `$80 ex` | **`$50 ex`** | The proposal was the sum of the `$50`/`$30` floors. The ruled line is the sum of the two `$25` units. |
| Tarpaulin smallest band | `$45 ex` | **retired — `$80 ex` hard minimum** | The `$45` band is invalid under the ruling. No tarp line bills below `$80 ex`. |

**No existing invoice is repriced by any of this.** Re-pricing shipped work is a separate Captain
decision and is out of scope here. This card is a price list, not a repricing.

**One more artefact of having no rate card**, recorded because it is the defect this card exists to
remove: INV-0845 carries `[PRICE ASSUMED - no rate on file for AJ B&R cable-tie sale, used flat
$25 ...]` written into billed money by a prior run.

## How to read a rate row

- **Price ex** is ex GST. Multiply by 1.1 for the inc figure.
- **Status** is one of `SETTLED` (ruled and in force), `PROPOSED` (put to the Captain, not in force)
  or `HOLD` (no rate; the line still asks the Captain).
- **Provenance** names the AUTHORISED invoice or the Bunnings stock check, or the sealed ruling, and
  carries a date. Where the accepted-invoice record does not carry its own line date, the date is the
  date the AUTHORISED record was read.
- Tiered materials declare a **floor** and at least one **tier boundary**. A single flat number per
  material is the shape the Captain ruled out: *"both bump up when heavy quantities are used"*.
- Quantity above the floor must be **evidenced**. An unevidenced quantity does not climb a tier; it
  holds.

---

## Star pickets

**Key:** `star_picket` · **Status:** SETTLED · **Tiered:** no (per-unit sale price)

Unchanged by this card. Every valid star-picket sale line reads exactly `$13.50 ex` per unit. This is
the existing sealed precedent, and the deterministic guard enforces it from
`SALE_ITEM_PRICES_EX["star_picket"]` in `scripts/builder_pricing_policy.py`.

| Item | Unit | Price ex | Status | Provenance |
|---|---|---|---|---|
| Star pickets supplied | each | $13.50 | SETTLED | INV-1102, INV-0942, INV-0899, INV-0922, INV-0925, INV-0850, INV-0849, INV-0852, INV-1088 AUTHORISED; read 2026-08-06 |

**The scope condition is unchanged and is not relaxed by this card.** A star-picket sale line is
billable ordinary material **only** where a scope/notes/line narrative explicitly establishes that
the pickets prop/support/brace/stabilise/secure an **existing** fence, and no temporary-fence signal
appears anywhere. A bare picket line HOLDS. Price never proves scope, and this card must not become
the thing that launders a kit. See `pricing-and-invoice-rules.md` for the full carve-out.

**Two outliers, recorded so they are not mistaken for the rate:** INV-0845 at `$18.00` each and
INV-0848 at `$18.50` each (read 2026-08-06). Neither moves the sealed figure.

**One honest flag, recorded rather than left to be "discovered" later:** Bunnings single-unit retail
for an equivalent 180cm galvanised heavy-duty picket is `$18.09 ex` (checked 2026-08-06), so `$13.50`
is below single-unit retail. That is normal for a bulk-bought item and is **not** a reason to move a
sealed precedent.

## Cable ties and small consumables

**Key:** `cable_ties_consumables` · **Status:** SETTLED · **Tiered:** yes (sealed two-step)

Unchanged by this card. The money gate hard-refuses any consumables rate other than these two
(`pricing-and-invoice-rules.md`, MLB hire rate card line 5; `MLB_CABLE_TIES_OK_EX` in
`scripts/makesafe_invoice_guards.py`). **This is the precedent for the tier shape the Captain is
asking for on tape and Sikaflex** — a quantity tier on materials is not a new mechanism in this
system, and its boundary is job size.

| Tier | Boundary | Price ex | Status | Provenance |
|---|---|---|---|---|
| 1 (floor) | standard job | $25 | SETTLED | Queens Park SWMS-26845 AUTHORISED, "Cable ties and consumables"; read 2026-08-06 |
| 2 | large / awkward / multi-area job, stated on the line | $35 | SETTLED | INV-0899 "multi-area strata job, larger allowance", INV-0921 "large/awkward job", INV-0852 "large job" AUTHORISED; read 2026-08-06 |

## Flashing tape

**Key:** `flashing_tape` · **Status:** SETTLED (D2) · **Tiered:** yes

**Ruled basis:** `$25 ex` per 100mm x 10m roll at **trade** price. **Part use still bills the whole
unit** — a job that consumes 0.4 m of a roll bills one roll, because the roll is opened and
committed to that job.

**Retail cost basis, recorded beside the ruling:** CAgroup 100mm x 10m Byute Flash weatherproof
flashing tape, `$49.50` inc = **`$45.00 ex`** per roll (bunnings.com.au, checked 2026-08-06; the
product page figure is recorded, not the `$45.95` search summary). **See *The flashing tape flag*
above — the ruled `$25` is `$20` below the only acquisition price on file, and that gap is open until
a trade-price source is filed.**

| Tier | Boundary | Price ex | Status | Provenance |
|---|---|---|---|---|
| 1 (floor) | one roll, part or whole | $25 | SETTLED | Captain ruling 2026-08-07, trade-price basis; Bunnings retail $45.00 ex checked 2026-08-06 recorded beside it |
| 2 | each additional roll, quantity evidenced | $25 per roll | SETTLED | Captain ruling 2026-08-07, same per-roll trade basis; Bunnings retail $45.00 ex checked 2026-08-06 |

Accepted-record distribution for tape / silicone / tape+silicone material lines, for context on where
practice already sits: `$20` x1, `$25` x6, `$35` x6, `$45` x6, `$60` x3 (AUTHORISED ACCREC line
items, 2026-06 to 2026-08; read 2026-08-06). The record has been trending up on its own — June at
`$25-35`, July at `$45`, August at `$60`.

## Sikaflex / silicone

**Key:** `sikaflex_silicone` · **Status:** SETTLED (D2) · **Tiered:** yes

**Ruled basis:** `$25 ex` per 300ml cartridge at trade price. **Part use still bills the whole
unit** — an opened cartridge is committed to that job.

**Retail cost basis, recorded beside the ruling:** Sika 300ml White Sikaflex 11FC Purform, `$27.00`
inc = **`$24.55 ex`** per cartridge (bunnings.com.au, checked 2026-08-06). Unlike flashing tape this
carries **no open flag**: the ruled `$25` clears even the retail cartridge cost, by 45 cents, before
any trade discount.

| Tier | Boundary | Price ex | Status | Provenance |
|---|---|---|---|---|
| 1 (floor) | one cartridge, part or whole | $25 | SETTLED | Captain ruling 2026-08-07, trade-price basis; Bunnings retail $24.55 ex checked 2026-08-06, cleared by 45c |
| 2 | each additional cartridge, quantity evidenced | $25 each | SETTLED | Captain ruling 2026-08-07, same per-cartridge basis; Bunnings retail $24.55 ex checked 2026-08-06 |

## Combined flashing tape + Sikaflex line

**Key:** `tape_and_sikaflex_combined` · **Status:** SETTLED (D2) · **Tiered:** yes (sum of units)

D2 is ruled: the floors are **per material**, and a combined line is the **sum of the units it
carries**. There is no separate combined-line rate below that sum.

| Tier | Boundary | Price ex | Status | Provenance |
|---|---|---|---|---|
| 1 (floor) | one roll + one cartridge | $50 | SETTLED | Derived: sum of the two ruled $25 units, Captain ruling 2026-08-07 |
| 2 | additional rolls / cartridges, quantity evidenced | $25 per roll + $25 per cartridge | SETTLED | Derived: the same two ruled per-unit bases, Captain ruling 2026-08-07 |

**Worked example arithmetic:** `$25 + $25 = $50` — one roll of flashing tape plus one Sikaflex
cartridge on the same job, whether billed as two lines or one combined line.

**The historical `$45` pair is superseded** and is recorded above as accepted history, not as a tier.
Two findings from the accepted record (read 2026-08-06) support pricing per material rather than as a
pair, and both survive the ruling:

1. Two materials costing `$69.55 ex` at retail together billed at `$45` was a loss on every such
   line.
2. **`$45` has also been billed for silicone alone** (INV-1005, INV-1040), not only for the pair. So
   `$45` was never reliably "the price of tape and silicone together"; it was a round number applied
   to one material and to two.

**The retail-cost flag carries into the combined line too:** `$50` for a roll plus a cartridge sits
below the `$69.55 ex` combined **retail** cost. On the ruled **trade** basis it is the sum of two
whole units. See *The flashing tape flag* above — the tape half of that gap is the open one.

## Make-safe tarpaulin

**Key:** `tarpaulin` · **Status:** SETTLED (D3) · **Tiered:** yes (size bands)

**The ruling:** a **hard `$80 ex` minimum** on every tarp line, an average job around **`$145 ex`**,
larger above. No tarp line bills below `$80 ex` whatever the size — the retired `$45` band is invalid.

**Why this is banded and not a single price.** The Captain refused to guess this one, and the record
proves he was right to:

- **A tarp has never been invoiced standalone in the entire issued-invoice history — not once**
  (full ACCREC line-item mine, read 2026-08-06). Every tarp line bundles screws, tape, silicone,
  staples, sand bags or timber. **There is no accepted standalone precedent to anchor to**, so a flat
  price would be invented rather than derived.
- The cost of the tarp sizes we actually use spans **`$35.54` to `$223.92 ex`** — a 6x spread. One
  flat number cannot be defensible at both ends.
- The two accepted lines that state a size both billed `$110` total: INV-1084 (2026-07-31) for a
  **36 m²** tarpaulin *plus* roof screws *plus* flashing tape *plus* silicone, and INV-0695
  (2026-06-15) for a **6.5 x 5.5 m** ceiling tarp plus timber, bags, bugles and staples. The HD
  160gsm sizes on the cost curve below are 10.8, 19.8, 29.9 and 55.5 m², so covering 36 m² means
  buying the **55.5 m² tarp at `$151.57 ex`**. The `$110` line did not recover even the tarp, let
  alone the screws, tape and silicone bundled with it.

**Cost curve** — Polytuf HD 160gsm, bunnings.com.au, checked 2026-08-06: `$3.29/m² ex` at 10.8 m²
falling to `$2.73/m² ex` at 55.5 m². **The band is selected from the area to be covered, and each
band ceiling is the actual Bunnings product area**, not a round number, because the band price is set
against the cost of the tarp you would actually buy to cover that area. A 36 m² job exceeds the Large
band's 29.9 m² and prices at Extra large.

| Band | Up to | Cost ex | Price ex | Status | Provenance |
|---|---|---|---|---|---|
| Small (hard minimum) | 10.8 m² (3.0 x 3.6) | $35.54 | $80 | SETTLED | Captain ruling 2026-08-07, hard $80 minimum on every tarp line; Bunnings Polytuf HD 160gsm checked 2026-08-06; 2.25x retail cost |
| Medium | 19.8 m² (3.6 x 5.5) | $62.54 | $110 | SETTLED | Captain ruling 2026-08-07; Bunnings Polytuf HD 160gsm checked 2026-08-06; 1.76x |
| Large (average job) | 29.9 m² (4.9 x 6.1) | $85.75 | $145 | SETTLED | Captain ruling 2026-08-07, "average job around $145"; Bunnings Polytuf HD 160gsm checked 2026-08-06; 1.69x |
| Extra large | 55.5 m² (6.1 x 9.1) | $151.57 | $190 | SETTLED | Captain ruling 2026-08-07, "larger above"; Bunnings Polytuf HD 160gsm checked 2026-08-06; 1.25x |
| Heavy / Xtreme grade | 37 m² (6.1 x 6.1) | $223.92 | hold | HOLD | Bunnings Polytuf Xtreme checked 2026-08-06; $6.02/m² ex, ~2x the HD basis |
| Above 55.5 m², standard grade | no band | — | hold | HOLD | Derived: no HD 160gsm size above 55.5 m² on the Bunnings cost curve checked 2026-08-06 |

**One tension recorded beside the ruling, not smoothed over.** The `$145` band is anchored to the
"average job", but the only two size-stated tarp lines in the whole accepted record are **both ~36
m²** (INV-1084 and INV-0695), which lands in **Extra large at `$190`**, one band above the average
anchor. On the evidence we hold, the typical sized tarp job is bigger than the `$145` band. That does
not override the ruling — it is recorded so the next reader can see the anchor and the record are not
the same thing.

**Above `55.5 m²` in standard HD 160gsm there is no band and the line HOLDS**, with the area
evidenced, exactly as the heavy grade holds. It must not fall into Extra large: no single tarp on the
cost curve covers that area, so the Extra-large cost basis would not hold and the line would bill
below cost.

**The heavy-grade row deliberately carries no price.** Xtreme grade costs about double per m², so a
37 m² Xtreme tarp priced in the Large or Extra-large band would bill **below cost**. Rather than
invent a fifth number, it holds and asks the Captain, with the grade evidenced. The candidate figure
on record from the research is `$280 ex` (1.25x `$223.92`); it is **not** ruled and is not in force.

**Quantified effect of the ruled bands:** INV-1084's tarpaulin is **36 m²**, which exceeds the Large
band's *up to 29.9 m²*, so it falls in **Extra large at `$190 ex`**, plus one roll of flashing tape
and one Sikaflex cartridge at the ruled `$25` each.

**Worked example arithmetic:** `$190 + $25 + $25 = $240` — against the `$110` actually invoiced on
INV-1084, an under-recovery of `$130` on a tarp-plus-seal job.

Bands price the tarp **only**. Screws, tape, silicone, staples, bags and timber on the same job are
their own evidenced lines.

---

## Line-amount styling: materials amounts end in a non-round number

**Captain ruling 2026-08-07.** A composed materials line amount must **not** be a round number. The
rule is **encoded, not applied by hand** — hand-applied styling is forgotten the first time somebody
adds a material, which is the failure mode the ruling exists to prevent.

**Canonical implementation: `scripts/materials_line_composer.py`.** Do not re-implement it inline and
do not eyeball a number into shape.

| Question | Answer |
|---|---|
| What counts as round? | A whole-dollar amount that is a multiple of 5. `$80`, `$145`, `$25`, `$50` are round; `$81`, `$146`, `$26` are not. |
| Which direction does it move? | **Always up**, to the next qualifying amount. Never down, so a ruled floor or the hard `$80` tarp minimum can never be breached by styling. |
| How far can it move? | Always under `$2`, and on a whole-dollar ruled figure such as `$80` or `$145` exactly `$1`. |
| What is it applied to? | The **composed line amount**, after the card's rates and quantities are applied. It is presentation, not a rate: the rate rows above stay exactly as ruled. |
| What is it never applied to? | **Guard-sealed rates** — star pickets `$13.50` per unit, cable ties / consumables `$25` / `$35`, and every MLB hire-card line. The money gate hard-refuses those at exact values, so styling them would refuse the invoice. The composer knows this and returns them untouched. |
| What happens on an unknown line key? | The composer **refuses**. It composes only the `**Key:**` values declared on this card plus its registered composed-line keys; anything else raises. A near miss on a sealed material (`star_pickets` for `star_picket`) would otherwise style a guard-pinned rate and the money gate would refuse the invoice, so it fails closed rather than guessing. |

**Worked example arithmetic:** `$190 + $25 + $25 = $240` composes to a styled line amount of `$241`.

## Unpriced in v1 — deliberately, with the reason

The spec's rule is explicit: an invented price is worse than a blocker, because the blocker asks the
Captain and the invention does not. These hold.

| Item | Why it is unpriced | What is on record |
|---|---|---|
| **Polyweave / builders film** | Different material on a different price basis (~`$0.58/m² ex` cost, about a fifth of woven tarp). It must not share a rate line with a tarp band, and no floor has been ruled for it. | CAgroup 4m x 50m x 200µm black PolyPRO, ~`$115.04 ex` for 200 m², checked 2026-08-06. Accepted record spans `$25` (INV-0696) to `$95` (INV-0971), read 2026-08-06. |
| **Bundled "materials" / "materials and fixings" lines** | These are job-specific baskets, not a material with a rate. `$45`, `$235`, `$270` in the accepted record are three different baskets. | Mosman Park SWMS-26940 `$45`, Mosman Park SWMS-261147 `$235`, Herne Hill SWMS-26955 `$270` AUTHORISED; read 2026-08-06. Itemise from this card instead of reusing a basket figure. |
| **Heavy / Xtreme grade tarpaulin** | See the tarpaulin table. | As above. |

## Priced elsewhere — pointers, not restated rates

Restating these here would create exactly the drift this card exists to prevent.

| Item | Canonical source |
|---|---|
| Builder labour rates, minimums, after-hours and overrides | `pricing-and-invoice-rules.md` and `scripts/builder_pricing_policy.py` |
| MLB temporary-fence hire card (panel hire, retrieval/collection allowance) | `pricing-and-invoice-rules.md` → *MLB temporary fencing hire rate card* |
| Roof report, assessment report / quote | `pricing-and-invoice-rules.md` → *Labour rates* |
| **Travel on a far job** | Not a material. Ruled 2026-08-07 as **incorporated into labour**, charged as evidenced hours on the labour line at the builder's own rate. `pricing-and-invoice-rules.md` → *Travel bands incorporated into labour*. Three of the four bands carry no hour figure yet and hold. |
| **Disposal / tip fee and glass disposal** | Not a rate. Bill the **evidenced actual charge** for the load. The accepted record spans `$35` (Herne Hill SWMS-26955), `$70` glass (Mosman Park SWMS-261147) and `$250` (Noranda SWMS-26938) — read 2026-08-06 — which is load-dependent, not a price to copy. |

## What this card does not change

- **The AJS/AJBR temporary-fencing material exception is untouched.** AJS/AJBR supplies its own
  temp-fence materials, so no panel, block/base, tie/clip, hire or retrieval-material line, and no
  picket line for temporary-fence scope or kits. On an explicit temporary-fence scope **every** ruled
  material line is still refused, with this card present.
- **The star-picket carve-out keeps its full condition** (existing fence, explicit narrative, no
  temp-fence signal anywhere).
- **No labour rate moves in this card.** It is materials only. The sealed `$80` AJS / `$85` MLB
  schedule, the solo temp-fence 4-hour floor and the MLB `$180` retrieval line shape are all
  untouched. The Captain's 2026-08-07 **travel ruling is labour**, by his own words ("travel is
  incorporated into labour"), so it lives in `pricing-and-invoice-rules.md` →
  *Travel bands incorporated into labour*, not here.
- **No live invoice is reminted or repriced** as part of this card.

## Change control

- A price moves by a **Captain ruling**, recorded here with its date, with the superseded figure
  written out rather than quietly overwritten, and with the evidence it overrode kept beside it.
- Every new price arrives with its provenance and date, or it does not go in the card.
- Machine-checked by `scripts/test_materials_rate_card.py`: every rate row carries a status,
  provenance and date; tape, Sikaflex and the combined line each declare a floor and at least one
  tier boundary; the settled star-picket and consumables figures match the guard constants; every
  **worked example arithmetic** line sums correctly and uses only current in-force rates, so no
  example can quietly keep computing off a superseded figure; and this card is the only
  materials-rate source in either path's load-set.

### Ruling log

| Date | Ruling | Effect |
|---|---|---|
| 2026-08-06 | Card created. Star pickets and consumables carried across as SETTLED from existing sealed rules. | No price changed. |
| 2026-08-07 | **D2 ruled** — flashing tape and Sikaflex are **`$25 ex` each**, trade-price basis, part use bills the whole unit. Supersedes the proposed `$50` tape and `$30` Sikaflex floors. | Tape, Sikaflex and the combined line move to SETTLED at `$25` / `$25` / `$50`. The Bunnings `$45.00 ex` retail tape finding is **kept as evidence beside the ruling** with its open flag. |
| 2026-08-07 | **D3 ruled** — tarp bands with a **hard `$80 ex` minimum**, average job around `$145 ex`, larger above. The `$45` band is retired as invalid. | Bands move to SETTLED at `$80` / `$110` / `$145` / `$190`. Heavy grade and above-55.5 m² stay on HOLD. |
| 2026-08-07 | **Line-amount styling ruled** — composed materials amounts must end in a non-round number, encoded in the composer rather than applied by hand. | New `scripts/materials_line_composer.py` plus its tests. Guard-sealed rates are exempt by construction. |
| 2026-08-07 | **Travel ruled** — incorporated into labour for far jobs, with bands. | Recorded in `pricing-and-invoice-rules.md` → *Travel bands incorporated into labour*. Labour, not materials, so it is not a row on this card. |
