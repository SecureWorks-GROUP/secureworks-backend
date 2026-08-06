# MLB two report jobs v1

Date: 2026-08-06  
Branch: `fm/mlb-two-report-jobs-v1`  
Mode: **report-only operations** (no product code, no migration, no send, no approve, no authorise, no void, no mint, no reprice)  
Cards: **C** Koondoola SWMS-261025 / MLB-27093; **D** Mosman Park SWMS-261147 / MLB-27482

## Captain targets vs landed

| Card | Job | Suburb | Report | Money | Landed |
| --- | --- | --- | --- | --- | --- |
| **C** | `9d7e35ae-…` SWMS-261025 | Koondoola | Multi-return rewrite bound + serving | **INV-1140 DRAFT $280.50 untouched** | Yes |
| **D** | `762ebaad-…` SWMS-261147 | Mosman Park | Elevated report already bound; re-verified serving | Materials figure **still open** (no invent) | Yes |

**No send / approve / authorise / void / mint / reprice. No photo cull. No trade evidence edit. No money-fence or bind-gate weaken.**

---

# Card C — Koondoola / SWMS-261025 / MLB-27093 / INV-1140

| Field | Value |
| --- | --- |
| Job | `9d7e35ae-94b9-4142-a28b-61ea6c7dccb6` |
| Job number | SWMS-261025 |
| Builder ref | MLB-27093 (invoice) / grain `MLB:PO-56481` |
| Family | physical make-safe (MLB) |
| Attendances | **4** submitted service reports (see `C/attendance-records.json`) |
| Photos | **50 / 50** current-cycle only (no cull) |
| Invoice | **INV-1140 DRAFT $280.50** before and after |

## Multi-return report text (builder-facing)

### Work Order Scope

Make safe water ingress from a burst pipe and the resulting moisture in walls, across multiple attendances at this property.

### Site Findings

Burst water pipe and wet insulation in the roof space on the first attendance. Later attendances recorded moisture still inside the walkway and kitchen walls, including high moisture that was not escaping with drying equipment in place.

### Works Completed

SecureWorks attended this property four times.

On 22 July 2026 one trade investigated major water ingress, found a burst water pipe, informed MLB on an urgent call for a plumber, removed all wet insulation from the roof space, and disposed of 10 bags of wet insulation.

On 24 July 2026 one trade reattended and checked the water-ingress walls with a moisture meter to see if the walls were dry or drier after 3 fans and a dehumidifier had been installed. The walls had slightly dried but still had moisture inside and needed longer drying time.

On 29 July 2026 one trade scraped back the render off the brick hallway wall, above the kitchen sink, and beside the kitchen cupboard, to allow the moisture in the wall to dry out.

On 31 July 2026 one trade checked the moisture reading of the wall, uninstalled the 3 fans and dehumidifier, and returned the equipment.

### Materials and Equipment

No materials supplied.

### Crew (header)

1 trade per attendance (4 attendances)

## Attribution (what each sentence rests on)

| Claim | Source |
| --- | --- |
| Four attendances | Four submitted `job_service_reports` on this job |
| 22 Jul: burst pipe, MLB plumber call, wet insulation removed, 10 bags | SR arrival `2026-07-22 14:43` `work_done` (+ materials `Bin bags x 10`, not printed: current-cycle materials gate) |
| 24 Jul: moisture meter re-check after 3 fans + dehumidifier; walls slightly dried, still moist | SR arrival `2026-07-24 13:43` `work_done` |
| 29 Jul: scrape render hallway / above sink / beside cupboard for drying | SR arrival `2026-07-29 10:27` `work_done` |
| 31 Jul: moisture reading; uninstall 3 fans + dehumidifier; return equipment | SR arrival `2026-07-31 16:11` `work_done` |
| Findings moisture walkway/kitchen + high moisture with equipment | SR damage fields across visits |
| Materials "No materials supplied" | Current-cycle `materials_used` are checklist ticks only → bind `none_recorded` |
| **Not written** | Invented single "why they keep returning" beyond the sequence; claim that *this* card installed the fans; commercial hours; em dashes; bullets |

Full attribution JSON: `C/attribution.json`. Attendance extract: `C/attendance-records.json`.

## Path executed

1. Offline wiki render at authoritative `915e9b423fc597d656c7cb090671bf206138114b` (script SHA `fda63bcf…` = `MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256`)
2. `attach_makesafe_document` on cycle-owning document `55ae5c93-…` / same file name (first attempt on sibling doc `1543ef86-…` correctly refused `curated_bind_cycle_conflict`)
3. `bind_current_cycle_curated_makesafe_report` — eight gates; **`supersedes_prior_bind: true`**
4. `prepare_ses_docket_revision` with materials **NONE** decision (ticks only) so pack stays ready — **INV-1140 not reminted**

## Bind proof

