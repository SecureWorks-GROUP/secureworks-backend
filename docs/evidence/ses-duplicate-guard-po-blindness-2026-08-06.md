# The duplicate-invoice guard was PO-blind — Koondoola double-bill, 2026-08-06

Koondoola `SWMS-261025` minted DRAFT `INV-1140` at $255 ex ($280.50 inc) on 5 August, for work that
AUTHORISED `INV-1080` at $390 ex ($429.00 inc), dated 30 July, already covered. Three independent
guards each saw the pair and each let it through.

This is the same root cause as F07 producing the opposite failure. F07 is a false REFUSAL (several
cards on one claim all mint the same claim-only reference and collide); Koondoola is a false
PERMISSION. Both come from one defect: **the minted reference does not carry the purchase order, and
the guard treated a missing purchase order as a distinguishing one.**

Every number below was read from the live mirror on 2026-08-06 with the Supabase Management API at
`read_only: true`. No production write was made.

**LIMITATION (see §4b): this fix closes the `ops-api` backend duplicate-guard route only. The wiki
skill-script twin carries the identical pre-fix predicate and remains a live, unclosed mint guard —
do not read a green merge as full coverage.**

---

## 1. What the live data actually says

The finding as relayed had the pair the wrong way round, which matters because it changes which
tier should have caught it.

| | reference | status | dated | total inc | `job_id` |
|---|---|---|---|---|---|
| `INV-1080` | `MLB-27093PO-56481` | AUTHORISED | 2026-07-30 | $429.00 | **NULL** |
| `INV-1081` | `MLB-27093PO-56479` | AUTHORISED | 2026-07-30 | $3,861.00 | **NULL** |
| `INV-1140` | `MLB-27093` | DRAFT | 2026-08-05 | $280.50 | SWMS-261025 |

The card mints the **claim-only** `MLB-27093`; the already-authorised invoice carries the PO. And the
card's own intake case knew both halves all along:

```
makesafe_intake_cases (SWMS-261025)
  builder_wo_canonical   MLB-27093
  builder_po_canonical   PO-56481      <-- the PO on INV-1080
  external_ref_canonical MLB-27093
```

`ses_assembler_input_adapter.ts` builds `source.builder_reference` by preferring
`builder_wo_canonical` and **dropping** `builder_po_canonical`. So the card threw away the one fact
that would have made it collide with its own invoice.

Note also that claim `MLB-27093` carries **two** authorised invoices under two different purchase
orders. That is the whole reason a claim-only reference cannot be resolved: it could denote either.

## 2. The three failures, and what each fix is

### Failure 1 — the guard compared reference STRINGS

`sameWorkRef` (`makesafe_send_pack.ts`) answered:

```ts
if (o.base && c.base && o.base === c.base && o.po !== c.po) return false;  // "different work"
```

With `o.po = null` and `c.po = "56481"`, `null !== "56481"` reads as *different purchase order,
therefore different work*, and the candidate is filtered out of every reference tier. The pair was
visible to the substring tier — `"mlb27093po56481".includes("mlb27093")` is true — and this
predicate discarded it.

**Fix A — the escape hatch now requires BOTH sides to name a PO.** `workRefRelation` names the four
pair shapes (`unrelated`, `same_work`, `distinct_po`, `po_indeterminate`) and `sameWorkRef` clears
only `distinct_po`. This is the part that repairs cards that already exist.

**Fix B — a PO-insensitive claim-base tier (`reference_po_base`).** The substring tier is
DIRECTIONAL: it only asks whether the candidate contains our reference. Once every minted reference
carries its PO, our side is the longer string and a legacy claim-only invoice falls outside it
entirely. Base equality is exact, never substring, and is symmetric.

**Fix C — carry the PO into every minted reference.** `composeInvoiceReferenceWithPo`
(`ses_invoice_reference_grain.ts`) joins the card's own `builder_po_canonical` onto the reference in
the shape the builder itself uses: `MLB-27093` + `PO-56481` -> `MLB-27093PO-56481`. It never
overwrites a PO the reference already names and never invents one — `external_ref_canonical` is
frequently the claim, and reading its digit run as a purchase order would compose the fabricated
`MLB-27093PO-27093`.

Composition happens at the **invoice obligation** layer, deliberately not earlier:

- `SesAssemblerInputV1.source.builder_reference` is inside the docket INPUT hash, from which
  `docketRevisionId` derives. Changing it re-keys every docket revision on the board and drops every
  Docs Ready signoff, for no pricing effect.
- `local_invoice_proposal` is inside the docket OUTPUT hash, so recomposing there would make stored
  artifacts disagree with a recomputed docket.

The obligation content hash does move, minting a fresh obligation revision id on the next prepare.
That is ordinary churn — an obligation already `create_executed` or `authorised` is refused from
re-prepare before this code is reached.

One consequence, accepted and recorded: the Xero **Reference** now carries claim+PO while the
invoice **line descriptions**, built at the docket layer from `builder_reference`, still carry the
claim alone. Aligning them would require moving the composition into the docket output hash.

### Failure 2 — `xero_invoices.job_id` is NULL on both authorised invoices

**Where the NULLs come from.** Not one bug; three layers:

1. `xero-sync` only *preserves* an existing link (`if (existingJobId) record.job_id = existingJobId`)
   — it never establishes one. An invoice minted outside the SES path arrives unlinked.
2. `matchUnlinkedInvoices` is the backfiller. Strategy 1 needs a **SecureWorks** job number in the
   Reference; `MLB-27093PO-56481` is a **builder** reference, so `extractJobNumber` returns null.
   Live: **175 of 179** unlinked live ACCREC rows carry no SecureWorks job number at all. Strategy 2
   matches contact name, which for MLB maps to many jobs, so the `length === 1` test fails.
3. Even on a match, `sealedSesXeroLinkRefusal` refuses: `linked` is a sealed verb of the write-once
   SES money fence, and every SES board card carries `ses_money_sealed_at` (SWMS-261025 confirmed
   sealed).

**Where the fix belongs: READ time, and it is already ruled.** The Captain's 2026-08-01 ruling was to
leave the money mirror alone and close the gap on the read side —
`docs/evidence/ses-c3-invoice-link-seal-conflict-2026-08-01.md`,
`makesafe_invoice_reference_match.ts`. That module is deliberately strict (a card-UNIQUE match only)
because attributing the wrong invoice to a card is worse than reporting none. For Koondoola it
returns nothing at all — two candidates name digits `27093`, so it excludes both as
`multiple_invoice_candidates`. It would not have stopped this bill, and that is correct behaviour
for a matcher whose job is attribution.

The distinction that resolves this: **a matcher for attribution must be unique; a matcher for
refusal must be inclusive.** The duplicate guard does not need to know *which* invoice covers the
work — only that one plausibly does. So the guard consumes reference evidence directly and treats
absent `job_id` as an unknown rather than a clearance (see the discriminator below).

**Named, NOT performed: a backfill of `xero_invoices.job_id`.** 142 live ACCREC rows are
unattributed as of this run (179 including DRAFT and counting a wider status set at the time of the
first probe). Linking them is a sealed `linked` write and needs a Captain ruling; it is out of scope
for this task and no rows were touched.

### Failure 3 — the probe recorded `sibling_po` and returned `allows_create: true`

The stored proposal on obligation revision `74c53b57-131f-5314-a0b8-fe17bfe06a5c` reads, verbatim:

```json
{"ambiguity": "sibling_po", "match_tier": null, "allows_create": true}
```

with `reason_codes: ["different_po_sibling_does_not_block"]` and `live_invoices: []` — the guard
detected the ambiguity, named it, discarded the evidence, and permitted.

**Fix.** `sibling_po` now means one thing — *one-sided PO evidence* — and it refuses, carrying the
invoices it refused on. The permitted case (both sides name a PO, and the two differ) is no longer
filed as an ambiguity at all: it is a demonstrated distinction, reported as `ambiguity: "none"` with
`different_po_sibling_does_not_block` retained so audit trails still read the same reason. Both
`prepareSesInvoiceObligation` and the mint path route `sibling_po` to
`invoice_duplicate_ambiguous` ("resolve which invoice owns this work"), because the card has no
bound invoice to point at and "use the bound live invoice" would name one that may not exist.

A second, narrower hole closed alongside it: `resolveSesInvoiceDuplicates` dropped claim bases
shorter than 5 characters from its bounding filter, which made the ambiguity branch unreachable
rather than safe. The `>= 5` floor guards the SUBSTRING test, where a short token false-matches
inside an unrelated number; claim-base membership is exact equality and needs no floor.

