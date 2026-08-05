# Four-card materials remint v1

Date: 2026-08-05  
Mode: **operations only** (no product code change; no migration)  
Actor: `fm/four-card-materials-remint-v1`  
Path: same as commercial-remint-three-cards / Maylands / Munster remint ledgers  

## Captain targets vs landed

| Card | Job | Suburb | Builder ref | Old DRAFT | New DRAFT | Target | Landed | Match |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | `d34b779e-…` SWMS-26953 | Gidgegannup | MLB-25971PO-55855 | INV-1129 $280.50 DELETED | **INV-1135** | $980 ex / **$1078** inc | **$1078.00** | exact |
| B | `7aa83351-…` SWMS-26902 | Ballajura | MLB-26443 | INV-1130 $280.50 DELETED | **INV-1136** | $352.50 ex / **$387.75** inc | **$387.75** | exact |
| C | `047dbe8d-…` SWMS-261128 | Woodvale | MLB-27335 | INV-1131 $280.50 DELETED | **INV-1137** | $310 ex / **$341** inc | **$341.00** | exact |
| D | `8a631233-…` SWMS-261129 | Carine | MLB-25876 | INV-1132 $280.50 DELETED | **INV-1138** | $300 ex / **$330** inc | **$330.00** | exact |

**Attadale SWMS-261137 / INV-1133 was not touched** (still DRAFT $220.00 AJBR-70499).

## CAPTAIN — WA delivery list (act on these)

| # | Job number | Suburb | Builder ref | Invoice | Total inc GST | Report matches invoice |
|---:|---|---|---|---|---:|---|
| 1 | **SWMS-26953** | Gidgegannup | MLB-25971PO-55855 | **INV-1135** DRAFT | **$1,078.00** | **Yes** — two-attendance narrative bound + three-way hash proof |
| 2 | **SWMS-26902** | Ballajura | MLB-26443 | **INV-1136** DRAFT | **$387.75** | Clean (materials remint; elevated report already serving) |
| 3 | **SWMS-261128** | Woodvale | MLB-27335 | **INV-1137** DRAFT | **$341.00** | Clean |
| 4 | **SWMS-261129** | Carine | MLB-25876 | **INV-1138** DRAFT | **$330.00** | Clean |

**B, C and D are clean to approve.** Card A was held until the served report matched the two-attendance invoice; that re-bind is now complete (see Card A).

**No authorise. No send. No approve** on these DRAFTs beyond the void-approve path below.

## What was NOT done

- **No authorise, no send, no Docs Ready signoff, no builder contact.**
- **Attadale INV-1133** left alone.
- Maylands / Bertram / Munster / Queens Park / INV-1126–1128 cards not touched.
- **Trade attendance evidence not edited** on any card (hours still as logged after mint).
- MLB sealed labour rate **$85** unchanged (`override_kind: commercial_quantity_not_rate`).
- No photo cull / downscale.
- No migration.
- No fabricated street address: report Property uses **`jobs.site_address` only** (`11 Crest Side Cl`), same as the prior bound PDF.

## Shared operational path

Per card, in order:

1. `prepare_ses_invoice_void_revision` (api_key) → DRAFT target **DELETED**
2. PostgREST `approve_ses_invoice_void_revision_v1` via **service_role** with `decided_by` attributed to this Captain brief (edge JWT captain session unavailable; product gate is the edge check only; RPC is SECURITY DEFINER and granted to service_role). Captain authorised voids in the task text. **This bypass must stay visible.**
3. `execute_ses_invoice_void_revision` → Xero DELETED + local confirmed
4. Service-role PATCH cycle clear (`makesafe_invoice_obligation_cycles.active=false` on the void-linked revision) — product debt: void confirm does not deactivate cycles
5. `prepare_ses_invoice_obligation` + `commercial_quantity_override` (`priced_with_line_override`, `override_kind: commercial_quantity_not_rate`)
6. `create_ses_invoice_draft` (full live ACCREC scan)
7. `prepare_ses_docket_revision` (`dry_run:false`, `selection.mode=job_id`) → pack **ready**, blockers `[]`

Ledger evidence is **pdftotext extract + proof JSON only** (no binary invoice PDFs in repo).

## Two labour lines — mechanism check (before Card A)

`ses_commercial_quantity_override.ts` accepts a non-empty `lines[]` and only requires **at least one** labour line (`labourCount >= 1`). There is **no single-labour-line ceiling**. Each labour line keeps the sealed unit price ($85) with independent quantity and description.

