# Gidgegannup report redo v1

Date: 2026-08-05  
Branch: `fm/gidge-report-redo-v1`  
Mode: **report-only operations** (no product code, no migration, no send, no approve, no authorise, no void, no mint, no reprice)  
Card: `d34b779e-e2f4-4f22-bc0b-9131b7e24997` / **SWMS-26953** / Gidgegannup / MLB-25971PO-55855  
Invoice: **INV-1135 DRAFT $1,078.00** (untouched)

## Why this run

INV-1135 already bills two attendances (2 trades × 3h, then 1 trade × 5h) plus $45 materials. The builder-facing report needed a fuller, claims-file narrative so the two visits are defensible from insufficient work-order communication, without inventing facts beyond the Captain's account and the trade evidence already on the card.

Prepare was refusing `materials_charge_figure_required` even though INV-1135 already carries $45 materials. Resolved by **setting** the materials decision to $45 (PR 597 three-state path). Guard left intact.

## Full new report text (builder-facing)

### Work Order Scope

Make safe the roof structure under the roof-mounted hot water system.

### Site Findings

Storm / wind. The hot water system on the roof is not engineered for the load. Timber beams have dipped under the weight.

### Works Completed

The work order as received asked SecureWorks to prop a patio post in the veranda. That was a custom and unclear scope for the site.

First attendance was after hours. No builder staff were on site to clarify the intended work, and both the attending trade and the homeowner were unclear what SecureWorks was required to do. The attending trade looked in the manhole and on the roof to assess what was necessary. The work could not proceed that visit.

The job manager was contacted after the first visit and clarified the actual problem: the roof structure under the roof-mounted hot water system, where timber had dipped under the load.

On reattendance, one trade completed the make-safe. Two structural timber pieces were fitted with bugle screws from the base plate to the underpurlin, giving the roof extra support under the hot water system.

### Materials and Equipment

Timber x 1m  
Bugle screws x 5

### Crew (header)

2 trades first visit; 1 trade reattendance

Property on the PDF is `jobs.site_address` only: `11 Crest Side Cl`. Contact redacted in ledger extract (`SWMS-26953-report.pdftotext.txt`).

## Attribution (Captain vs trade)

| Sentence / claim | Source |
| --- | --- |
| Work order asked to prop a patio post in the veranda; custom and unclear scope | **Captain** |
| First attendance was after hours | **Captain** (consistent with cycle-1 `arrival_time` 2026-07-10 17:26) |
| No builder staff on site to clarify | **Captain** |
| Trade and homeowner both unclear what was required | **Captain** |
| Attending trade looked in the manhole and on the roof to assess what was necessary | **Trade** cycle-1 `work_done`: "Looked in man hole/on their roof and assed what was necessary…" |
| The work could not proceed that visit | **Captain** consequence of unclear scope / no staff for clarity (not a claimed activity) |
| Job manager contacted after first visit; clarified real problem | **Captain** |
| Real problem = roof structure under roof-mounted HWS; timber dipped under load | **Captain** clarification kept consistent with **trade** cycle-2 `damage_description` / elevated findings |
| Reattendance with one trade completed timber and bugle work | **Captain** + **trade** cycle-2 `trade_count: 1` and `work_done` |
| Two structural timber pieces with bugle screws base plate to underpurlin under HWS | **Trade** cycle-2 `work_done` |
| Materials Timber x 1m / Bugle screws x 5 | **Trade** cycle-2 `materials_used` (quantified only; template ticks omitted) |
| Scope / findings HWS load / dipped timber / storm-wind | **Trade** damage fields (prior elevated wording retained) |
| Crew 2 then 1 | **Trade** service-report `trade_count` |

### Sentence check (Captain challenge)

**Removed (invented):** "The crew inspected the roof space and left when the work could not be confirmed against a clear instruction."

- Captain never said that leave-reason or "roof space" phrasing.
- Cycle-1 trade **does** record looking in the manhole and on the roof and assessing what was necessary; that activity is kept in trade wording.
- The invented bridge ("could not be confirmed against a clear instruction") is gone. Closing fact: "The work could not proceed that visit."

**Not written:** builder blame, sarcasm, incompetence language, commercial hours (3h / 5h stay on INV-1135 only), invented measurements, hazard classifications, or quantities beyond trade materials. No em dashes.

## Path executed

