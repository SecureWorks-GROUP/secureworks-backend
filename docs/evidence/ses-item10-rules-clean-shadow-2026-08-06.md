# SES Item 10 — the rules-clean determination, and its first live shadow run

**Date:** 2026-08-06
**Ticket:** `secureworks-wiki` `coding/work/campaigns/makesafe-system/tickets/rescue-ses-remainder-v1/10-invoice-automation-auto-authorise.md`, plus `SPEC.md` Item 10
**Status:** classifier built, guard suite green, **zero-write shadow run executed live across the board**. **No invoice was authorised, minted, voided, sent or re-priced.**
**Amended 2026-08-07 (contract `ses-rules-clean/v5`):** code review found **blind guards inside the classifier itself**, over four rounds — including gaps found inside the fix for the previous round, twice. All are closed. See §0 "Four" and §6a. The run artifact has been **regenerated against production under `v5`** (§4); its generation id reproduces on rerun.

---

## 0. For the Captain — four things, no code required

### One. Roof reports currently have NO guard that can refuse an overcharge

The pricing guard that checks roof reports only ever asks *"is this at least $300?"* It never asks *"is this exactly $300?"* So on a roof card where $300 is the correct price, an invoice of **$350, $500 or $5,000 all come back CLEAN**. Not "unsure" — clean, the same word a correct invoice gets. Nothing else covers the gap: the other pricing checks either only want a positive total, or never look at a roof line at all.

**This does not get more severe under automation. It changes character.**

- **Today, with you at APPROVE INVOICE:** it is a robustness problem. The guard is blind, but **you read the number.** You are the check. An overcharge stops at your press.
- **Under auto-authorisation:** it is a money problem. The invoice reaches **AUTHORISED in Xero with nobody looking**, and the pricing guard named on the rules-clean list says `clean` the entire way. There is no second look, because removing the second look is the whole feature.

That is the clearest single argument for why **rules-clean carries the entire safety of this**. The guards are not a safety net under a human any more. They *are* the safety. A guard that cannot see the fault it exists to catch is not a small defect once you are no longer standing behind it — it is the only thing standing there.

The automated class is covered: the new `B5_report_rate` compares against the sealed rate rather than a floor, and refuses in both directions. **The skill's own guard is not fixed** — that is a wiki change through the governed release path, and until it lands the skill's pre-create gate still cannot refuse a roof overcharge.

### Two. One card is carrying a stale price right now, and only one thing is stopping it

`SWMS-261079` has a saved pricing sheet that says **$350 ex** for a double-storey roof report. That number was correct when it was saved on 3 August. It was superseded by your 6 August ruling to $300. That card has **no override on it**, so unlike the other two roof cards, nothing has corrected it.

The reason that is not a live overcharge waiting to happen is narrow and worth naming: **the classifier re-derives the price from the current sealed rule instead of trusting the number saved on the card.** It recalculates $300, sees $350, and parks the card.

**This is a property to keep, not an implementation detail.** Someone will eventually be tempted to read the saved number directly — it is right there, it is faster, and it looks authoritative. It is not. A saved pricing sheet records what the rules said **then**; an invoice must be priced by what they say **now**. Every card prepared before a ruling is a card carrying a superseded price, and trusting the artifact is how one of them gets billed.

### Three. The standing rule I broke tonight, and had to withdraw

I told you production was still pricing double-storey roofs at $350. **That was wrong**, and it is withdrawn in §5a. Your live pricing is correct at $300.

I got there by reading a saved database row and reporting it as *current deployed behaviour*. The row was seven hours older than the deploy. I never actually asked the deployment anything.

The rule, which now sits in `AGENTS.md` where the next agent reads it before working rather than only here: **measure the deployed thing, or say you did not.** A claim about what production does must come from production, or from something produced after the deploy. Where neither is available — as here, because there is no roof card prepared since the deploy — the honest answer is "not observed", never a confident number.

### Four. Two guards were themselves blind, and the dry run did not catch it — the review did

This is the part worth reading twice, because it is the same fault this whole item exists to survive, found **inside the thing built to prevent it**.

**Gap one — a guard that said "clean" because it had been shown nothing.** The guard that asks *"does this card already have an invoice, and is it our own draft?"* answered **clean** whenever no invoice was handed to it. That sounds harmless. It is not: "nobody gave me an invoice to look at" and "there is genuinely no invoice" are different facts, and the guard reported the same word for both. A read that failed, a half-built evidence bundle or a future refactor would each have produced a **clean** verdict manufactured out of nothing. Fixed: the caller must now **state** which question it is asking — "nothing minted yet" or "advance this existing draft" — as a positive claim. An unstated one parks. An absent invoice where one was claimed parks.

**Gap two, the more serious — nothing checked the number on the actual invoice.** Every pricing guard checked *our own saved pricing sheet*. Not one of them looked at the total on the **Xero draft that would actually be authorised**. A Xero draft stays editable in Xero after it is created, so the whole classification could read clean while the invoice being advanced carried a different figure. Everything upstream correct, the money still wrong, and nobody looking — which is precisely the situation this automation creates. Fixed: a new guard (`A6`) compares the **actual ex-GST total on the Xero draft** against the price the sealed rules derive. A disagreement flags. A total that is absent or unreadable parks; it is never assumed to match.

**Neither gap showed up in the live shadow run.** The run was honest and useful, but it exercised the guards against the board as it happens to be tonight; it could not see a guard that reports clean for the wrong reason. That is the strongest evidence yet that the dry-run-first instinct was right. Had this gone straight to a supervised first fire, one card would have been watched very carefully while **two guard gaps sat underneath it**, invisible, in the exact place the safety is supposed to live.

**The claim your money now rests on, stated plainly:** the classifier verifies the price against the **actual total on the Xero invoice**, not merely against what we intended to bill.

**And a clean answer is only ever permission for the next single step.** The invoice does not exist until it is created, so a check run *before* creation has no number to look at — it can only say "go ahead and create it". Every clean answer now states which of the two it is: **create the invoice**, or **advance an invoice that already exists**. An answer given before the invoice existed can never be read as permission to advance one, so the card is always checked a second time, against the real figure, before any money moves.

**Two more of the same kind, found in the second review pass.** Both are guards that were reading a source which cannot see the fault they exist to catch.