---

## 3. Where the line is drawn, and why it is not symmetric

The brief asks for a guard that refuses when references plausibly denote the same work and permits
when they demonstrably do not. Two live pairs show that the reference alone cannot make that call:

| claim | cards | verdict |
|---|---|---|
| `MLB-24732` | SWMS-26526 (`MLB-24732`, PAID INV-0745 $1,556.50) and SWMS-26938 (`MLB-24732PO-55712`, AUTHORISED INV-0999 $929.50) | two REAL jobs, both correctly billed |
| `MLB-27093` | SWMS-261025 (`MLB-27093`, DRAFT INV-1140) against AUTHORISED INV-1080 (`MLB-27093PO-56481`) | one job, billed twice |

Identical string shape. Opposite truth. Refusing every one-sided pair would have blocked SWMS-26938
from ever invoicing — the F07 overcorrection.

**What separates them is ATTRIBUTION, not the reference.** INV-0745 is already linked to
SWMS-26526's job, so it is demonstrably another card's money and cannot also be ours. INV-1080
carries `job_id = NULL`, so nothing rules out that it is ours — and it was.

So the rule is:

> A one-sided PO pair blocks **unless the candidate invoice is already attributed to a DIFFERENT
> card.** Every gap fails closed: no candidate job, no caller job, either side unreadable — block.

This is where failure 2 stops being a nuisance and becomes load-bearing. A NULL `job_id` is not
merely a join that returns zero; it is the missing evidence that turns a resolvable pair into an
ambiguous one. The seal refuses to repair it at write time, so the guard reads absent attribution as
an unknown.

The asymmetry is deliberate and is the reason the default is refusal. A wrong refusal costs an
operator a minute and a question. A wrong permission bills a real customer twice and reaches them
before anyone notices.

---

## 4. The census the Captain asked for

`scripts/ses-po-suffix-duplicate-census.ts` — read-only, re-runnable, imports the shipped predicates
rather than restating them:

```
SUPABASE_ACCESS_TOKEN=… deno run --allow-env --allow-net --allow-read \
  scripts/ses-po-suffix-duplicate-census.ts [--json] [--include-cancelled]
```

Run 2026-08-06, population `ses-board-population/active-v1` (NOT the whole board — Captain decision
C.5 is open, so the 33 cancelled cards are outside this denominator):

| | |
|---|---|
| cards measured | 423 |
| live ACCREC invoices | 761 |
| …of which unattributed (`job_id` NULL) | 142 |
| **cards whose reference differs from a live invoice only by a PO suffix** | **31** |
| …newly refused by this fix, with no other blocking evidence | **2** |
| …of those, refused against an ISSUED invoice | **2** |
| …that would have been FALSE refusals without the attribution discriminator | 2 |
| …already blocked by other evidence (own invoice, or identical reference) | 27 |

**Koondoola is not alone. Two more cards are sitting in the same position, both against AUTHORISED
invoices, and both could still have minted:**

| card | suburb | would mint | existing invoice | dated | total inc |
|---|---|---|---|---|---|
| `SWMS-26931` | Clarkson | `MLB-24664` | AUTHORISED `INV-1051` `MLB-24664PO-55370` | 2026-07-27 | $1,980.00 |
| `SWMS-261018` | West Perth | `MLB-24881` | AUTHORISED `INV-1083` `MLB-24881PO-56387` | 2026-07-30 | $385.00 |

Both are `status: processing`, `substatus: company_contact_required`, with **zero** invoices and
**zero** invoice obligations of their own — so neither had reached the mint yet. Both invoices are
unattributed. `SWMS-261018` is the sharper one: its `makesafe_job_details.external_ref` is already
`MLB-24881PO-56387`, character-for-character the reference on the invoice that covers it, while its
intake case's work-order canonical is the claim-only `MLB-24881` that the mint would have used.

The two cards saved by the attribution discriminator — `SWMS-261118` Munster and `SWMS-261057`
Mindarie — would have been refused by a naive "any one-sided pair blocks" rule.

## 4b. LIMITATION — this fix closes the backend route only, not the skill-script route