1. Offline wiki render at authoritative `915e9b423fc597d656c7cb090671bf206138114b` (script SHA `fda63bcf…` = `MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256`)
2. `attach_makesafe_document` on the **same** document id / file name (idempotent overwrite)
3. `bind_current_cycle_curated_makesafe_report` (eight gates; `supersedes_prior_bind: true`)
4. `prepare_ses_docket_revision` with body `materials_charge` SET to **$45** ex GST (`decision_key: gidge-report-redo-v1-materials-45`)

## Bind proof

| Field | Value |
| --- | --- |
| Document | `883a4b6e-…` version **8** |
| Cycle | `5c0c8a6b-…` **bound** |
| `source_kind` | `durable_curated_revision` |
| `supersedes_prior_bind` | **true** |
| Curation revision | `ses-curated-report:SWMS-26953:2026-08-05-two-visit-justify-v2` |
| Renderer | `secureworks.wiki-python/915e9b42…` |
| Local / served / bound raw SHA | `sha256:8b7a689a912e2aa734ae56fb9763f0f3f098137c0e98261a156d0b453384c3be` |
| Three-way hash match | **Pass** (`report-hash-proof.json`) |
| Photos | **9/9** current-cycle (reattendance), no cull |

## Materials decision

| Field | Value |
| --- | --- |
| Without `materials_charge` | prepare **blocked** `materials_charge_figure_required` |
| With SET $45 | prepare **ready**, blockers `[]` |
| Schema | `secureworks.makesafe.materials-charge-figure/v1` |
| Figure | **45** ex GST (matches INV-1135 materials line) |
| Guard | **not** weakened or bypassed |

## Pack after re-prepare

| Field | Value |
| --- | --- |
| Docket revision | `d1e39c05-7a86-5b73-8738-bba73003efe8` |
| State | **ready** |
| Blockers | `[]` |
| Persisted | true |

### Builder documents served (once each)

| Role | Count | Object | Notes |
| --- | --- | --- | --- |
| `supporting_report_pdf` | **1** | `…/Make-Safe-Report-SWMS-26953-Gidgegannup-5a6842fd4c0d.pdf` | raw SHA matches bind |
| `xero_invoice_pdf` | **1** | `…/INV-1135.pdf` | locked invoice |
| `swms_artifact` | **1** | `…/SWMS - MLB-25971PO-55855 - …pdf` | one SWMS |

No duplicate report / invoice / SWMS files. Full role census: `reviewable-pack-summary.json`. Pack download hashes: `pack-doc-hash-proof.json`.

## Invoice total untouched

Live `xero_invoices` for this job (non-DELETED):

| Invoice | Status | Total | Reference |
| --- | --- | --- | --- |
| **INV-1135** | **DRAFT** | **1078.00** | MLB-25971PO-55855 |

pdftotext of the pack-served INV-1135 PDF:

```
MLB-25971 - initial attendance - 2 trades x 3 hours       6.00    85.00    510.00
MLB-25971 - reattendance - 1 trade x 5 hours              5.00    85.00    425.00
MLB-25971 - Materials: timber and bugle screws            1.00    45.00     45.00
Subtotal 980.00 / GST 98.00 / TOTAL AUD 1,078.00
```

**No void, remint, reprice, authorise, or send.**

### Honest note on local docket proposal

`prepare_ses_docket_revision` re-derives a **local** `invoice_proposal` from current-cycle trade facts plus the SET materials figure (here labour floor 1×3h @ $85 + $45 materials = $330). That local proposal is **not** INV-1135 and was not written to Xero. The pack serves the existing **Xero** DRAFT at **$1,078.00**. Commercial remint is out of scope for this report-only task.

## Boundaries held

- No send / approve / authorise / void / mint / reprice
- No trade attendance edit
- No photo cull
- No sealed-SES money fence, curated-bind gate, or send-gate weaken
- Maylands / Bertram / Munster / Queens Park / other cards not touched
- No migration
- No product code change

## Ledger files

- `report-job.json` / `bind-report-job.json` — render/bind narratives + attribution
- `bind.json` / `attach.json` — API results
- `report-hash-proof.json` / `pack-doc-hash-proof.json` / `reviewable-pack-summary.json`
- `prepare-dry.json` / `prepare-real.json` — slim prepare results
- `SWMS-26953-report.pdftotext.txt` — served report extract (contact redacted)
- `INV-1135.pdftotext.txt` — pack-served invoice extract
- `photo-meta.json` — photo ids + content SHAs only (no binary)