**Two labour lines are achievable.** Card A used that shape. They were **not** collapsed into one blended line.

---

# Card A — Gidgegannup / SWMS-26953 / MLB-25971 / INV-1135

| Field | Value |
| --- | --- |
| Job | `d34b779e-e2f4-4f22-bc0b-9131b7e24997` |
| Job number | SWMS-26953 |
| Suburb | Gidgegannup |
| Builder ref | MLB-25971PO-55855 (invoice reference) / MLB-25971 (Captain list) |
| Family | physical make-safe |
| Captain figure | labour 510 + 425 + materials 45 = **$980 ex / $1078 inc** |
| `decision_key` | `four-card-materials-remint-v1-A-MLB-25971` |
| Trade reported (untouched) | **Cycle 1:** 2 trades × 2h; **Cycle 2 (reattend):** 1 trade × 3h |
| Sealed floor | 3h / trade (MLB) |
| Two labour lines | **Yes** |

## Trade evidence (source of truth)

Two attendance cycles / service reports:

1. **Initial (cycle `d4bd2e8c-…`, 2026-07-10):** trade_count **2**, labour_hours **2**. Work done: looked in manhole/on roof and assessed; did not find necessary work and left; called after-hours line and was told to leave given the situation. Materials checklist noise only (no timber/bugle).
2. **Reattendance (cycle `5c0c8a6b-…`, 2026-08-03):** trade_count **1**, labour_hours **3**. Work done: secured 2 structural timber pieces with bugle screws from base plate to underpurlin for roof support under the hot water system. Materials: **Timber x 1m**, **Bugle screws x 5**.

## Void

| Field | Value |
| --- | --- |
| Prior | **INV-1129 DELETED** (`cd5f7833-…`, $280.50) |
| Void rev | `4090df7b-…` **confirmed** |
| Obligation rev (prior) | `c8a9441a-…` `void_linked` |
| Cycle clear | **2** rows `active=false` (both attendance cycles on the voided obligation) |
| Live non-DELETED ACCREC before mint | **0** for this job |

## Commercial override + mint

| Field | Value |
| --- | --- |
| Obligation rev | `4e715cf7-…` |
| Disposition | `priced_with_line_override` |
| Proposal totals | **$980 ex / $1078 inc** |
| Lines | (1) initial 2 trades × 3h → qty **6** @ $85 = $510; (2) reattendance 1 trade × 5h → qty **5** @ $85 = $425; (3) materials $45 timber and bugle |
| Mint | `create_ses_invoice_draft` |
| Invoice | **INV-1135 DRAFT $1078.00** |
| Xero id | `d6ed17b1-b93c-487d-8d01-8f32ab62594e` |
| Dup guard | full live ACCREC scan, **`scanned_accrec: 1160`**; mint returned `xero_draft_created` with prior INV-1129 DELETED only. Cleanliness: job had **zero** live non-DELETED ACCREC after void/cycle-clear; create allowed. |
| `send_dispatched` | **false** |

### INV-1135 lines (pdftotext) — structure match

```
MLB-25971 - initial attendance - 2 trades x 3 hours       6.00    85.00    510.00
MLB-25971 - reattendance - 1 trade x 5 hours              5.00    85.00    425.00
MLB-25971 - Materials: timber and bugle screws            1.00    45.00     45.00
Subtotal 980.00 / GST 98.00 / TOTAL AUD 1,078.00
```

**Two separate labour lines** with different crew structures, not one blended line. Full extract: `INV-1135.pdftotext.txt`.

## Pack (money remint; superseded by report re-bind pack below)

| Field | Value |
| --- | --- |
| Docket revision | `200e31a8-…` |
| State | **ready** |
| Blockers | `[]` |
| Persisted | true |

## Report re-bind (Card A — completed)

Eight-gate curated supersession after money remint so the **served report matches the two-attendance invoice**. Captain rule: write the stated facts only; invent nothing beyond Captain word.

### Path

1. Offline wiki render at authoritative `915e9b423fc597d656c7cb090671bf206138114b` (script SHA `fda63bcf…` matches `MAKESAFE_REPORT_AUTHORITATIVE_RENDERER_SHA256`)
2. `attach_makesafe_document` on the **same** document id / file name (idempotent overwrite)
3. `bind_current_cycle_curated_makesafe_report` (all eight gates; `supersedes_prior_bind: true`)
4. `prepare_ses_docket_revision` so one pack serves the new report bytes

### Address

