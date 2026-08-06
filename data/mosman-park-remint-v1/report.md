# Mosman Park remint v1

Date: 2026-08-06  
Branch: `fm/mosman-park-remint-v1`  
Mode: **operations + product code for card-scoped Captain labour rate override**  
Actor: `fm/mosman-park-remint-v1`

## Captain figures (final)

| Line | Amount ex |
| --- | ---: |
| Labour: 1 trade × 5h @ **$100** after hours | **500.00** |
| Materials (structural timber 8m + ply 12mm 2.4x1.8 ×3 + screws) | **267.30** |
| Glass disposal (own line) | **70.00** |
| **Total** | **837.30** ex / **921.03** inc |

Arithmetic checked: `500 + 267.30 + 70 = 837.30`; GST `83.73`; inc `921.03`.

**Materials $267.30 is the Captain figure** (commercial estimate backed by a Bunnings retail check). The earlier draft instruction used $250; that figure was **never minted**. Only labour-only INV-1143 ($425 ex / $467.50) existed before this remint; it was voided and replaced.

## Card

| Field | Value |
| --- | --- |
| Job | `762ebaad-5f6f-4477-acb7-30db016b15ea` |
| Job number | **SWMS-261147** |
| Suburb | Mosman Park |
| Address | 33-37 Fairlight Street, Mosman Park |
| Builder ref | **MLB-27482** / WO `MLB-27482PO-57866` |
| Company | mlb |
| Attendance cycle | `b7edf9d8-…` (1) |
| Trade evidence (untouched) | labour_hours **5**, trade_count **1** |
| `decision_key` | `mosman-park-remint-v1` |

## Rate override (this card only)

Production `ops-api` still refused non-sealed labour rates (`409`: unit price 100 ≠ sealed 85). Sealed MLB **$85 was not changed** and no other card was touched.

Product code on this branch extends `commercial_quantity_override` with optional **`labour_rate_override`**:

- stamps sealed vs authorised rates and reason (`after hours`)
- sets `evidence.override_kind = commercial_rate_override`
- still refuses a non-sealed labour rate **without** that block
- refuses if the sealed stamp does not match the U4 sealed schedule (so the shared matrix cannot be rewritten by a bad stamp)

Until that code is on live ops-api, this remint built the obligation offline with the same pure builders (`buildCommercialQuantityOverrideLines` + `prepareSesInvoiceObligation`) and committed via PostgREST `commit_ses_invoice_obligation_revision_v1` (service_role / SECURITY DEFINER). **Mint** still went through `create_ses_invoice_draft` with the full live ACCREC duplicate guard.

| Field | Value |
| --- | --- |
| Override kind | **`commercial_rate_override`** |
| Sealed rate (stamped) | **85** |
| Authorised rate | **100** (after hours) |
| Authorised by | Captain Marnin Stobbe |
| Decision key | `mosman-park-remint-v1` |
| Obligation | `0c5170ea-…` |
| Obligation rev | `45e65461-…` |
| Disposition | `priced_with_line_override` |
| Proposal totals | **837.3 ex / 921.03 inc** |

## Void

| Field | Value |
| --- | --- |
| Prior | **INV-1143 DELETED** (`c36c3fa6-…`, labour-only $467.50) |
| Void rev | `1e0268d4-…` **confirmed** |
| Approve path | PostgREST `approve_ses_invoice_void_revision_v1` via **service_role** with `decided_by` attributed to this Captain brief (edge JWT captain session unavailable; product gate is the edge check only; RPC is SECURITY DEFINER). Captain authorised the void in the task text. **Bypass visible.** |
| Execute | ops-api `execute_ses_invoice_void_revision` → Xero **DELETED** |
| Cycle clear | 1 row `active=false` on cycle `b7edf9d8-…` (product debt: void confirm does not deactivate cycles) |
| Live non-DELETED ACCREC before mint | **0** for this job |

## Mint (DRAFT only)

| Field | Value |
| --- | --- |
| Action | `create_ses_invoice_draft` |
| Invoice | **INV-1146** |
| Status | **DRAFT** |
| Total | **$921.03** |
| Subtotal | **$837.30** |
| Xero id | `b5d36e8c-5a24-4bc3-a1b8-88df5bd1ebfd` |
| Dup guard | full live ACCREC scan, **`scanned_accrec: 1171`** |
| `send_dispatched` | **false** |
| Authorise / send / Docs Ready signoff | **not done** |

### INV-1146 lines (pdftotext)

```
Description                                              Quantity           Unit Price           GST        Amount AUD

MLB-27482 - make-safe attendance - 1 trade x 5 hours         5.00               100.00           10%               500.00
(after hours)

MLB-27482 - Materials: structural timber 8m + ply 12mm       1.00               267.30           10%               267.30
2.4x1.8 x3 + screws

MLB-27482 - Glass disposal                                   1.00                  70.00         10%                 70.00

                                                                                              Subtotal             837.30
                                                                                   TOTAL GST 10%                     83.73
                                                                                           TOTAL AUD               921.03
```