| Field | Value |
| --- | --- |
| Document | `55ae5c93-0b3f-4ce6-a1c0-acd4557d1954` version **6** |
| Cycle | `30198e44-…` **bound** |
| `source_kind` | `durable_curated_revision` |
| `supersedes_prior_bind` | **true** |
| Curation revision | `ses-curated-report:SWMS-261025:2026-08-06-mlb-two-report-jobs-v1-multi-return` |
| Renderer | `secureworks.wiki-python/915e9b42…` |
| Local / served / bound raw SHA | `sha256:4d27982b90d952a73cbb93e16453912a65d6e7a4f4f34588727fbe77775d68a5` |
| Three-way hash match | **Pass** (`C/report-hash-proof.json`) |
| Photos | **50/50** current-cycle |

## Pack after re-prepare

| Field | Value |
| --- | --- |
| Docket revision | `81c6a74c-c2b3-5604-8ca4-603b034b0c95` |
| State | **ready** |
| Blockers | `[]` |
| Presentation | `kind: ready`, `review_state: READY`, `pre_xero_docs_ready: true` |
| Supporting report role | present on reviewable pack (`supporting_report_pdf`) |
| Xero invoice PDF | present (existing INV-1140) |

## Invoice total untouched

| Invoice | Status | Total | Reference |
| --- | --- | --- | --- |
| **INV-1140** | **DRAFT** | **280.50** | MLB-27093 |

Before and after job_detail reads agree. **No void, remint, reprice, authorise, or send.**

Local docket labour proposal remains the current-cycle floor (1×3h @ $85) under materials NONE — that is not INV-1140 and was not written to Xero. Commercial remint is out of scope.

---

# Card D — Mosman Park / SWMS-261147 / MLB-27482

| Field | Value |
| --- | --- |
| Job | `762ebaad-5f6f-4477-acb7-30db016b15ea` |
| Job number | SWMS-261147 |
| Builder ref | MLB-27482 / WO MLB-27482PO-57866 |
| Family | physical make-safe (MLB) |
| Attendances | **1** |
| Photos | **15 / 15** |
| Invoice | **none** (materials figure still required) |

## Report text (already elevated; re-verified serving)

### Work Order Scope

Make safe the smashed bedroom window and roller door.

### Site Findings

Fire. Completely smashed bedroom window and smashed roller door around the handle. Glass shattered around the window area.

### Works Completed

Cleaned up glass shards and removed glass still in the bedroom window frame. Taped any sharp edges on the roller door and removed any loose glass. Framed both the bedroom window and sliding door, then screwed plyboard onto the frame creating a secure board-up.

### Materials and Equipment

Structural timber x 8m  
Plyboard 12mm 2.4x1.8 x 3  
Screws x 40

### Crew

1 trade

## Attribution

| Claim | Source |
| --- | --- |
| Scope board-up of smashed bedroom window and roller door | Trade `job_type_detail` / `work_done` |
| Fire; smashed window; smashed roller door handle; glass around window | SR `damage_cause` / `damage_description` |
| Clean glass, tape sharp edges, frame window and sliding door, screw plyboard board-up, dispose glass | SR `work_done` (prose polish only) |
| Timber 8m / ply ×3 / screws ×40 | SR `materials_used` quantified (ticks stripped) |
| Money open | prepare still `materials_charge_figure_required` |

## Delivery to review surface without forcing money

| Field | Value |
| --- | --- |
| Document | `71f64d51-…` version **2** |
| Served raw SHA | `sha256:359775313575658bd0c018bf871ec100989afad0df907cf634483d7323908553` |
| Matches prior next-five bind | **Yes** |
| Served URL | public job-documents path for this file name |
| Prepare dry/live | **blocked** `materials_charge_figure_required` |
| Docket revision (blocked pack) | `8d2e8179-23be-5fdf-90fe-707fcd5d7021` persisted |
| Named materials for Captain | timber 8m; plyboard 12mm 2.4x1.8 ×3; screws ×40 |
| Materials guard | **not** weakened; figure **not** invented; invoice **not** minted |

`get_ses_reviewable_pack` without a ready docket refuses; that is expected while money is open. The **bound report PDF itself is available** on the document row (hash-proved above) for WA review. Money waits on the Captain's one materials figure (or explicit NONE).

---

## Boundaries held

- No send / approve / authorise / void / mint / reprice
- No trade attendance edit; no photo cull
- No sealed-SES money fence, curated-bind gate, or send-gate weaken
- Swanbourne, Attadale, Maylands, Bertram, Munster, Queens Park, Gidgegannup, Ballajura, Woodvale, Carine **not touched**
- No migration; no product code change
- Ledger is **pdftotext + proof JSON only** (no binary PDFs)

## Ledger files

- `report.md` (this file)
- `C/` — multi-return bind proofs, attribution, attendance records, redacted pdftotext, pack summary
- `D/` — report hash proof, attribution, prepare slim blockers, pdftotext