- **The price check must ask Xero, not our own copy of Xero.** The first fix bound the check to the draft's total — but the total it read came from our **local copy** of the invoice, which is written once when the invoice is created and never updated afterwards. So if someone edits the draft in Xero, our copy still shows the original figure, and the guard would have compared the correct price against the correct price and said clean while the edited invoice went through. Our local copy is now **explicitly refused** as a source: only a total read from **Xero itself, at the moment of the decision**, can satisfy the check. The dry run can only read the local copy, so it now parks every already-minted card by design, and says so.
- **The check now also reads the GST-inclusive total** — the number the builder actually pays. A tax-setting change moves that figure while leaving the pre-GST figure untouched, so checking only one of them left a way through.

**A successful photo of the portal is not a finished report.** Found in the third review pass, and it is the sharpest version of this whole pattern. Each portal screenshot carries two separate facts: whether the **screenshot itself** is sound, and what the screenshot **actually saw** — done, not done, or the page could not be reached. The check was reading only the first one. So a perfectly good screenshot of an **unfinished portal** satisfied the evidence floor, and the verdict would have named it as the proof the report exists. It is evidence of the opposite. A capture recording *not done* or *unreachable* now **flags** the card, and a capture that does not say what it saw parks.

**Approved, not merely "not known to be bad".** Found in the fourth pass. The screenshot check was refusing **one** producer we knew was wrong — the in-house observer that photographs a blank frame — and accepting everything else by default. But the whole reason that observer is on the list is that **nobody had thought to exclude it** until it caused a problem; the next one like it would have sailed through the same way. It is now the other way round: a screenshot counts only if it came from a tool we have **positively approved**, and anything we do not recognise parks. Two separate questions are asked, both positively — which approved *method* was used, and which approved *tool* did the looking. The in-house observer is still refused **by name**, with its reason, so anyone reading a parked card learns why the boundary exists.

**And the same reasoning applied to the evidence side.** A portal screenshot is only evidence when it was **positively certified** — the writing process can save a record and then fail its own verification, and it cannot delete what it refused to certify, so an uncertified record exists and looks present. Anything not certified is now treated as **no evidence at all**, not as evidence with a caveat. And where a card holds several screenshots (including a duplicate that is still an open item for you), the verdict now **names the exact one it relied on** instead of merely counting that at least one was there.

---

## 1. What was built tonight, and what was deliberately not

**Built:**

