# AJS two-card commercial remint v1

Date: 2026-08-06  
Mode: **operations only** (no product code change; no migration)  
Actor: `fm/ajs-two-card-remint-v1`  
Path: same as commercial-remint-three-cards / Maylands / four-card materials remint ledgers  

## Captain instruction (verbatim targets)

| Card | Job | Old DRAFT | Target | Landed | Match |
| --- | --- | --- | --- | --- | --- |
| A Swanbourne AJBR-70554 | `b8c08b16-…` SWMS-261139 | INV-1139 $176 DELETED | **$365 ex / $401.50 inc** | **INV-1141 DRAFT $401.50** | exact |
| B Attadale AJBR-70499 | `8c4f5c42-…` SWMS-261137 | INV-1133 $220 DELETED | **$525 ex / $577.50 inc** | **INV-1142 DRAFT $577.50** | exact |

Arithmetic rechecked: A `240+110+15=365`; B `240+240+45=525`. GST 10% on both.

## What was NOT done

- **No authorise, no send, no Docs Ready signoff, no builder contact**
- **Trade attendance evidence not edited** (A still labour_hours **2**; B still **2.5**)
- AJS sealed labour rate **$80** unchanged (`override_kind: commercial_quantity_not_rate`)
- No photo cull; eight-gate curated bind intact on B
- MLB / Maylands / Bertram / Munster / Queens Park untouched
- No migration

## Shared operational path (per card)

1. `prepare_ses_invoice_void_revision` (api_key) → DRAFT target **DELETED**
2. Management/PostgREST `approve_ses_invoice_void_revision_v1` with `decided_by` attributed to this Captain brief (edge JWT captain session unavailable to the crewmate; product gate is the edge check only; RPC is SECURITY DEFINER). Captain authorised voids in the task text.
3. `execute_ses_invoice_void_revision` → Xero DELETED + local confirmed
4. PostgREST cycle clear (`makesafe_invoice_obligation_cycles.active=false`) — product debt: void confirm does not deactivate the cycle
5. Card B only: wiki render `915e9b42…` → `attach_makesafe_document` (same file name) → `bind_current_cycle_curated_makesafe_report` (eight gates; supersession)
6. `prepare_ses_invoice_obligation` + `commercial_quantity_override` (`priced_with_line_override`)
7. `create_ses_invoice_draft` (full live ACCREC scan)
8. `prepare_ses_docket_revision` dry then real (`selection.mode=job_id`) → pack **ready**, blockers `[]`

Ledger evidence is **pdftotext extract + proof JSON only** (no binary PDFs in repo).

---

# Card A — AJBR-70554 / SWMS-261139 / Swanbourne

| Field | Value |
| --- | --- |
| Job | `b8c08b16-31b2-410e-9d22-39ee4821fc50` |
| Captain figure | labour 3h × $80 = $240 + Makesafe tarp $110 + flashing tape $15 = **$365 ex / $401.50 inc** |
| `decision_key` | `ajs-two-card-remint-v1-A-AJBR-70554` |
| Trade reported / floor | **2 / 2** (untouched) |

## Trade evidence (unchanged)

- job type: Roof / tarp  
- work done: replaced standard tarp with make-safe tarp, secured with screws  
- materials include Make safe tarp x 8m2 (+ checklist noise)  
- crew: 1 trade, labour_hours **2**

## Void

| Field | Value |
| --- | --- |
| Prior | **INV-1139 DELETED** (`6aa70cd3-…`, $176) |
| Void rev | `dea10c78-…` **confirmed** |
| Cycle clear | 1 row `active=false` on rev `7cff648c-…` |
| Live non-DELETED ACCREC before mint | **0** |

## Commercial override + mint

| Field | Value |
| --- | --- |
| Obligation rev | `9c75fbef-…` |
| Disposition | `priced_with_line_override` |
| Proposal totals | **$365 ex / $401.50 inc** |
| Mint | `create_ses_invoice_draft` |
| Invoice | **INV-1141 DRAFT $401.50** |
| Xero id | `97cb4386-03d5-4313-9220-276d5c575c39` |
| Dup guard | full live ACCREC scan **`scanned_accrec: 1166`** |
| `send_dispatched` | false |

### INV-1141 lines (pdftotext)

```
AJBR-70554 - make-safe attendance - 1 trade x 3 hours       3.00    80.00    240.00
AJBR-70554 - Materials: Makesafe tarp                       1.00   110.00    110.00
AJBR-70554 - Materials: flashing tape                       1.00    15.00     15.00
Subtotal 365.00 / GST 36.50 / TOTAL AUD 401.50
```

Materials named as the Captain named them. Full extract: `INV-1141.pdftotext.txt`.

## Pack

| Field | Value |
| --- | --- |
| Docket revision | `b84beb4a-…` |
| State | **ready** |
| Blockers | `[]` |
| Persisted | true |
| Report | `supporting_report_pdf` **ready once** (prior curated bind left in place) |
| SWMS | **not_applicable** — AJS make-safes do not normally carry SWMS |
| Invoice | live DRAFT **INV-1141** once (pre_xero item still `recovery-not-run` by design; bytes via `get_invoice_pdf`) |

Report wording was **not** rewritten on card A (Captain only required pack once for A).

---

