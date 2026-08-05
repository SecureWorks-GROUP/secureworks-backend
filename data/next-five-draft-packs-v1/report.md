# Next five draft packs v1

**Date:** 2026-08-05  
**Branch:** `fm/next-five-draft-packs-v1`  
**Mode:** operations only (no product code, no send, no approve, no authorise, no void)  
**Prior census:** `data/report-ready-pack-batch-v1/report.md` + `data/five-pack-elevated-blurbs-v1/report.md` (not re-censused from scratch)  
**Privacy:** suburb + job reference only. No client names, phones, emails, or street addresses.

Ledger evidence is **pdftotext + proof JSON only** (no binary PDFs in repo).


---

## CAPTAIN — WA delivery list (act on these)

Two clean packs with Xero **DRAFT** invoices under the full live ACCREC guard.  
One further card has a bound elevated report waiting on **your materials figure**.  
Two family/bind blockers are named below — not padded green.

What you are approving on the two DRAFTs: **authorise the existing Xero DRAFT**, then (when you choose) **SEND IT**. Do **not** re-prepare first unless something fails after authorise.

| # | Job number | Suburb | Builder ref | Invoice | Total inc GST | Photos | What you approve |
|---:|---|---|---|---|---:|---:|---|
| 1 | **SWMS-261139** | Swanbourne | AJBR-70554 | **INV-1139** DRAFT | **$176.00** | 13/13 | Authorise INV-1139. AJS labour 1×2h @ $80. Tarp make-safe. Cockpit HOLD only on AJS `report_invoice` route draft readiness — **APPROVE is enabled**. |
| 2 | **SWMS-261025** | Koondoola | MLB-27093 | **INV-1140** DRAFT | **$280.50** | 50/50 | Authorise INV-1140 then SEND IT (report / photo / invoice). Current-cycle moisture reattendance only. Labour floor 2h→3h @ $85. Materials deliberately **NONE** (checklist ticks only). |

### Waiting on Captain money decision (report already bound)

| Job number | Suburb | Builder ref | Hours (trade) | Named materials (need one ex-GST figure) | Labour floor if charged later |
|---|---|---|---:|---|---|
| **SWMS-261147** | Mosman Park | MLB-27482PO-57866 (WO) / MLB-27482 | 1 trade × **5h** | Structural timber x 8m; Plyboard 12mm 2.4x1.8 x 3; Screws x 40 | 5h × $85 = **$425 ex / $467.50 inc** + materials figure |

Body for the figure (single card):

```json
"materials_charge": {
  "schema": "secureworks.makesafe.materials-charge-figure/v1",
  "amount_ex_gst": <YOUR_FIGURE>,
  "authorised_by": "<you>",
  "authorised_at": "<ISO-8601>",
  "decision_key": "captain-materials-SWMS-261147",
  "reason": "<why this figure>"
}
```

Or `amount_ex_gst: 0` with the same authority fields if materials are deliberately not charged. Then re-run `prepare_ses_docket_revision` + `create_ses_invoice_draft` for this card only.

**Do not touch (per brief):** SWMS-261080 / 261020 / 261115; 26953; 26902 / 261128 / 261129; 261137; Maylands 261017; Bertram 261109; Munster 261065; Queens Park 26845; High Wycombe 261130/261131; claim-only siblings 261021/261116/261079; Tuart 261015.

---

## Bottom line

**Two honest DRAFT packs** for WA authorise. **One materials-figure ask** with elevated report already bound and photos 15/15.  
Repair/restoration curated bind and spine/SWMS blockers on other candidates are **named stops**, not forced greens.

Fewer padded packs beat five weak ones.

---

## What this run did