**Landing this change closes the `ops-api` (backend) duplicate-guard route. It does NOT close the
skill-script route.** The wiki `invoice_utils.py` / `create_makesafe_draft_invoice.py` twin carries
the identical PRE-FIX predicate — `_same_work_ref` still answers "different PO, different work" for
a claim-only reference beside a PO-bearing one — wired into a LIVE mint guard
(`create_makesafe_draft_invoice.py:204` calls `resolve_existing_invoice`), not dead code. That wiki
repo is version-pinned and must never be edited from this repository; narrowing the twin is filed
separately for the governed release path.

A green merge of this PR must NOT be read as full coverage of the Koondoola-class defect. The two
at-risk census cards named in §4, `SWMS-26931` (Clarkson) and `SWMS-261018` (West Perth), remain
mintable against their existing AUTHORISED invoices through the skill-script route.

## 5. Follow-ups named, not taken

1. **`xero_invoices.job_id` backfill** for the 142 unattributed live ACCREC rows. Sealed `linked`
   verb; needs a Captain ruling. Not performed.
2. **Same-claim, same-PO twin cards.** The census surfaced two pairs where BOTH cards resolve the
   same claim AND the same purchase order, split across two board cards with different reference
   grains: `SWMS-261065` / `SWMS-261118` (Munster, `MLB-26344` + `PO-57087`, money on INV-1117) and
   `SWMS-261081` / `SWMS-261057` (Mindarie, `MLB-27100` + `PO-56960`, money on INV-1150). The guard
   permits the twin because the money is attributed to its sibling card. Deciding whether those are
   one job or two is the duplicate-survivor adjudication
   (`docs/evidence/makesafe-duplicate-survivors-2026-08-01.md`), which is hand-adjudicated and
   Captain-owned — not the invoice guard's call. Once composition lands, two such cards minting from
   the intake case will produce the SAME composed reference and collide at the exact tier; the
   residual gap is only against legacy claim-only invoices.
3. **`INV-1140` was not voided.** It remains an untouched DRAFT, exactly as found. The void waits for
   the Captain.

## 6. Proof

Regression suite: `supabase/functions/ops-api/makesafe_invoice_po_blindness_test.ts` (16 tests). Every
case is a real production pair:

- the exact live pair `MLB-27093` vs `MLB-27093PO-56481` matches and refuses, in **both** directions;
- composing `PO-56481` turns it into an EXACT reference match;
- a `sibling_po` ambiguity refuses and names the invoices it refused on — the exact probe shape
  SWMS-261025 recorded and ignored;
- `SWMS-26938` / `MLB-24732PO-55712` still mints beside `SWMS-26526`'s own invoice;
- two different-PO siblings remain a demonstrated distinction, not an ambiguity;
- the F07 direction still refuses, and the live Floreat trio (`SWMS-261019` PO-56395, `SWMS-261020`
  PO-56397, `SWMS-261021` PO-56459, all carrying `builder_wo_canonical = MLB-27037`) separates once
  each card carries its own PO — while `SWMS-261021`'s own unlinked DRAFT `INV-1116`
  (`MLB-27037PO-56459`) becomes an exact match the claim-only grain could never recognise.

Full ops-api suite: 3559 passed / 23 failed, against a base-commit baseline of 3542 passed / 23
failed. The failing set is byte-identical to the base commit (verified by diffing the sorted failure
lists) — 23 pre-existing failures, none introduced here. The repository's `deno task test:ops-api`
also fails type-checking on `cp1_drag_reschedule_test.ts` at the base commit, unrelated to this work.

**A green suite is not the proof.** These tests mock the database. The live readback in §1 and the
census in §4 are the proof, and both are re-runnable by anyone with `SUPABASE_ACCESS_TOKEN`:

```
# the pair, read-only
select invoice_number, status, reference, job_id, invoice_date, total
from xero_invoices where reference ilike '%27093%' order by invoice_date;

# the probe the card actually stored
select proposal->'duplicate_probe', proposal->>'reference', state
from makesafe_invoice_obligation_revisions
where job_id = '9d7e35ae-94b9-4142-a28b-61ea6c7dccb6';

# the board-wide count
SUPABASE_ACCESS_TOKEN=… deno run --allow-env --allow-net --allow-read \
  scripts/ses-po-suffix-duplicate-census.ts
```

This change has NOT been deployed. The guard as described is what the code does; what production
does is still ops-api v1058 until an edge deploy runs.
