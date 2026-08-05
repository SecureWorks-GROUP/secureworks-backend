# Five-pack elevated blurbs v1

**Date:** 2026-08-05  
**Branch:** `fm/five-pack-elevated-blurbs-v1`  
**Mode:** operations only (no product code, no send, no approve, no authorise, no void)  
**ops-api:** commit `19072b17…`, deployed `2026-08-05T09:02:03Z`  
**Privacy:** suburb + job reference only. No client names, phones, emails, or street addresses.

---

## CAPTAIN — WA delivery list (act on these)

Five packs. Elevated report prose is **actually bound and serving** (not proposed). Each has a Xero **DRAFT** under the full live ACCREC guard. Cockpit **APPROVE INVOICE is enabled** on all five.

What you are approving: **authorise the existing Xero DRAFT** for that card’s SES obligation, then (when you choose) **SEND IT**. Do **not** re-prepare packs first unless something fails after authorise.

| # | Card | Suburb | Builder ref | Invoice | Total inc GST | Photos | What you approve |
|---:|---|---|---|---|---:|---:|---|
| 1 | **SWMS-26953** | Gidgegannup | MLB-25971PO-55855 | **INV-1129** DRAFT | **$280.50** | 9/9 | Authorise INV-1129 then SEND IT (report / photo / invoice). Structural timber under roof HWS. |
| 2 | **SWMS-26902** | Ballajura | MLB-26443 | **INV-1130** DRAFT | **$280.50** | 15/15 | Authorise INV-1130 then SEND IT. Ceiling re-prop with timber + bugles. |
| 3 | **SWMS-261128** | Woodvale | MLB-27335 | **INV-1131** DRAFT | **$280.50** | 28/28 | Authorise INV-1131 then SEND IT. Ridge-cap silicone + flashing tape + batten. |
| 4 | **SWMS-261129** | Carine | MLB-25876 | **INV-1132** DRAFT | **$280.50** | 33/33 | Authorise INV-1132 then SEND IT. Skylight valley tray + tile gaps; tarp removed. |
| 5 | **SWMS-261137** | Attadale | AJBR-70499 | **INV-1133** DRAFT | **$220.00** | 16/16 | Authorise INV-1133. AJS labour 1×2.5h @ $80. Cockpit HOLD only on `report_invoice` route draft readiness (needs authorised/real invoice PDF on the two-doc AJS route) — **APPROVE is still enabled**. |

**Money note (honest):** four MLB cards mint as sealed labour floor only (**1 trade × 3h @ $85 = $255 ex / $280.50 inc**). Trade materials are on the report; they are **not** on these invoices (no commercial quantity override this run). Attadale is AJS floor-honest: trade logged **2.5h** (above 2h floor) → **$200 ex / $220 inc**.

**Do not touch:** SWMS-261080 / 261020 / 261115 (INV-1126/1127/1128 already delivered), Maylands 261017, Bertram 261109, Munster 261065, Queens Park 26845, High Wycombe 261130/261131, claim-only siblings 261021/261116/261079, Tuart 261015.

---

## What changed this run (the point)

Previous batch **proposed** elevated blurbs and left bound report text unchanged.  
This run: offline wiki render (`915e9b42…`) → `attach_makesafe_document` → `bind_current_cycle_curated_makesafe_report` (eight gates intact) → `prepare_ses_docket_revision` → `create_ses_invoice_draft` (full ACCREC scan).

**Proof pattern (every Captain-list card):**

| Check | Result |
|---|---|
| Served PDF raw SHA = bound `expected_raw_sha256` = local render | **Pass** all five |
| `source_kind=durable_curated_revision`, `cycle_attribution=bound` | **Pass** |
| Elevated works text present in served `pdftotext` | **Pass** |
| Em dashes | **None** |
| Photo evidence lines vs current-cycle media | **Exact match** (9/9, 15/15, 28/28, 33/33, 16/16) |
| Materials section | Quantified trade items only (no tick-box dump) |
| Pack prepare | `state=ready`, blockers `[]`, persisted |
| Mint | Full live ACCREC scan (1154–1158 invoices); new DRAFT only |

---

## Per card

### 1) SWMS-26953 — Gidgegannup — MLB-25971PO-55855 — INV-1129 $280.50

**Trade evidence (source of truth)**

- Job type: Other / installation of structural timber  
- Cause: Storm / wind  
- Damage: Hot water system on roof not engineered; timber beams dipped under the weight  
- Work: Secured 2 structural timber pieces with bugle screws from base plate to underpurlin  
- Materials: Timber x 1m, Bugle screws x 5  
- Crew: 1 trade × 2h (floor raised to 3h)

**Bound elevated wording (serving now)**

| Section | Text |
|---|---|
| Scope | Make safe the roof structure under the roof-mounted hot water system. |
| Findings | Storm / wind. The hot water system on the roof is not engineered for the load. Timber beams have dipped under the weight. |
| Works | Fitted two structural timber pieces with bugle screws from the base plate to the underpurlin, giving the roof extra support under the hot water system. |
| Materials | Timber x 1m. Bugle screws x 5. |

**Proof:** served SHA `sha256:5a6842fd…7168`; photos 9/9; cockpit `INVOICE_CREATE_READY`; APPROVE enabled; ACCREC scanned **1154**.

---

### 2) SWMS-26902 — Ballajura — MLB-26443 — INV-1130 $280.50

**Trade evidence**

- Ceiling / water ingress; client worried ceiling cracked further and needed extra support  
- Work: Added timber to ceiling using bugle screws  
- Materials: Timber x 3, Bugle screws x 10  
- 1 trade × 2h → 3h floor

**Bound elevated wording**