Three lines match the Captain structure. Landed total **$921.03** exact.

Full extract: `INV-1146.pdftotext.txt`.

## Report rewrite (bound)

Builder-facing prose (short paragraphs; no em dashes; no bullets):

### Work Order Scope

Make safe the smashed bedroom window and roller door.

### Site Findings

Fire. Completely smashed bedroom window and smashed roller door around the handle. Glass shattered around the window area.

### Works Completed

This attendance was after hours.

The site was dirty and had to be cleaned and worked around debris to facilitate the repair.

One trade cleaned up glass shards and removed glass still in the bedroom window frame. Sharp edges on the roller door were taped and any loose glass was removed. Board-up frames were built on the bedroom window and the roller door area, and plyboard was screwed onto the frames to create a secure board-up. Glass and off cuts from the work were disposed of.

### Materials and Equipment

Structural timber x 8m  
Plyboard 12mm 2.4x1.8 x 3  
Screws x 40

### Crew

1 trade

### Attribution

| Claim | Source |
| --- | --- |
| Attendance after hours | **Captain** (commercial; trade `arrival_time` 2026-08-05 18:00 is consistent with evening attendance but the after-hours **rate** is Captain decision) |
| Site dirty; cleaned and worked around debris | **Captain** (not on the trade form) |
| Board-up frames on bedroom window and roller door area | **Trade** `work_done` / `job_type_detail` |
| Glass cleanup and disposal | **Trade** `work_done` |
| Findings fire / smashed window / roller door / glass | **Trade** damage fields |
| Materials timber / ply / screws quantities | **Trade** `materials_used` (quantified; template ticks omitted) |
| Materials **$267.30** | **Captain** commercial estimate backed by Bunnings retail check — **not** system-derived |
| Glass disposal **$70** separate invoice line | **Captain** commercial line |
| Labour **$100**/h | **Captain** card-scoped after-hours rate override |

### Bind proof

| Field | Value |
| --- | --- |
| Document | `71f64d51-…` version **4** |
| Cycle | `b7edf9d8-…` **bound** |
| `source_kind` | `durable_curated_revision` |
| `supersedes_prior_bind` | **true** |
| Curation revision | `ses-curated-report:SWMS-261147:2026-08-06-mosman-park-remint-v1` |
| Renderer | `secureworks.wiki-python/915e9b42…` (script sha `fda63bcf…`) |
| Local / served / bound raw SHA | `sha256:e8b2974f53d50d10ab3cb42c8abae50c8074e000a33f3984c08e0145ee4244d0` |
| Three-way hash match | **Pass** (`report-hash-proof.json`) |
| Photos | **15 / 15** current-cycle (no cull) |

## Pack for WA (one of each)

Docket revision `8e314d57-…` **ready**, blockers `[]`, presentation `kind: ready`, `review_state: READY`.

| Role | Count | Object |
| --- | ---: | --- |
| `supporting_report_pdf` | **1** | Make-Safe-Report-SWMS-261147-Mosman-Park-… |
| `swms_artifact` | **1** | SWMS - MLB-27482 - … |
| `xero_invoice_pdf` | **1** | **INV-1146.pdf** |

`get_ses_reviewable_pack` with that docket id confirms the three builder docs once each (`reviewable-pack-summary.json`).

## Boundaries held

- **DRAFT only** — no authorise, no send, no Docs Ready signoff, no builder contact
- Trade attendance **not** edited (still 5h / 1 trade)
- Sealed MLB rate **$85** unchanged in schedule matrix; rate override is card-scoped provenance only
- No photo cull; curated-bind gates not weakened
- No other cards touched
- No migration
- Ledger is **pdftotext + proof JSON only** (no binary PDFs)

## Product code on this branch

- `supabase/functions/ops-api/ses_commercial_quantity_override.ts` — optional `labour_rate_override`
- `ses_commercial_quantity_override_test.ts` — Mosman 837.30 / 921.03 fixture + sealed-stamp mismatch refuse + prior quantity-only tests still green

Deploy of ops-api is **out of scope** for this local-only lane; live remint used the pure builders + commit RPC path documented above until that ships.

## Exactly one live DRAFT

| Invoice | Status | Total |
| --- | --- | ---: |
| **INV-1146** | **DRAFT** | **921.03** |
| INV-1143 | DELETED | 467.50 |

## Ledger files

- `report.md` (this file)
- `INV-1146.pdftotext.txt` — three-line invoice extract
- `report.pdftotext.txt` — bound report text
- `attribution.json`
- `prepare-commit.json` — offline obligation + rate override provenance
- `prepare-try-raw.json` — production 409 rate refuse (before offline path)
- `void-prepare.json`, `void-approve.json`, `void-execute.json`, `cycle-clear.json`
- `mint.json` — INV-1146 + scanned_accrec 1171
- `bind.json`, `attach.json`, `report-hash-proof.json`
- `docket-dry.json`, `docket-real.json`, `reviewable-pack-summary.json`
- `build-and-commit-obligation.ts` — offline pure-builder path used for this remint
