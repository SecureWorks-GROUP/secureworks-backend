# Maylands materials remint v1

Date: 2026-08-05  
Mode: **operations only** (no product code change; no migration)  
Actor: `fm/maylands-remint-materials-v1`  
Path: same as PR 579 / `data/ajbr-obligation-cycle-clear-mint-v1/report.md`  
Live ops-api: `7e6c36d` (`commercial_quantity_override` present)

## Card

| Field | Value |
| --- | --- |
| Job | `1e05db49-cc42-477b-9689-cbdceed649da` |
| Job number | `SWMS-261017` |
| Suburb | Maylands |
| Builder ref | `MLB-26267` / `MLB-26267PO-56642` |
| Captain figure | labour $510 + materials $65 = **$575 ex / $632.50 inc** |
| `decision_key` | `maylands-remint-materials-v1` |
| Trade reported / floor | **2 / 3** (evidence untouched) |

## Bound report — 2 trades (verified before mint)

Bound `makesafe_report` PDF
`Make-Safe-Report-MLB-26267-Maylands-e925c4e48396.pdf` (`f24ae0f7-…`):

```
CREW                       2 trades
```

Service report `trade_count: 2`, `labour_hours: 2` (MLB floor raises billable hours to 3).  
Invoice charges two trades; report describes two trades — documents agree.

## Boundaries held

- **DRAFT only** — no authorise, no send, no builder contact
- Trade attendance left at **2h / trade_count 2** (verified after mint)
- MLB sealed rate **$85** unchanged (quantity + materials override, not rate)
- Materials on their **own line** named *polycarb disposal / tipping*
- Bound report not re-touched
- Bertram / Munster / AJS / Queens Park untouched
- Full live ACCREC duplicate guard on mint (`scanned_accrec: 1146`)

## Void (Captain session)

| Field | Value |
| --- | --- |
| Prior invoice | **INV-1104 DELETED** (`e8279f0c-…`, total $561) |
| Void revision | `58923167-…` **confirmed** (Captain JWT approve + execute) |
| Obligation rev (prior) | `25c789f5-…` `void_linked` |
| Live non-DELETED ACCREC before clear | **0** |

Void approve required identified Captain session (api_key correctly refused 403).  
Option A from firstmate; Captain approved and executed from own session.

## Clear path — Management API `UPDATE` (no ops-api path)

Identical gate as AJBR / Munster. Live ACCREC re-checked **0** immediately before write.

```sql
UPDATE makesafe_invoice_obligation_cycles c
SET active = false
FROM makesafe_invoice_obligation_revisions r
JOIN makesafe_invoice_obligations o ON o.id = r.obligation_id
JOIN makesafe_invoice_void_revisions v ON v.invoice_obligation_revision_id = r.id
JOIN xero_invoices xi ON xi.xero_invoice_id = v.xero_invoice_id AND xi.job_id = r.job_id
WHERE c.obligation_revision_id = r.id
  AND c.job_id = '1e05db49-cc42-477b-9689-cbdceed649da'
  AND c.active = true
  AND r.state = 'void_linked'
  AND o.status = 'void_linked'
  AND v.state = 'confirmed'
  AND v.target_status = 'DELETED'
  AND xi.status = 'DELETED'
  AND xi.invoice_number = 'INV-1104'
RETURNING ...;
```

Returned **1** row, now `active=false`:

| revision | attendance_cycle_id | invoice |
| --- | --- | --- |
| `25c789f5-…` | `afcb8f5a-…` | INV-1104 |

## Prepare + mint

| Field | Value |
| --- | --- |
| Obligation | `4755597f-9f35-4098-951c-6d6f90d45808` (open) |
| Obligation rev | `f6b98b23-73dd-526a-9a5a-88ebf3e89fee` |
| Disposition | `priced_with_line_override` |
| Proposal subtotal | **$575 ex** |
| Mint | `create_ses_invoice_draft` |
| Invoice | **INV-1121** |
| Status | **DRAFT** |
| Total | **$632.50** |
| Xero id | `7774ba79-74b4-4ca3-8320-fbdddf80658a` |
| Override kind | `commercial_quantity_not_rate` |
| Authorised by | Captain Marnin Stobbe |
| Decision key | `maylands-remint-materials-v1` |
| Trade / floor stamped | 2 / 3 |
| Sealed labour rate | 85 |

`send_dispatched: false` (DRAFT only). Prior INV-1104 remains DELETED.

### Commercial lines (proposal)

| Kind | Description | Qty | Unit | Amount ex |
| --- | --- | --- | --- | --- |
| labour | MLB-26267 - make-safe attendance - 2 trades x 3 hours | 6 | $85 | $510 |
| materials | MLB-26267 - Materials: polycarb disposal / tipping | 1 | $65 | $65 |

## Invoice PDF text (phone-checkable)

Extracted via `get_invoice_pdf?xero_invoice_id=7774ba79-…` + `pdftotext -layout`
(full extract: `INV-1121.pdftotext.txt`).

```
Description                                             Quantity           Unit Price           GST        Amount AUD

MLB-26267 - make-safe attendance - 2 trades x 3 hours       6.00                  85.00         10%               510.00

MLB-26267 - Materials: polycarb disposal / tipping          1.00                  65.00         10%                 65.00

                                                                                             Subtotal             575.00
                                                                                  TOTAL GST 10%                     57.50
                                                                                          TOTAL AUD               632.50
```

Labour and materials are **separate lines**. Materials name *polycarb disposal / tipping*.  
Total **$632.50** matches Captain figure.

## Exactly one live DRAFT

| Job | Live non-DELETED ACCREC |
| --- | --- |
| `1e05db49-…` (SWMS-261017 / Maylands) | **INV-1121 DRAFT $632.50** only |

INV-1104 remains DELETED.

## Trade evidence unchanged

Current-cycle `job_service_reports.checklist_json`:

- `labour_hours` = **2**
- `trade_count` = **2**

## Follow-up (not done here; no migration shipped)

Same product debt as AJBR/Munster: `confirm_ses_invoice_void_execution_v1` should also
`UPDATE makesafe_invoice_obligation_cycles SET active = false` when linking a
void. Without that, every genuine DRAFT→DELETED remint needs this hand-clear.

## Code / PR

Operations only. This report is the durable record. No product code change.
Captain previews DRAFT INV-1121 and decides authorise/send.