| Section | Text |
|---|---|
| Scope | Make safe the ceiling that needed extra support. |
| Findings | Storm / wind. Client reported the ceiling had cracked further and needed extra prop support. |
| Works | Added structural timber to the ceiling using bugle screws. |
| Materials | Timber x 3. Bugle screws x 10. |

**Proof:** served SHA `sha256:a562153c…4778`; photos 15/15; `INVOICE_CREATE_READY`; APPROVE enabled; scanned **1155**.

---

### 3) SWMS-261128 — Woodvale — MLB-27335 — INV-1131 $280.50

**Trade evidence**

- Water ingress into bedroom cupboard corner  
- Work: Siliconed cracked ridge-cap pointing and large tile gaps; flashing-taped larger gaps; resecured unsecured batten  
- Materials: Silicone x 1, Flashing tape x 1m  
- 1 trade × 2h → 3h floor

**Bound elevated wording**

| Section | Text |
|---|---|
| Scope | Make safe water ingress into the bedroom cupboard. |
| Findings | Storm / wind. Water entering the corner of a bedroom cupboard through the roof. |
| Works | Siliconed cracked ridge-cap pointing and large gaps between tiles. Flashing-taped the larger tile gaps. Resecured an unsecured batten. |
| Materials | Silicone x 1. Flashing tape 1 m. |

**Proof:** served SHA `sha256:3873894d…ba24a`; photos 28/28; `INVOICE_CREATE_READY`; APPROVE enabled; scanned **1156**.

---

### 4) SWMS-261129 — Carine — MLB-25876 — INV-1132 $280.50

**Trade evidence**

- Water through skylight into front door walkway; tarp already present but leak continued; sarking cut at skylight  
- Work: Rebent valley tray to ~80° above skylight; flashing-taped and siliconed tile gaps; removed unsecured tiles and tarp  
- Materials: Silicone x 1, Flashing tape x 0.4m  
- 1 trade × 2h → 3h floor

**Bound elevated wording**

| Section | Text |
|---|---|
| Scope | Make safe water ingress through the skylight into the front door walkway. |
| Findings | Storm / wind. Water entering through the skylight into the front door walkway. A tarp was already on the roof but the leak continued. Sarking is installed and is cut at the skylight, so water was entering from above the skylight. |
| Works | Above the skylight, rebent the valley tray to about 80 degrees. Flashing-taped and siliconed tiles with large gaps at the joins. Removed unsecured tiles and the tarp from the roof. |
| Materials | Silicone x 1. Flashing tape 0.4 m. |

**Proof:** served SHA `sha256:fc9fdf7b…63689`; photos 33/33; `INVOICE_CREATE_READY`; APPROVE enabled; scanned **1157**.

---

### 5) SWMS-261137 — Attadale — AJBR-70499 — INV-1133 $220.00

**Trade evidence**

- Corner of ceiling in living/kitchen drooping, not connected to joists  
- Work: Propped with acro props and structural timber planks; planks screwed into top of acro props  
- Materials: Acro prop x 2, Timber x 2, Screws x 2  
- 1 trade × **2.5h** (above AJS 2h floor; not raised)

**Bound elevated wording**

| Section | Text |
|---|---|
| Scope | Make safe the drooping ceiling in the kitchen / living area. |
| Findings | Storm / wind. Corner of the ceiling in the living / kitchen space is drooping and not connected to the joists above. |
| Works | Propped the falling ceiling in the corner of the kitchen / living space with acro props and structural timber planks. Planks are screwed into the top of the acro props. |
| Materials | Acro prop x 2. Timber x 2. Screws x 2. |

**Invoice lines:** `1 trade x 2.5 hours` @ $80 = $200 ex / $220 inc.  
**Proof:** served SHA `sha256:37b3779c…8fb28`; photos 16/16; APPROVE enabled; scanned **1158**.  
**Cockpit HOLD:** only `route_draft_missing` on AJS `report_invoice` (wants report + real Xero PDF on that route; SEND stays off until authorise/route ready). Elevated report + SWMS + DRAFT are real.

---

## Named refusals / non-counts (honest)

| Card | Why it does not count as a fifth green pack without caveat |
|---|---|
| **SWMS-261029 Midland** (repair) | Bind refused `curated_bind_family_not_eligible` — “only a physical make-safe job may bind a makesafe_report source”. PDF was rendered and attached; **not** trusted. |
| **SWMS-26955 Herne Hill** | Elevated report **bound** (honest dog / smashed glass door wording, supersession v2). Existing **INV-0994 AUTHORISED $990** — mint correctly refused `invoice_duplicate_live`. Cockpit HOLD on money/pricing. Report work done; not a clean DRAFT pack for this list. |
| **SWMS-26804 Booragoon** | Elevated report bound; prepare blocked on **spine** (`spine_missing_lineage` / `source_content_hash` class + SWMS builder ref). Needs state-seed / spine repair — not chased green. |
| Claim-only siblings / Tuart | Left alone per brief (Captain money decisions). |

---

## Boundaries held

- No SEND / APPROVE / AUTHORISE / VOID  
- No trade attendance edits; no commercial override this run  
- No photo cull / downscale of stored media (PDF embed compression only, per wiki renderer)  
- No money-fence / bind-gate / board-placement changes  
- No migration  
- Full live ACCREC on every mint  
- Task evidence in firstmate home only; no agent Co-Authored-By  

---

## Bottom line

**Five packs with elevated wording actually serving on the bound report PDF**, plus DRAFT invoices for WA delivery review.  
Four MLB cards are cockpit-clean `INVOICE_CREATE_READY`. Attadale is AJS with APPROVE enabled and a single route-draft hold that clears after money authorise / route rebind — not a fake green.

Fewer padded greens: Midland / Booragoon / Herne money path are named stops, not forced.