1. Read prior batch reports + learnings (READY label lies; materials ticks; materials three-state from PR 597; no inventing unit prices).
2. Live board refresh (`makesafe_board` card shape `2026-08-05T12:52Z` / `13:01Z`): preferred MLB/AJ **physical** cards with **submitted** trade reports; skipped empty Report Ready shells.
3. Per candidate: trade evidence from `job_detail` + service report checklist; elevated paragraph prose; wiki render → attach → `bind_current_cycle_curated_makesafe_report` → `prepare_ses_docket_revision` → (when pack ready) `prepare_ses_invoice_obligation` + `create_ses_invoice_draft` with full live ACCREC scan.
4. Verified served report **pdftotext**: photo counts vs current-cycle media; materials not tick-dump; no em dashes.
5. **No** send / approve / authorise / void / trade-evidence edit / photo cull / board placement change / migration.

---

## Green packs (detail)

### 1) SWMS-261139 — Swanbourne — AJBR-70554 — INV-1139 $176.00

| Field | Value |
|---|---|
| Family | physical make-safe (AJ / `ajs_labour_materials`) |
| Trade | Roof / tarp; storm/wind; replaced failed tarp with make-safe tarp secured with screws |
| Materials (report) | **Make safe tarp x 8m2** (quantified; no tick dump) |
| Materials (invoice) | **Not charged** — AJS basis still only prices the picket carve-out; non-picket materials stay off the invoice (existing product behaviour, not silent MLB labour-only) |
| Hours | 1 trade × 2h (AJS floor 2h; not raised) → **$160 ex / $176 inc** |
| Photos | **13 / 13** current-cycle media; `Photo evidence 1..13` in served PDF |
| Bind | `source_kind=durable_curated_revision`, expected raw `sha256:94c36898…a03bde` |
| Pack | prepare `state=ready`, blockers `[]`, persisted |
| Mint | `create_ses_invoice_draft`; full live ACCREC scan **`scanned_accrec: 1164`**; **INV-1139 DRAFT $176**; `send_dispatched: false` |
| Cockpit | **APPROVE INVOICE enabled**; status HOLD only because AJS `report_invoice` route wants real invoice PDF on the two-doc route (same class as Attadale INV-1133) |

**Elevated wording (serving):**

| Section | Text |
|---|---|
| Scope | Make safe the roof by replacing the failed tarp. |
| Findings | Storm / wind. Previous contractor had a tarp secured using flashing tape; that tarp had come down and needed replacement. |
| Works | Replaced the standard tarp with a make-safe tarp, secured using screws on the roof. |
| Materials | Make safe tarp x 8m2. |

---

### 2) SWMS-261025 — Koondoola — MLB-27093 — INV-1140 $280.50

| Field | Value |
|---|---|
| Family | physical make-safe (MLB) |
| Cycle | **Current cycle only** (reattend ×3 on this card). Moisture re-check after fans/dehumidifier week. |
| Trade | Moisture inside walkway/kitchen walls; meter re-check; walls slightly drier, still moist |
| Materials (trade) | Only checklist ticks (`Temp fence panels`, `Bases / feet`, `Tarps / roof materials`, `Fixings / consumables`, `Other / none`) |
| Materials (invoice) | **NONE decision** recorded (`materials_charge` amount 0, decision_key `next-five-draft-packs-v1-SWMS-261025-ticks-none`) — deliberate labour-only, not silent omission |
| Materials (report) | **No materials supplied** after superseding re-bind (first bind had printed ticks; corrected) |
| Hours | Trade 2h → MLB floor **3h** @ $85 → **$255 ex / $280.50 inc** |
| Photos | **50 / 50** current-cycle (122 media across all cycles; only current cycle in pack) |
| Bind | Superseding clean bind expected raw `sha256:159c0815…6c9ab0`; report input hash updated |
| Pack | prepare `state=ready`, blockers `[]` after clean re-bind |
| Mint | ACCREC scan **`scanned_accrec: 1165`**; **INV-1140 DRAFT $280.50**; `send_dispatched: false` |
| Cockpit | **`INVOICE_CREATE_READY`**, verdict clean, **APPROVE enabled**; SEND off until authorise |

**Sibling note:** SWMS-261024 shares claim-only grain `MLB-27093` but carries WO/PO **MLB-27093PO-56479** and a historical invoice PDF **INV-1081** on the document row. This mint is claim-ref `MLB-27093` for the reattend card only. Full ACCREC guard allowed create; do not remint 261024 under the same claim-only string without a PO-grain decision.

