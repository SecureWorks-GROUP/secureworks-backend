# AJBR obligation-cycle clear + commercial remint v1

Date: 2026-08-05  
Mode: **operations only** (no product code change; no migration)  
Actor: `fm/ajbr-obligation-cycle-clear-mint-v1`  
Live ops-api: `1cb506f` (`commercial_quantity_override` present)

## Boundaries held

- DRAFT only — no authorise, no AJ send, no builder contact
- Trade attendance left at **2.0h** (verified after mint)
- Global AJS 2h floor untouched
- No rate-fake total; labour unit price stayed $80
- Bound reports not re-touched
- Bertram / Munster / Queens Park untouched

## Pre-condition proof (before any write)

| Fact | 70487 / SWMS-261131 | 70488 / SWMS-261130 |
| --- | --- | --- |
| Job | `288b5582-4ce7-49b0-94c7-51659b5f2da0` | `6006c332-3bb5-473e-beda-bef627172784` |
| Prior invoice | INV-1108 **DELETED** | INV-1109 **DELETED** |
| Void revision | `48874ef7-…` **confirmed** → DELETED | `725b06ce-…` **confirmed** → DELETED |
| Obligation rev | `ab9a23d0-…` `void_linked` | `358721d8-…` `void_linked` |
| Live non-DELETED ACCREC | **0** | **0** |
| Stale cycle rows still `active=true` | 2 cycles | 1 cycle |

`prepare_ses_invoice_obligation` failed with `uq_makesafe_invoice_cycle_active` because
`confirm_ses_invoice_void_execution_v1` marks the obligation/revision `void_linked`
but **never sets** `makesafe_invoice_obligation_cycles.active = false`. The unique
index then blocks a new obligation for the same attendance cycle.

## Clear path used — **direct SQL write** (no operable ops-api path)

There is **no** ops-api action that deactivates cycle rows after void. The only
`active = false` writer in-repo is inside `commit_ses_invoice_obligation_revision_v1`,
and it only deactivates cycles of a *pending* revision being superseded — not
`void_linked` rows.

Scoped Management API `UPDATE` (not a migration):

```sql
UPDATE makesafe_invoice_obligation_cycles c
SET active = false
FROM makesafe_invoice_obligation_revisions r
JOIN makesafe_invoice_obligations o ON o.id = r.obligation_id
JOIN makesafe_invoice_void_revisions v ON v.invoice_obligation_revision_id = r.id
JOIN xero_invoices xi ON xi.xero_invoice_id = v.xero_invoice_id AND xi.job_id = r.job_id
WHERE c.obligation_revision_id = r.id
  AND c.job_id IN (<70487>, <70488>)
  AND c.active = true
  AND r.state = 'void_linked'
  AND o.status = 'void_linked'
  AND v.state = 'confirmed'
  AND v.target_status = 'DELETED'
  AND xi.status = 'DELETED'
  AND xi.invoice_number IN ('INV-1108', 'INV-1109')
RETURNING ...;
```

Returned 3 rows, all now `active=false`:

| Job | revision | attendance_cycle_id | invoice |
| --- | --- | --- | --- |
| 70488 | `358721d8-…` | `8da38686-…` | INV-1109 |
| 70487 | `ab9a23d0-…` | `5d7658ac-…` | INV-1108 |
| 70487 | `ab9a23d0-…` | `7aae85c5-…` | INV-1108 |

## Prepare + mint

Payloads from `data/ajbr-remint-25h-commercial-v1/report.md` (firstmate data).

| Card | Obligation rev | Disposition | Totals (proposal) | Mint | Invoice | Status | Total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AJBR-70488 ceiling / SWMS-261130 | `a88166e3-…` | `priced_with_line_override` | $245 ex / $269.50 inc | `create_ses_invoice_draft` | **INV-1110** | DRAFT | **$269.50** |
| AJBR-70487 roof / SWMS-261131 | `c0656b05-…` | `priced_with_line_override` | $260 ex / $286 inc | `create_ses_invoice_draft` | **INV-1111** | DRAFT | **$286.00** |

Full live ACCREC scan: 1137 then 1138. `send_dispatched: false` both.  
`duplicate_probe.ambiguity: void_only` on prepare (prior DELETED only).

Override provenance on both proposals: Captain / `2026-08-05T00:00:00.000Z` /
`ajbr-remint-25h-commercial-v1` / trade 2.0 / floor 2 / sealed rate 80 /
`override_kind: commercial_quantity_not_rate`.

## Invoice PDF text (separate lines — phone-checkable)

### INV-1110 — AJBR-70488 / $269.50

```
Description                                               Quantity   Unit Price   GST    Amount AUD
AJBR-70488 - make-safe attendance - 1 trade x 2.5 hours       2.50        80.00   10%       200.00
AJBR-70488 - Materials: timber and bugle screws               1.00        45.00   10%        45.00
                                                                                   Subtotal   245.00
                                                                          TOTAL GST 10%         24.50
                                                                              TOTAL AUD       269.50
```

### INV-1111 — AJBR-70487 / $286.00

```
Description                                               Quantity   Unit Price   GST    Amount AUD
AJBR-70487 - make-safe attendance - 1 trade x 2.5 hours       2.50        80.00   10%       200.00
AJBR-70487 - Materials: timber, bugle screws, flashing        1.00        60.00   10%        60.00
tape and silicone
                                                                                   Subtotal   260.00
                                                                          TOTAL GST 10%         26.00
                                                                              TOTAL AUD       286.00
```

Extracted via `get_invoice_pdf` + `pdftotext -layout`.

## Exactly one live DRAFT per card

| Job | Live non-DELETED ACCREC |
| --- | --- |
| 288b5582… (70487) | **INV-1111 DRAFT $286.00** only |
| 6006c332… (70488) | **INV-1110 DRAFT $269.50** only |

Prior INV-1108 / INV-1109 remain DELETED.

## Trade evidence unchanged

Current-cycle `job_service_reports.checklist_json.labour_hours`:

- 288b5582… → **2**
- 6006c332… → **2**

## Follow-up (not done here; no migration shipped)

`confirm_ses_invoice_void_execution_v1` should also
`UPDATE makesafe_invoice_obligation_cycles SET active = false WHERE obligation_revision_id = …`
when linking a void. Without that, every genuine DRAFT→DELETED remint will need the
same hand-clear. That is a named migration change to the void confirm RPC — out of
scope for this remint (Captain waiting on preview). Escalate as product follow-up if
desired.

## Code / PR

Operations only. This report is the durable record. No product code change.