# Card B — AJBR-70499 / SWMS-261137 / Attadale

| Field | Value |
| --- | --- |
| Job | `8c4f5c42-d99f-40d2-96ed-b30d0a7ac17c` |
| Captain figure | labour 3h × $80 = $240 + purchase acro props $240 + timber and screws $45 = **$525 ex / $577.50 inc** |
| `decision_key` | `ajs-two-card-remint-v1-B-AJBR-70499` |
| Trade reported / floor | **2.5 / 2** (untouched) |

## Trade evidence (source of truth; not edited)

- job type: Ceiling / water ingress  
- damage: Corner of ceiling in living/kitchen space drooping down and not connected to joists above  
- work done: Propped up falling ceiling using acro props and structural timber planks screwed into the tops of the props  
- materials: **Acro prop x 2**, **Timber x 2**, **Screws x 2**  
- crew: 1 trade, labour_hours **2.5**  
- damage_cause: Storm / wind  

## Report rewrite (Captain bulkhead account + trade facts)

Bound curated report supersession (`document_version` **7**, `supersedes_prior_bind: true`).

### Builder-facing prose (paragraphs)

**Work Order Scope**  
Make safe the ceiling in the kitchen and living area.

**Site Findings**  
Storm / wind. The corner of the ceiling in the living and kitchen space was drooping and was not connected to the joists above. Per the Captain's account, the bulkhead fell completely and needed to be propped.

**Works Completed**  
The attending trade propped the falling ceiling in the kitchen and living corner using acro props and structural timber planks. The timber planks were screwed into the tops of the acro props.

**Materials and Equipment**  
Acro prop x 2  
Timber x 2  
Screws x 2

**Crew**  
1 trade

Full extract: `B-report.pdftotext.txt`. Local render SHA `sha256:84b6238a0d6c91bb20445fd54f7037b7d300a1e22cb28692165ebc4fa007afc4` (three-way bind match in `B-bind.json`).

### Provenance

| Claim | Source |
| --- | --- |
| Bulkhead fell completely and needed to be propped | **Captain** (attributed in findings) |
| Corner ceiling drooping / not connected to joists | **Trade** damage_description |
| Storm / wind | **Trade** damage_cause |
| Propped with acro props and structural timber planks screwed into tops of props | **Trade** work_done |
| Materials Acro prop x 2 / Timber x 2 / Screws x 2 | **Trade** materials_used (template ticks omitted) |
| Crew 1 trade; arrival 2026-08-05 13:12 | **Trade** |

No cause beyond Storm / wind, no measurements, no hazard classification, no em dashes. Photos: all **16** current-cycle completion photos (no cull).

### Bind path

1. Offline wiki render at `915e9b423fc597d656c7cb090671bf206138114b` (script SHA `fda63bcf…` = `MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256`)
2. `attach_makesafe_document` same `file_name` / document id `2a33fffd-…`
3. `bind_current_cycle_curated_makesafe_report` — eight gates; curation `ses-curated-report:SWMS-261137:2026-08-06-bulkhead-prop-v1`

## Void

| Field | Value |
| --- | --- |
| Prior | **INV-1133 DELETED** (`e0149ed6-…`, $220) |
| Void rev | `e8a68ff2-…` **confirmed** |
| Cycle clear | 1 row on rev `6391ecc4-…` |
| Live non-DELETED before mint | **0** |

## Commercial override + mint

| Field | Value |
| --- | --- |
| Obligation rev | `e3d6f119-…` |
| Disposition | `priced_with_line_override` |
| Proposal totals | **$525 ex / $577.50 inc** |
| Invoice | **INV-1142 DRAFT $577.50** |
| Xero id | `11f826bd-0fc2-4439-a67b-424a93ac130d` |
| Dup guard | **`scanned_accrec: 1167`** |
| `send_dispatched` | false |

### INV-1142 lines (pdftotext)

```
AJBR-70499 - make-safe attendance - 1 trade x 3 hours       3.00    80.00    240.00
AJBR-70499 - Materials: purchase acro props                 1.00   240.00    240.00
AJBR-70499 - Materials: timber and screws                   1.00    45.00     45.00
Subtotal 525.00 / GST 52.50 / TOTAL AUD 577.50
```

Full extract: `INV-1142.pdftotext.txt`.

## Pack

| Field | Value |
| --- | --- |
| Docket revision | (see `B-docket-real.json`) |
| State | **ready** |
| Blockers | `[]` |
| Persisted | true |
| Report | `supporting_report_pdf` **ready once** — new bulkhead-prose bind |
| SWMS | **not_applicable** (AJS rule) |
| Invoice | live DRAFT **INV-1142** once |

---

## Boundaries held

- DRAFT only on both cards  
- Sealed AJS **$80** rate; commercial quantity + materials only  
- Trade hours A=2, B=2.5 after mint  
- Full live ACCREC duplicate guard on both mints  
- Sequential: A fully finished before B  
- Void approve via SECURITY DEFINER RPC attributed to Captain brief (same pattern as commercial-remint-three-cards-v1)

## Code / PR

Operations only. This report plus JSON/text extracts under `data/ajs-two-card-remint-v1/` are the durable record. No product code change. Captain previews DRAFT INV-1141 / INV-1142 and decides authorise/send.