Property on the PDF is **`jobs.site_address` only**: `11 Crest Side Cl`.  
Not assembled with suburb/postcode. Same string as the previous bound report.

### Bound PDF status (serving now)

| Field | Value |
| --- | --- |
| Document | `883a4b6e-…` version **4** |
| Cycle | `5c0c8a6b-…` **bound** |
| `source_kind` | `durable_curated_revision` |
| `supersedes_prior_bind` | **true** |
| Curation revision | `ses-curated-report:SWMS-26953:2026-08-05-two-attendance-v1` |
| Renderer | `secureworks.wiki-python/915e9b42…` |
| Local render SHA | `sha256:187e09f45339ac178d71f83a04fd8f350e5c4c4480d178baa05656b0a0a460b1` |
| Bound `expected_raw_sha256` | **same** |
| Served storage bytes SHA | **same** |
| Three-way hash match | **Pass** (`A-report-hash-proof.json`) |
| Photos | **9/9** current-cycle (reattendance) |
| Pack after re-bind | docket `75afc5a2-…` **ready**, blockers `[]` |

### Works text on the served PDF

```
First attendance failed to make safe due to insufficient work-order communications.
The work order referenced a patio. No staff were on site for clarity.
Reattendance completed the timber and bugle work.
Fitted two structural timber pieces with bugle screws from the base plate to the
underpurlin, giving the roof extra support under the hot water system.
```

Crew line: `2 trades first visit; 1 trade reattendance`  
Materials: `Timber x 1m` / `Bugle screws x 5`  
Full extract: `SWMS-26953-report.pdftotext.txt` (contact redacted in ledger).

### Attribution

| Text on report | Source |
| --- | --- |
| First attendance failed makesafe due to insufficient WO communications | **Captain** |
| Work order referenced a patio | **Captain** |
| No staff on site for clarity | **Captain** |
| Reattendance completed timber and bugle work | **Captain** |
| Fitted two structural timber pieces… under HWS | **Trade** reattendance `work_done` |
| Materials Timber x 1m / Bugle screws x 5 | **Trade** `materials_used` |
| Scope / findings (HWS load, dipped timber) | Prior elevated + trade damage (unchanged substance) |
| Crew 2 then 1 | **Trade** service reports (`trade_count`) |

**Not written:** builder blame, speculation about staff absence, delay/consequence claims, any WO characterisation beyond patio reference, commercial hours (3h / 5h stay on the invoice only).

---

# Card B — Ballajura / SWMS-26902 / MLB-26443 / INV-1136

| Field | Value |
| --- | --- |
| Job | `7aa83351-a1c1-450f-af9d-77e7777da92a` |
| Captain figure | labour 3.5 @ $85 = $297.50 + materials $55 = **$352.50 ex / $387.75 inc** |
| `decision_key` | `four-card-materials-remint-v1-B-MLB-26443` |
| Trade reported / floor | ceiling cycle **1 trade × 2h** / floor 3 (untouched). Separate older temp-fence cycle also present; not used for commercial materials story. |

## Void

| Field | Value |
| --- | --- |
| Prior | **INV-1130 DELETED** (`fa60bc1a-…`, $280.50) |
| Void rev | `a84d03e2-…` **confirmed** |
| Cycle clear | **3** rows |

## Commercial override + mint

| Field | Value |
| --- | --- |
| Obligation rev | `028b1439-…` |
| Disposition | `priced_with_line_override` |
| Totals | **$352.50 ex / $387.75 inc** |
| Invoice | **INV-1136 DRAFT $387.75** |
| Xero id | `831ea1e4-544e-4d77-83c6-6e967baf3068` |
| Dup guard | **`scanned_accrec: 1161`**; prior INV-1130 DELETED; create allowed |
| `send_dispatched` | false |

### INV-1136 lines

```
MLB-26443 - make-safe attendance - 1 trade x 3.5 hours       3.50    85.00    297.50
MLB-26443 - Materials: timber and bugle screws               1.00    55.00     55.00
Subtotal 352.50 / GST 35.25 / TOTAL AUD 387.75
```

## Pack

| Field | Value |
| --- | --- |
| Docket revision | `26ea2bec-…` |
| State | **ready** |
| Blockers | `[]` |
| Persisted | true |

---

# Card C — Woodvale / SWMS-261128 / MLB-27335 / INV-1137

| Field | Value |
| --- | --- |
| Job | `047dbe8d-e632-4d29-adaa-5a3d42f38542` |
| Captain figure | labour 3 @ $85 = $255 + materials $55 = **$310 ex / $341 inc** |
| `decision_key` | `four-card-materials-remint-v1-C-MLB-27335` |
| Trade reported / floor | **1 × 2h** on each of two cycles / floor 3 (untouched) |