| Artifact | What it is |
|---|---|
| `supabase/functions/ops-api/makesafe_invoice_rules_clean.ts` | The pure rules-clean determination. **17 guards** in three closed families (16 as first landed; `A6` added by the 2026-08-07 review, contract `ses-rules-clean/v5` after the fourth pass). No I/O — the caller does the live Xero read and states its provenance. |
| `supabase/functions/ops-api/makesafe_invoice_rules_clean_test.ts` | 42 tests, counted in the file (26 as first landed, plus 4 at `v2`, 3 at `v3`, 4 at `v4`, 2 at `v5`, and 3 for the verdict's own permission scope): one per guard proving it can PARK the card and name itself, plus errors-park, the PO-suffix regression in both directions, and the no-send assertion. |
| `scripts/ses-rules-clean-shadow.ts` | The dry-run mode. Read-only, Management API `read_only:true` only, no ops-api action called at all. |
| `scripts/ses-rules-clean-shadow-2026-08-06.json` | The run's per-card verdict manifest, generation `f7795ab9426f3ef8…` under `ses-rules-clean/v5` (content-derived; verified to reproduce on an immediate rerun). |

**Deliberately NOT built:** the wiring that makes `approve_ses_invoice_revision` / `execute_ses_invoice_revision` reachable by the skill. See §8 — it needs a migration, and the ticket's D5 gate has not been answered. Nothing shipped tonight changes any behaviour the Captain will meet tomorrow: the classifier is a new module with no call site in `ops-api`, and the shadow is a script. **The skill runs tomorrow exactly as it runs today.**

---

## 2. The thing the ticket asked to be verified in code first

> "The ticket's rehearsability conclusion was read from the spec rather than the code… **Check that in the code yourself.** If preparing persists anything, 'zero writes' is not free."

**`prepare_ses_invoice_obligation` PERSISTS. Confirmed in code, not inferred.**

`prepareSesInvoiceObligationAction` (`supabase/functions/ops-api/ses_reporting_actions.ts`) ends with:

```ts
const committed = await client.rpc(
  "commit_ses_invoice_obligation_revision_v1",
  { p_obligation: prepared.obligation, p_revision: prepared.revision },
);
```

It takes **no `dry_run` parameter** and has no non-persisting branch. Preparing writes an obligation row and a revision row every time. So "prepare it and look at what comes back" is a write to the money ledger, not a rehearsal.

**Consequence, and it shaped the whole harness:** the shadow classifies from the **already-persisted docket revision** instead. That is sound rather than a compromise — `prepare` copies `local_invoice_proposal.line_items` **verbatim** into the obligation lines (same file, the `ObligationLine` map), so the money a prepare would produce is already sitting on the docket. Nothing needed to be prepared to see it.

Two other paths were checked for the same reason:

- `prepare_ses_docket_revision` with `dry_run: true` **does** skip persistence (`if (!request.dry_run)` guards the `deps.persist` call). It was still not used — the persisted docket answers the question and needs no call at all.
- `resolve_ses_invoice_duplicates` is a pure read plus a pure resolver. Also not called: the shadow runs the same pure resolver locally over rows it read itself.

**Total writes performed by tonight's run: zero.** The only production access was `POST /database/query` with `read_only: true`, which the database itself enforces, behind two client-side refusals (`assertReadOnlySql`, `assertNoPiiColumns`).

---

## 3. The guard families that define rules-clean

This list **is** the definition. An invoice is rules-clean only if every guard is evaluated and every one returns `clean`. There are three outcomes, never two — `clean`, `flagged`, `unevaluable` — and **`unevaluable` parks**. There is no branch in the module that turns "I could not tell" into "clean".

### A. Identity and duplication — "does this work already have an invoice?"

| Guard | What it asks |
|---|---|
| `A1_duplicate_resolver_all_tiers` | The five-tier resolver (`obligation_binding`, `job_id`, `reference`, `reference_substring`, `reference_po_base`) returns no live match. |
| `A2_ambiguity_is_refusal` | `multi_live`, `sibling_po`, `void_only`, `mirror_xero_mismatch` each REFUSE. A probe that records an ambiguity **and** `allows_create: true` — the exact Koondoola combination — parks. |
| `A3_builder_reference_present` | A non-empty canonical builder reference. The reference tiers are inert without one. |
| `A4_full_accrec_scan` | The full live-ACCREC estate scan (`resolveExistingInvoice`, the same resolver the mint runs) found nothing. The indexed probe answers a narrower question and **cannot stand in for it**. |
| `A5_subject_invoice_is_our_current_draft` | **Added by this work; not on the ticket's list.** See §6. The determination point (`pre_mint` / `authorise`) is a POSITIVE CLAIM the caller states; an unstated point, or a claimed-but-missing subject invoice, is `unevaluable` and parks. |
| `A6_xero_draft_total_is_the_sealed_total` | **Added by the 2026-08-07 review; see §6a.** The DRAFT's OWN ex-GST **and inc-GST** totals, read from **Xero itself at determination time**, equal the money the sealed law derives. The obligation is the intent; the draft is the money, and it is the draft that gets authorised. The local `xero_invoices` mirror is **refused as a provenance** — it is written at the mint and cannot witness a later edit. Absent, mirrored, origin-less or unreadable is `unevaluable` and parks — never assumed to match. |

### B. Pricing — "is this money derived from sealed rules?"

| Guard | What it asks |
|---|---|
| `B1_pricing_basis_sealed` | The basis has a sealed derivation in this module. An unmodelled basis is `unevaluable`, not clean. |
| `B2_sealed_line_derivation` | **The whitelist.** Every priced line reproduces exactly the line the sealed law derives from the card's own declared facts — wording, quantity and rate. |
| `B3_company_labour_schedule` | Labour at the sealed rate ($80 ex AJS/AJBR, $85 ex MLB) per trade-hour. |
| `B4_attendance_hours_floor` | Billable hours at or above the sealed floor, and the declared floor IS the sealed one. |
| `B5_report_rate` | Roof $250 ex single / $300 ex double; assessment $150 ex ($130 fence-only). |
| `B6_nonzero` | At least one line, no negative unit price, positive ex-GST total. |
| `B7_no_hand_pricing` | No rate override, commercial quantity override, or operator materials-charge decision. |
| `B8_materials_rate_card_sealed` | No materials-bearing line. Item 08 has not sealed a rate card, so no guard can check the figure. |

`B4_attendance_hours_floor` also owns the case where the billable hours simply disagree with `max(reported, floor)`: the derivation names it, so the parked card states the hours rule rather than a line-count mismatch downstream of it.

### C. Evidence and readiness — "is the pack real?"

| Guard | What it asks |
|---|---|
| `C1_docket_ready_zero_blockers` | A persisted `pre_xero` docket, `state: ready`, zero blockers, `pre_xero_docs_ready`. |
| `C2_docket_bound_to_this_card_and_cycle` | That docket belongs to THIS job and covers its current attendance cycle. |
| `C3_report_evidence_floor` | The report evidence is **independently** proven, not self-vouched. This is where the two open readiness gaps are excluded by name. Which floor a card owes is a **stated claim** (`report_evidence_floor`), never inferred from which field the caller populated; unstated parks, and unknown independence never passes on the pack branch. On the portal branch the classifier — not a caller's query string — decides which capture qualifies: only a `roof_report` capture that is **positively certified** (`status = verified`) **and records `capture_result: done`**, written under an **approved, screenshot-bearing capture contract** by an implementation on the **closed approved allow-list** (unrecognised parks; the F7 observer is refused by name), with a re-verifiable page-text coordinate, on the card's current cycle. A certified `not_done` / `unreachable` **flags** — it is evidence against completion — and an unrecognised result parks. It **names the capture it relied on** in the verdict rather than counting rows, and it never alters, dedupes or orders away a row. |

### Why B is a whitelist and not a checklist

`deriveSealedProposal` re-derives the exact line set the sealed law would have produced, and B2 requires equality. A blacklist can only catch fault shapes someone anticipated. This refuses **every** shape that is not the one sealed shape — so an unmodelled fault is a mismatch, and a mismatch parks. That is the structural answer to "a fault class absent from the shadow window", and it is why the tests include an unmodelled `site allowance` line and a hand-edited builder-facing wording, neither of which any named guard describes.

### The divergence rule

The classifier is a **subtractive gate, never a pricing authority**. If it and the skill's Python guards disagree, the correct resolution is **the one that parks more**. Widening it to admit a card the Python guards would refuse is a money-safety defect; narrowing it so a card parks unnecessarily costs one Captain press.

---

## 4. The live shadow run

Re-run against production on 2026-08-07 under the amended contract, so these
numbers and the committed manifest are the SAME generation. Read-only, 8 queries.
Denominator: `ses-board-population/active-v1` — **not the whole board**, Captain
decision C.5 is open and the ~33 cancelled cards sit outside it.

```
Contract                        ses-rules-clean/v5
Generation                      f7795ab9426f3ef8…   (reproduced on rerun)
Cards classified                420
Live ACCREC rows scanned        930  (the full estate, per card)
Writes performed                  0

Verdicts
  rules_clean                     0
  parks                         420

Determination point
  pre_mint                      417
  authorise                       3   (card carries exactly one own DRAFT)

First parking guard — the one the card would name
  A1_duplicate_resolver_all_tiers   229
  A3_builder_reference_present      183
  A2_ambiguity_is_refusal             4
  C3_report_evidence_floor            3
  B2_sealed_line_derivation           1

Per-guard non-clean                    flagged / unevaluable
  A1_duplicate_resolver_all_tiers          229 /   0
  A2_ambiguity_is_refusal                    4 /   0
  A3_builder_reference_present             366 /   0
  A4_full_accrec_scan                      229 /   0
  A5_subject_invoice_is_our_current_draft    0 /   0
  A6_xero_draft_total_is_the_sealed_total     0 /   3
  B1_pricing_basis_sealed                    0 / 366
  B2_sealed_line_derivation                  1 / 366
  B3_company_labour_schedule                 0 / 366
  B4_attendance_hours_floor                  0 / 366
  B5_report_rate                             1 / 366
  B6_nonzero                                 0 / 366
  B7_no_hand_pricing                         7 / 366
  B8_materials_rate_card_sealed              5 / 366
  C1_docket_ready_zero_blockers             15 / 366
  C2_docket_bound_to_this_card_and_cycle     1 / 366
  C3_report_evidence_floor                  26 / 366
```

**Reading `A6`'s 3 unevaluable, which is the harness being honest about itself.** Exactly the three `authorise`-point cards park on `A6`, and they park **by design**: the shadow reads the local `xero_invoices` mirror, and the mirror is explicitly refused as a provenance because it is written at mint and cannot witness a later edit in Xero. So the dry run **cannot** clear `A6` for an already-minted card, and it says so rather than passing. Clearing it needs a total read from Xero itself at determination time — which is a live-read the ops-api caller supplies, and is therefore first-live-proof **L8**. This is the guard refusing to be satisfied by the only source available to it, which is the behaviour that was asked for.

**Reading the 366.** 366 of 420 cards have no persisted docket revision at all, so every pricing and readiness guard is `unevaluable` on them and they park. That is not a defect — a card with no pack is not a candidate for an invoice, let alone an automated one. The population that can be meaningfully classified is the **54 cards with a docket**, and of those 39 are `pre_xero` / `ready`.

**Zero rules-clean tonight, and the reason is not the classifier.** Of the 54 docket cards, 28 clear the evidence floor (C3) — and **all 28 already carry a live invoice**, so A1 correctly refuses. The un-invoiced cards are the ones whose report evidence is not independently proven. The board tonight simply has no card that is both un-invoiced and evidence-clean. See §7 for what the closest card needs.

---

## 5. Three money-safety findings from the run

### F1 — the roof branch of `check_report_rate_spec` is one-sided, so it cannot catch an overcharge

> **Correction, 2026-08-06.** An earlier version of this finding claimed *"the deployed ops-api still derives $350 ex / $385 inc"*. **That claim was wrong and is withdrawn.** Production is on `cb1deee`, which contains the pricing commit `312bc04` as an ancestor and reads `double: { ex_gst: 300, inc_gst: 330 }`. The correction and how the error was made are in §5a. The guard-blindness half below is unaffected — it never depended on the backend figure — and it is the finding that stands.

`check_report_rate_spec` compares a roof invoice **one-sidedly**:

```python
if expected is not None and ex + 0.01 < expected:      # roof: FLOOR only
...
if not any(abs(ex - v) < 0.01 for v in (ASSESSMENT_EX, ASSESSMENT_FENCE_ONLY_EX)):   # assessment: EQUALITY
```

The assessment branch tests equality and catches both directions. **The roof branch tests only a floor.** On a card where $300 ex is the correct sealed price, a roof invoice of $350, $500 or $5,000 all return **clean**, at any magnitude. And nothing else on the rules-clean list covers the gap: `check_nonzero_spec` only wants a positive total, and `check_company_labour_schedule_spec` never sees a roof line at all (`"Double Storey roof report"` matches none of its labour/attendance/trade patterns).

So the roof class has, today, **no guard that can refuse an overcharge.**

Under a human at APPROVE INVOICE that is a robustness problem: he reads the number. Under auto-authorisation it is a money problem — an over-priced roof invoice would reach AUTHORISED in Xero with nobody looking, and the pricing guard the rules-clean list names would say `clean` the whole way. **A blind guard reports clean.** That is the exact class of fault this item exists to survive, present right now, in a guard on the list.

`B5_report_rate` closes it for the automated class by comparing against the sealed rate rather than a floor. The suite pins it in **both** directions: $350 against a sealed $300 parks, and $300 classifies clean.

**Action:** this is a wiki-skill change (`makesafe_invoice_guards.py`, roof branch to equality), through the governed release path. Not made here — this repo does not own that file. Until it lands, the skill's own pre-create gate remains unable to refuse a roof overcharge even though the automated class now can.

### F1a — separately, a persisted docket can carry a superseded price

Three double-storey roof dockets carry $350 ex: `SWMS-261114` and `SWMS-261081` (committed 04:16–04:17Z on 2026-08-06) and `SWMS-261079` (committed 2026-08-03). All three **predate** the 11:36Z pricing deploy, so they are pre-ruling fossils, not evidence about the current backend.

The first two were resolved the same morning: each carries a Captain `labour_rate_override` on its obligation taking it $350 → $300, and both minted drafts (`INV-1149`, `INV-1150`) are $300 ex / $330 inc. The wiki's own pricing reference records that both "stand and need no remint". `SWMS-261079` has no obligation and no override, so its stale $350 docket is still the live artifact; a re-prepare on the current backend would produce $300.

The classifier handles all three correctly, and for the right reason: `B2`/`B5` **re-derive** from the current sealed constant rather than trusting the persisted artifact, so a stale docket flags instead of passing. `SWMS-261114` and `SWMS-261081` additionally park on `B7_no_hand_pricing` because of the override. This is a property worth keeping: a persisted proposal is a record of what the rules said *then*, and auto-authorisation must price against what they say *now*.

### F2 — one roof card's only portal proof is a synthetic observation card

Of the seven `verified` rows in `makesafe_portal_capture_revisions`, one (`SWMS-261081`, the card carrying live DRAFT INV-1150) was captured by `ses-prime-portal-observer/2026-08-02.4`. That is the in-repo F7 observer, which `installSafeCaptureFrame` covers with an opaque frame before every capture, so its images carry **no portal form fields at all**. It writes under the same approved `capture_producer` contract name as the compliant skill script, so `capture_producer` alone cannot tell them apart — only `captured_by` can.

Five of the remaining six carry `screenshot_content_hash = source_content_hash`, which is impossible for two different artifacts and means the caller-supplied page-text coordinate is corrupted (the documented live defect). The screenshot hash is server-computed and sound; the **textual** basis of the capture's verdict is not re-verifiable on those rows.

`C3` encodes both: a portal capture counts only when a real producer looked at the real page **and** the page-text coordinate is re-verifiable. All five roof portal cards are excluded tonight on one or the other.

### 5a — the withdrawn claim, and the check that would have caught it

Kept visible rather than edited away, because the mistake generalises and this repo has made it before.

**What I claimed:** "The deployed ops-api still derives $350 ex / $385 inc."

**What is true:** production is on `cb1deee`, deployed 11:36Z. `312bc04` (*"double-storey roof report price is $300 ex / $330 inc"*, PR #618) is an **ancestor** of it — verified with `git merge-base --is-ancestor`, not by reading a commit list — and `ROOF_REPORT_PRICING` on that tree reads `double: { ex_gst: 300, inc_gst: 330 }`. The deployed backend prices double-storey roof at $300 ex. **The Captain's live pricing is correct.**

**How the error was made, precisely.** I never queried the deployment. I read `sealed_unit_price_ex_gst: 350` out of **persisted obligation rows** and reported it as current deployed behaviour. Those rows were written at 04:16–04:17Z, **seven hours before** the 11:36Z deploy: they are a true record of what the backend derived *that morning*, which is exactly why the Captain had to apply per-card overrides to reach $300. Extrapolating a stored artifact to "still derives" turned a historical fact into a false live one.

Two things worth being exact about, because both are tempting excuses and neither holds:

- **It was not a too-early sample.** My shadow ran at 16:02Z, four and a half hours *after* the deploy. Run timing was never the issue — I was reading stored rows, so my own clock was irrelevant. What I failed to check was the **artifacts'** timestamps against the deploy.
- **It was not the wiki guard's copy either.** `makesafe_invoice_guards.py` reads `ROOF_REPORT_DOUBLE_EX = 300.0` in **both** clones, including the governed runtime pinned at `secureai-team-v1.0.4`. The wiki guard's *value* is right; only its *comparison* is one-sided, which is F1.

**The check that would have caught it, and which is now the standing rule:** a claim about deployed behaviour must be answered by the deployment — or, where the action is not reachable (`roof_report_template` is trade-authenticated and returned 401 to the ops key), by an artifact produced **after** the deploy. There is no post-deploy roof docket at all, so the correct honest statement was always *"the deployed roof price has not been observed"*, not *"it still derives $350"*.

This is the same shape as the incident recorded in `AGENTS.md` under the dashboard gitlink: a confident diagnosis of production built from a stale local coordinate instead of a measurement. **Measure the deployed thing, or say you did not.**

### F3 — the obligation's own `guard_result` is hardcoded empty, and must never be read as proof the guards ran

`prepareSesInvoiceObligationAction` writes `guard_result: { hard_failures: [], warnings: [...] }` with `hard_failures` a **literal empty array**. A future reader treating that field as "the pricing guards ran and passed" would be reading a guard that never ran. The classifier deliberately does not consult it.

---

## 6. One guard was added beyond the ticket's list, and why

`A5_subject_invoice_is_our_current_draft`.

The shadow found the gap: "does this work already have an invoice?" has two different correct answers depending on **when** it is asked. Before the mint, any live money on the card is a duplicate. After the mint, the card's own DRAFT is on the card — and that DRAFT is the very thing being authorised, not a duplicate of it. A classifier that cannot tell those apart either refuses every post-mint card (useless) or waves a second invoice through (dangerous).

So the evidence carries an explicit `subject_invoice`, the caller must exclude **exactly** that invoice from the duplicate question and nothing else, and A5 checks that what was excluded really is this card's own DRAFT bound to its own current obligation revision. An `AUTHORISED` subject parks. A DRAFT bound to someone else's obligation parks.

The same finding forced a second correction: at the authorise point, family B reads the **bound obligation's** lines, not the docket's. A Captain rate override lives on the obligation and never touches the docket, so classifying the docket while authorising the obligation would check money nobody is about to bill. That is exactly the shape of the two live roof drafts, and it is why `B7_no_hand_pricing` flags 7 cards rather than 5.

**This is a proposal to D5, not a decision.** The Captain's confirmation is what makes the list the definition; A5 is offered as an addition because it is strictly stricter.

---

## 6a. Two blind guards found by review, not by the run (2026-08-07, `ses-rules-clean/v2`)

Both are the module's own failure mode turned on itself, and both are closed. Neither weakens an existing guard; the classifier now refuses strictly more.

**(1) `A5` treated missing evidence as passing evidence.** It read `clean` whenever `subject_invoice` was absent, on the reasoning "nothing was minted, so nothing was excluded". But absence is not a fact this module can see: a failed mirror read, a partial evidence build or a refactor that stopped populating the field produced the same `clean`. Meanwhile `A1`/`A4` would still be scanning rows an excluded invoice had been removed from. That is a manufactured clean verdict — the blind-guard shape named in the module header, in the module itself.

The determination point is now **stated**, not inferred: `determination_point: "pre_mint" | "authorise"`, plus a `subject_invoice_read_error` channel like every other input has.

| Case | Outcome |
|---|---|
| `authorise`, no readable subject invoice | `unevaluable` → parks |
| `authorise`, subject read failed | `unevaluable` → parks |
| determination point absent or unrecognised | `unevaluable` → parks |
| `pre_mint` claimed, and a subject invoice supplied anyway | `flagged` → parks (the two cannot both be true) |
| `pre_mint` claimed, no subject invoice | `clean` |

A card with an empty evidence object now has **no clean guard at all**, which the suite asserts directly.

**(2) Nothing bound the sealed price to the Xero draft.** Family B checked the local obligation/docket lines. `subject_invoice` carried no total, `makeSesXeroGateway.authorise` posts only `{ InvoiceID, Status: 'AUTHORISED' }` and compares nothing, and a Xero DRAFT stays editable after the mint. So a draft edited in Xero between mint and auto-authorise would have reached AUTHORISED at the edited figure with every pricing guard reporting `clean`. Today the human at APPROVE INVOICE is what closes that; the point of this item is to remove him. Three live cards were already at the `authorise` point in the shadow run.

`A6_xero_draft_total_is_the_sealed_total` compares the DRAFT's own ex-GST `sub_total` against the total the sealed derivation produces, inside the existing money tolerance. **Mismatch flags. Absent, non-numeric, origin-less or unreadable is `unevaluable` and parks.** The rule recorded in the module: *the obligation is the INTENT; the Xero draft is the MONEY, and authorise acts on the money.*

The shadow supplies that total from the local `xero_invoices` mirror and stamps `totals_source: "local_mirror"`; a live call site must read the draft from Xero itself and stamp `xero_api`, because the mirror can drift (`mirror_xero_mismatch` exists for exactly that reason).

**The price check runs at the `authorise` point, because that is the only point at which the money exists.** The mint is what creates the draft, and the draft stays editable in Xero afterwards, so a determination taken at `pre_mint` — where `A6` records `clean` because there is genuinely nothing yet to compare — can never speak for the figure the invoice ends up carrying. A pre-mint pass is therefore **permission to mint, and nothing more**. The verdict says so itself rather than leaving a reader to infer it: `permits` is `mint_only` on a clean `pre_mint` determination and `advance` only on a clean `authorise` one, `requires_second_determination_at_authorise` is true on the former, and `permits_detail` states in operator English that the card must be classified again, against the live Xero total, before anything is advanced. Parking every `pre_mint` card instead would have been the wrong fix — it makes the whole pre-mint class unreachable and gives the automation nothing to do. `authorises_send: false` is unchanged and unrelated: this is a third thing the verdict refuses to authorise, not a replacement for it.

**Contract bumped to `ses-rules-clean/v2`** so every past determination stays attributable to the definition that produced it.

### The second pass, `ses-rules-clean/v3` — the same blindness, one seam deeper

**(3) `A6` was reading a source that cannot see the fault it was added for.** `xero_invoices` is a mirror written from Xero's response **at the mint**, so a freshly minted draft's mirrored `sub_total` equals the sealed derivation **by construction**, and an edit made in Xero afterwards never touches it. Answering `A6` from the mirror therefore compares the sealed total against itself and reports `clean` on exactly the drift the guard exists to catch. `totals_source: "local_mirror"` is now `unevaluable` and parks, with a detail saying plainly that the mirror cannot witness a post-mint edit; **only `xero_api` — a total read from Xero itself at determination time — can reach `clean`.** The module stays pure: the caller performs the live read and states its provenance, and this module's job is to refuse a provenance that cannot see the fault. (This is also why the shadow now parks all three `authorise` cards: it has no Xero credentials, so it can only stamp `local_mirror`, and it says so rather than passing.)

**(4) `A6` now also asserts the inc-GST total.** A tax-treatment edit (line amount type, tax rate) moves what the builder is actually billed while leaving `sub_total` equal to the sealed derivation. Both figures are compared, in the same shape as everything else: present and equal is clean, present and different flags, absent is `unevaluable` and parks.

**(5) `C3`: uncertified is not evidence, and the branch READS rather than counts.** The capture writer can append a row and then fail its own re-read — it refuses to certify but cannot un-write, so an uncertified row exists and looks present. That boundary used to live only in the shadow's SQL (`where status = 'verified'`), which means a caller that forgot the filter would have passed. The qualification rule now lives in the classifier: captures are supplied **unfiltered** and it decides. And instead of `usable.length > 0`, it identifies the specific capture and carries its coordinates (id, role, cycle, producer, time) into the guard detail, so the verdict names its own evidence and stays auditable. Several qualifying captures is not a failure — a byte-identical duplicate is an open Captain item — but the verdict still says which one it relied on. **No capture row is deduped, deleted or altered anywhere; duplicates remain the Captain's to resolve.**

**Contract bumped again to `ses-rules-clean/v3`.**

### The third pass, `ses-rules-clean/v4` — three of the four were inside the v3 fix

**(6) `capture_result` was never read.** `status = 'verified'` certifies the capture ARTIFACT; `capture_result` (`done` / `not_done` / `unreachable`, per the live CHECK in `20260728500000_makesafe_portal_capture_bridge_u4.sql`) is what the capture SAW. A certified `not_done` is positive evidence that the portal report does **not** exist — and it satisfied the floor and got named as the evidence relied on. It is now on `SesRulesCleanPortalCapture` and must be exactly `done`; `not_done` / `unreachable` **flag** (evidence against completion, not absence of evidence), and an absent or unrecognised result is `unevaluable`. An unrecognised value is never read as done.

**(7) The role test still lived in the caller.** The v3 rationale was that a qualification boundary may not sit in a caller's query string — but `role` was still filtered in the harness's JS, and the table permits four roles, so a certified `photos` or `scope` capture satisfied the roof-report floor for a caller that omitted the filter. The role test is now in the module: only a positively `roof_report` capture is this floor.

**(8) The branch was selected by field presence, which widened `C3`.** Which branch ran was inferred from `portal_captures != null` — the same "absence as an answer" shape `determination_point` exists to remove — and it regressed v2: a pack card whose independence proof was UNKNOWN passed on a capture that says nothing about it. `report_evidence_floor` (`pack_supporting_report` | `portal_capture`) is now a stated claim; unstated or unrecognised parks, and v2's "unknown independence never passes" is re-asserted on the pack branch.

**(9) Two smaller ones.** The capture relied on is now chosen deterministically (newest `captured_at`, id tiebreak, caller order last) so two identical read-only runs name the same row — without reordering or altering the caller's rows. And the sealed inc-GST total is rounded to cents for both the comparison and the operator-facing message, matching the producer's `Math.round(subtotal * 110) / 100`, so a parked card never shows `$935.0000000000001`.

**Contract bumped to `ses-rules-clean/v4`.** Every one of these was caught by REVIEW, not by the live shadow run.

### The fourth pass, `ses-rules-clean/v5` — the producer test was itself a blacklist

**(10) `captured_by` was tested negatively.** Role, status and result had all been inverted to positive tests, but what PRODUCED the capture was still "refuse the one known-bad prefix, pass everything else" — precisely the blacklist shape the module's own header rejects for family B, and precisely how the F7 observer got in. `capture_producer` was declared on the input and never read at all. Both are now positive and separate: `capture_producer` must be a trusted contract per `isTrustedSesPortalCaptureProducer`, and must be a screenshot-bearing one (`sesPortalCaptureProducerHasScreenshot`), so the trade attestation — an approved producer of the FACT, with no rendered page — can never stand in for a screenshot. `captured_by` must then match an entry on the closed `SES_APPROVED_PORTAL_CAPTURE_IMPLEMENTATIONS` allow-list; absent, empty or unrecognised is `unevaluable` and parks. The F7 observer stays refused BY NAME with its reason, so a stale caller is diagnosable rather than silently unevaluable.

**(11) The role and result constants are imported, not copied.** `SES_PORTAL_CAPTURE_RESULTS` and the roof-report role now come from `ses_portal_capture_contract.ts` — the authority that matches the live CHECK — instead of being restated here under the same names, matching the "imported never copied" discipline the sealed pricing law follows.

**Contract bumped to `ses-rules-clean/v5`.**

Two smaller review fixes rode along: any duplicate ambiguity now refuses by testing `!== "none"` rather than by membership of a hand-kept list (a state added to the union later parks by construction), and the attendance-wording map is keyed by the real `SesFamilyId` union so a new family is a compile error rather than a silently missing case.

---

## 7. The staged first fire

**Card: `SWMS-261029` — MLB, `MLB-25147`, Midland. 2 trades × 5 hours at the sealed $85 = $850 ex / $935 inc.**

**Why this one.** It is the **only** card on the live board that is clean across the whole of family A and the whole of family B:

- duplicate resolver: no match on any of five tiers
- full live-ACCREC scan across 930 rows: no invoice attributed to this work
- builder reference present (`MLB-25147`)
- sealed basis `standard_labour_materials`, sealed $85 rate, 2 trades × 5 hours = quantity 10, floor 3 and billable 5 both re-derive exactly
- no materials line, no rate override, no commercial override, no materials-charge decision
- docket `pre_xero` / `ready`, zero blockers, `pre_xero_docs_ready`, bound to this job and its current cycle

**Its dry-run verdict tonight: `parks`, on exactly one guard.**

```
[flagged] C3_report_evidence_floor: The supporting report self-vouches its own
completeness; an incomplete pack can pass the readiness read
(tuart-self-vouch-completeness-gate-v1, docket-readiness-photo-completeness-v1),
so this card class is excluded from automation.
```

Its current docket's `supporting_report_pdf` artifact carries only a `render_hash` — no `source_kind`, no `report_input_hash`, no `expected_raw_sha256` — and its two `makesafe_report` documents carry no curated coordinates and no attendance cycle.

**What clears it, by the sanctioned route and no other:** `bind_current_cycle_curated_makesafe_report` on the current cycle, then `prepare_ses_docket_revision` (`dry_run` first to confirm `supporting_report_plan.metadata.mode == curated_report_artifact_recovery`, then `dry_run: false`). Both are routine skill steps the Captain already runs. Neither is a code change, and neither was performed tonight.

**Honest caveat: $935 inc is not a small first fire.** It is simply the only candidate the board offers. If the Captain prefers a smaller blast radius, the correct move is to wait for a smaller card to reach the clean set rather than to relax a guard — and the shadow can be re-run at zero cost any time to see when one does.

**Excluded by name from first-fire staging** (still classified, because the run is read-only): `SWMS-261025` Koondoola, `SWMS-26931` Clarkson, `SWMS-261018` West Perth, `SWMS-26845` Queens Park.

### The classifier catches the incident card

`SWMS-261025` (Koondoola, live DRAFT INV-1140, reference `MLB-27093`) parks on `A1_duplicate_resolver_all_tiers` **and** `A4_full_accrec_scan`, both flagged, against the already-authorised `MLB-27093PO-56481`. That is the double-bill this whole item is built around, refused by the determination, on live production data. It is the strongest single piece of evidence in this run that family A has eyes.

---

## 8. What still blocks switch-on

**Gate 1 — D5, unanswered.** The Captain has ruled *that* the skill auto-approves. D5 is *when the definition is trustworthy enough*. §3 is the proposal; his confirmation makes it the definition. §6 adds one guard he has not seen.

**Gate 2 — a migration, named here rather than made.** `approveSesInvoiceRevisionAction` refuses any caller that is not a JWT user (`operatorAuth.mode !== "jwt" || !auth.user`), and beneath it `record_ses_revision_approval_v1` requires an `operator_id` present and active on `ses_release_operators`, or `is_admin_owner`. **A skill caller has neither.** Making auto-authorisation reachable therefore needs a standing-authority branch in that RPC — a migration. Per the brief I stopped and named it instead of writing it. It is also the right sequencing: a migration lands before its matching `ops-api`, and tomorrow is a no-coding day.

**Gate 3 — item 08.** No materials rate card exists, so `B8` parks every materials-bearing card. 5 cards flagged tonight.

**Gate 4 — the two open readiness gaps.** Not closed. Their card classes are **excluded by name** in `C3`, which is the ticket's stated alternative. 26 cards flagged, 366 unevaluable.

**Gate 5 — the agent-permission layer.** Untested tonight, because nothing tonight attempted a write. Still unproven for the mint sequence.

---

## 9. The residual — what the shadow run did NOT cover

Stated plainly, because the ticket asks for it and because it is the honest limit of this proof.

**What the shadow DID prove.** That the classifier, run against 420 real cards and the full 930-row live ACCREC estate, produces a verdict and a named reason for every one; that it refuses the live double-bill card on the tier that failed in the incident; that it refuses a superseded roof rate two other guards call clean; and that it never returned `rules_clean` on a card carrying live money.

**What it did NOT and cannot prove:**

1. **Fault classes absent from tonight's board.** The run only exercises the faults the 420 cards happen to carry. Concretely, **no live card exercised** `B1` (unmodelled basis), `B3` (off-schedule labour rate), `B4` (under-floor hours), `B6` (zero/negative invoice), or `A5` (wrong subject invoice) — every one of those is flagged 0 times in §4. Each is covered by a guard-specific unit test, which is a weaker proof than a live one: a test proves the guard fires on the shape **I** wrote, not on the shape production would produce.
2. **The whitelist's coverage of the genuinely unimagined.** `B2` refuses anything that is not the sealed derivation, which is why an unanticipated fault parks. But that is an argument from construction, and construction arguments have been wrong before in this system.
3. **The end-to-end path.** No mint, no approve, no authorise ran, so the acceptance check "a rules-clean card reaches AUTHORISED with no human press, and the audit row records the determination" **has still never executed**, exactly as the ticket recorded. Two earlier sessions were denied by the local permission classifier; this session did not attempt it, by instruction.
4. **The audit row.** Designed (the verdict is the record: closed guard list, per-guard status, detail, contract version) but not written anywhere, because writing it needs the migration in §8.
5. **The deployed classifier.** The module is in the repo and unreferenced by `ops-api`. It has never run inside an edge function.

---

## 10. Tier-2: first-live-proofs, each with its trigger

| # | Proof | Trigger condition |
|---|---|---|
| L1 | **The supervised first fire.** One card, Captain informed before it happens, result verified in Xero, class opens only after. | Captain's morning check-in, **after** D5 is answered and the §8 migration has landed and deployed. Candidate `SWMS-261029`, once its C3 is cleared by the routine bind + re-prepare and the shadow is re-run to confirm the flip. |
| L2 | **`rules_clean` is reachable on live data at all.** Tonight's run returned zero, so the clean branch has never fired on a real card. | Re-run `scripts/ses-rules-clean-shadow.ts` after any card clears its evidence floor. Zero cost, zero writes, any time. |
| L3 | **The five never-flagged guards against real faults** (`B1`, `B3`, `B4`, `B6`, `A5`). | First live card that carries each shape. Until then they are unit-tested only, and §9.1 is the standing caveat. |
| L4 | **The audit row answers "why was this authorised without me" per card.** | With the §8 migration, at the first authorisation. |
| L5 | **The deployed classifier agrees with the local one.** Byte-for-byte the same module, but it has never executed in the edge runtime. | First deploy through the normal edge lane. |
| L6 | **The roof branch of `check_report_rate_spec` refuses an overcharge (F1).** | The wiki-skill change to two-sided equality lands through the governed release path. Until then the skill's pre-create gate cannot refuse a roof overcharge, even though `B5` can. |
| L8 | **`A6` refuses a Xero draft edited away from the sealed total on real data.** Unit-tested only; no live card has carried the shape. | First `authorise`-point card whose draft total disagrees with the sealed derivation, or a deliberate rehearsal on a card the Captain nominates. |
| L10 | **`A6` answered from a LIVE Xero read.** Every determination so far has been mirror-sourced and therefore parked; the `xero_api` branch has never run against production. | The first call site that reads the draft from Xero at determination time — which is the same switch-on the §8 migration gates. |
| ~~L9~~ | ~~The regenerated shadow artifact under the current contract.~~ **CLOSED 2026-08-07:** re-run against production under `ses-rules-clean/v5`, generation `f7795ab9426f3ef8…`, reproduced on an immediate rerun. §4 now reports measured `v5` numbers. | — |
| L7 | **The deployed backend is observed pricing a double-storey roof.** No post-deploy roof docket exists, so its roof price is currently unobserved rather than confirmed — see §5a. | First roof docket prepared after the 11:36Z deploy; expect $300 ex / $330 inc with no override. `SWMS-261079` is the obvious candidate, its docket being a pre-ruling $350 fossil. |

---

## 11. What must not change

- **SEND IT stays the Captain's per-card hard press.** The determination carries `authorises_send: false` and a test asserts the serialised verdict names no route, recipient, send, mail or Graph marker at all.
- The sealed money fence, the duplicate guard, the evidence checks and every send gate are **consumed** here, never adjusted. This work adds one pure module, one test file, one read-only script and one artifact, and modifies **no existing code file** — the only edits to an existing file are the `AGENTS.md` entries recording §2, §5 and the classifier's own contract.
- No board write. The classifier reads the board and touches nothing.
- Voids stay out of scope entirely.

---

## 12. Reproducing this

```bash
# Read-only. Zero writes. Refuses non-SELECT and PII-naming SQL before sending.
SUPABASE_ACCESS_TOKEN=... deno run --allow-env --allow-net --allow-read --allow-write \
  scripts/ses-rules-clean-shadow.ts --json scripts/ses-rules-clean-shadow-2026-08-06.json

# The guard suite.
deno test --allow-env --allow-net=127.0.0.1 --allow-read \
  supabase/functions/ops-api/makesafe_invoice_rules_clean_test.ts
```

**The committed `scripts/ses-rules-clean-shadow-2026-08-06.json` is CURRENT.** It records `ruler_contract_version: ses-rules-clean/v5`, generation `f7795ab9426f3ef8…`, regenerated against production on 2026-08-07 after the review amendments and verified to reproduce on an immediate rerun. It was never hand-edited while it was stale — a manifest whose numbers were typed rather than measured is worse than an admittedly old one — so every number in §4 is measured, not transcribed.

The artifact's `generation.generation_id` is content-derived: a rerun over unchanged state reproduces it exactly, which is how a second reader independently verifies this run rather than trusting it. The `v5` run is the one verified to reproduce: `f7795ab9426f3ef8…` on the run and on an immediate rerun over unchanged state.

**Two different claims, checkable two different ways — and only one of them needs credentials.**

- **Every count in §4 is re-derivable offline, by anyone, with no production access at all.** The committed manifest carries one row per card, so the verdict split, the determination-point split, the first-parking-guard distribution, the per-guard non-clean totals and the three A6 `unevaluable` cards are all obtainable by reading `scripts/ses-rules-clean-shadow-2026-08-06.json` and counting. That is the larger part of §4, and it needs nothing but this repository.
- **The generation id is NOT recomputable from the committed artifact, and is verified only by re-running the shadow.** `buildSesMeasurementGeneration` hashes each card's `job_id`, while the manifest deliberately records `job_number` (`SWMS-…`) because that is what a human reader can act on. So the id cannot be recomputed from the artifact offline — that is a property of the artifact's readability choice, not a flaw in the generation, and it is not fixed by adding `job_id` to the manifest or by changing the hash input.

  The one method that verifies it: re-run `scripts/ses-rules-clean-shadow.ts` against production with a read-only Management API token (`SUPABASE_ACCESS_TOKEN`, the exact command at the top of this section) and compare the `generation_id` it prints to `f7795ab9426f3ef8…`. Per §5a, a reader without that token cannot check this claim and should record that they did not, rather than reporting it as confirmed — the pipeline's own test step hit exactly that (the token there returns `Unauthorized`, the run refuses before any query), verified §4 in full from the manifest, and correctly reported the id as unverified.

**Suite impact, measured as first landed and not re-measured since (the classifier file now holds 42 tests, 16 of them added by the 2026-08-07 review amendments):** `deno task test:ops-api` currently fails type-checking on a **pre-existing** error in `cp1_drag_reschedule_test.ts:466,508` (`assertStringIncludes(dup.reason, …)` where `dup.reason` is `string | undefined`), unrelated to this work and present on a clean tree. Run with `--no-check` to get a comparable number: **baseline 3647 passed / 24 failed; with this change 3673 passed / 24 failed** — exactly the 26 new tests, no regression. `deno check supabase/functions/ops-api/index.ts` stays clean.