**Elevated wording (serving after clean re-bind):**

| Section | Text |
|---|---|
| Scope | Reattendance: re-check moisture in walls after drying equipment was installed. |
| Findings | Storm / wind. Moisture inside walls of walkway and kitchen. |
| Works | Reattended and checked water-ingress walls with a moisture meter after 3 fans and a dehumidifier the week prior. Walls slightly dried but still have moisture and need further drying. |
| Materials | No materials supplied. |

---

## Named blockers (honest)

| Card | Suburb | Family | Blocker | Evidence |
|---|---|---|---|---|
| **SWMS-261147** | Mosman Park | physical | **`materials_charge_figure_required`** | Elevated report **bound** (15/15 photos; timber/ply/screws on PDF). Prepare blocked until Captain one figure (or explicit NONE). No labour-only mint. |
| **SWMS-261134** | Hillarys | restoration | **`curated_bind_family_not_eligible`** | Bind: “only a physical make-safe job may bind a makesafe_report source”. Recipe is physical-shaped for pricing, but curated bind gate is still physical-only. |
| **SWMS-261029** | Midland | repair | **`curated_bind_family_not_eligible`** | Same bind refusal as Hillarys (seen earlier today too). |
| **SWMS-261024** | Koondoola | physical | **`swms_generation_facts_missing`** (crew) + **`materials_charge_figure_required`** (dehumidifier ×1, fans ×3, green tape ×15m) | Existing cycle curated bind conflicts with a second document bind. Sibling of INV-1140 claim. |
| **SWMS-26804** | Booragoon | physical | **Spine** (`spine_missing_lineage` / source / deliverables / SWMS facts / invoice ref) | Elevated PDF path not chaseable until state-seed / spine repair. |
| Empty shells | various | assessment/roof | No submitted trade report | Ten-ish Report Ready cards still DRAFT-without-pack shells — not candidates. |

---

## Mint / money cleanliness

| Card | Result | Scanned ACCREC | New invoice? |
|---|---|---:|---|
| SWMS-261139 | INV-1139 DRAFT $176 | **1164** | **Yes** |
| SWMS-261025 | INV-1140 DRAFT $280.50 | **1165** | **Yes** |
| SWMS-261147 | not attempted | — | **No** (materials figure required) |

Every mint used `create_ses_invoice_draft` (full live ACCREC `fetchAllAccrecInvoices` + `resolveExistingInvoice` before create).

---

## Evidence checks that prevented false greens

| Trap | Check | Result |
|---|---|---|
| READY on incomplete photos | `Photo evidence N` count vs current-cycle `job_media` | 261139 13=13; 261025 50=50; 261147 15=15 |
| Materials tick-box prose | pdftotext Materials section | 261139 tarp only; 261025 corrected to “No materials supplied”; 261147 real quantified items only |
| Silent labour-only with materials | PR 597 gate | 261147 correctly blocked; 261025 ticks → explicit NONE decision |
| Repair/restoration bind | bind action | 261134 / 261029 refused family — not forced |
| Em dashes | pdftotext | **None** on the three bound reports |
| `report_pack` on board | Not used | Cockpit + docket revision only |

Proof files: `data/next-five-draft-packs-v1/proof/`.

---

## Boundaries held

- No SEND / APPROVE / AUTHORISE / VOID  
- No trade attendance edits; sealed rates/floors untouched  
- No inventing materials unit prices  
- No photo cull / downscale of stored media (renderer embed only)  
- No money-fence / bind-gate / board-placement product changes  
- No migration  
- Full live ACCREC on every mint  

---

## Open product notes (not this worker)

1. **Curated bind family gate** still refuses repair/restoration even though recipes are physical-shaped — blocks Midland/Hillarys packs until widened.  
2. **AJS non-picket materials** still omit from invoice (tarp on Swanbourne report). Same class of defect as MLB materials guard, out of this slice.  
3. **Koondoola claim-only `MLB-27093`** vs sibling PO grain on 261024 — Captain should confirm invoice ownership before sending INV-1140 if both cards should bill separately.