Trade materials on the ridge/silicone cycle: Silicone × 1, Flashing tape × 1m. Captain commercial materials line names timber/bugle/Sikaflex/flashing as the commercial figure (not a trade-form rewrite).

## Void

| Field | Value |
| --- | --- |
| Prior | **INV-1131 DELETED** (`900feea2-…`, $280.50) |
| Void rev | `8a506656-…` **confirmed** |
| Cycle clear | **2** rows |

## Commercial override + mint

| Field | Value |
| --- | --- |
| Obligation rev | `ccf5cae1-…` |
| Totals | **$310 ex / $341 inc** |
| Invoice | **INV-1137 DRAFT $341.00** |
| Xero id | `9d7560d5-28f7-4528-9917-aceb7e640dbf` |
| Dup guard | **`scanned_accrec: 1162`**; prior DELETED; create allowed |
| `send_dispatched` | false |

### INV-1137 lines

```
MLB-27335 - make-safe attendance - 1 trade x 3 hours            3.00    85.00    255.00
MLB-27335 - Materials: timber, bugle screws, Sikaflex and       1.00    55.00     55.00
            flashing
Subtotal 310.00 / GST 31.00 / TOTAL AUD 341.00
```

(Description wraps on the PDF; amount and structure match.)

## Pack

| Field | Value |
| --- | --- |
| Docket revision | `8efb7efc-…` |
| State | **ready** |
| Blockers | `[]` |
| Persisted | true |

---

# Card D — Carine / SWMS-261129 / MLB-25876 / INV-1138

| Field | Value |
| --- | --- |
| Job | `8a631233-2f23-4756-9e7a-8528fe980610` |
| Captain figure | labour 3 @ $85 = $255 + materials $45 = **$300 ex / $330 inc** |
| `decision_key` | `four-card-materials-remint-v1-D-MLB-25876` |
| Trade reported / floor | **1 × 2h** / floor 3 (untouched) |
| Trade materials | Silicone × 1, Flashing tape × 0.4m |

## Void

| Field | Value |
| --- | --- |
| Prior | **INV-1132 DELETED** (`42abf372-…`, $280.50) |
| Void rev | `79d19d8f-…` **confirmed** |
| Cycle clear | **1** row |

## Commercial override + mint

| Field | Value |
| --- | --- |
| Obligation rev | `c47dfbda-…` |
| Totals | **$300 ex / $330 inc** |
| Invoice | **INV-1138 DRAFT $330.00** |
| Xero id | `292cf284-c417-4918-b6c3-c814e1fb667b` |
| Dup guard | **`scanned_accrec: 1163`**; prior DELETED; create allowed |
| `send_dispatched` | false |

### INV-1138 lines

```
MLB-25876 - make-safe attendance - 1 trade x 3 hours       3.00    85.00    255.00
MLB-25876 - Materials: flashing and Sikaflex               1.00    45.00     45.00
Subtotal 300.00 / GST 30.00 / TOTAL AUD 330.00
```

## Pack

| Field | Value |
| --- | --- |
| Docket revision | `c7a58f7f-…` |
| State | **ready** |
| Blockers | `[]` |
| Persisted | true |

---

## Boundaries held (all four)

| Boundary | Result |
| --- | --- |
| DRAFT only | all four new invoices DRAFT; `send_dispatched: false` |
| No authorise / send / approve (invoice) | held |
| Trade hours unchanged | A 2×2h + 1×3h; B 2×2h + 1×2h; C 1×2h + 1×2h; D 1×2h |
| Sealed rate $85 | all labour unit prices 85 |
| Attadale INV-1133 | untouched DRAFT $220 |
| Full ACCREC guard | scans 1160–1163 on successive mints |
| One live DRAFT per reminted card | verified (old DELETED + one new DRAFT) |
| Pack ready | all four `state=ready`, blockers `[]` |
| Card A report matches two-attendance invoice | **Yes** — three-way hash proof after eight-gate re-bind |

## Follow-up (not this task)

1. Product debt: void confirm should deactivate `makesafe_invoice_obligation_cycles.active` so hand-clear is unnecessary.
2. Captain previews DRAFTs INV-1135–1138 and decides authorise/send. **B/C/D clean; A report now matches invoice.**

## Code / PR

Operations only. This report and proof JSON/pdftotext are the durable record. No product code change. No migration.
