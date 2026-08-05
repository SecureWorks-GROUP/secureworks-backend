# Munster 2×5h travel remint v1

Date: 2026-08-05  
Mode: **operations only** (no product code change; no migration)  
Actor: `fm/munster-2x5h-travel-mint-v1`  
Path: same as PR 579 / `data/ajbr-obligation-cycle-clear-mint-v1/report.md`  
Live ops-api: `7e6c36d` (`commercial_quantity_override` present)

## Card

| Field | Value |
| --- | --- |
| Job | `b406ac52-6134-4105-9ab5-78645bd89057` |
| Job number | `SWMS-261065` |
| Builder ref | `MLB-26344` (Munster) |
| Captain figure | 10 × $85 = **$850 ex / $935 inc** |
| Line description | `2 trades x 5 hours (incl travel)` (served with MLB prefix) |
| `decision_key` | `munster-2x5h-travel-v1` |
| Trade reported / floor | **3 / 3** (evidence untouched) |

## Boundaries held

- **DRAFT only** — no authorise, no send, no builder contact
- Trade attendance left at **3h** (verified after mint)
- MLB sealed rate **$85** unchanged (quantity override, not rate)
- Bound report not re-touched
- Bertram / AJS / Queens Park untouched
- Full live ACCREC duplicate guard on mint path (`duplicate_probe.ambiguity: void_only`)

## Pre-condition proof (before any write)

| Fact | Value |
| --- | --- |
| Prior invoice | **INV-1101 DELETED** (`ab4ec15d-…`, total $561) |
| Void revision | `97d526d7-…` **confirmed**, `target_status=DELETED` |
| Obligation rev (prior) | `33a90de4-…` `void_linked` (was INV-1101) |
| Live non-DELETED ACCREC | **0** |
| Stale cycle still `active=true` | 1 row on `33a90de4-…` / cycle `dd5c52f7-…` |
| Trade `labour_hours` | **3** |

`prepare_ses_invoice_obligation` with `commercial_quantity_override` fails on
`uq_makesafe_invoice_cycle_active` while that void-linked cycle row stays active —
exact leftover cleared on AJBR-70487 / AJBR-70488 an hour earlier.

## Clear path used — **direct SQL write** (no operable ops-api path)

Scoped Management API `UPDATE` (not a migration), identical gate as AJBR:

```sql
UPDATE makesafe_invoice_obligation_cycles c
SET active = false
FROM makesafe_invoice_obligation_revisions r
JOIN makesafe_invoice_obligations o ON o.id = r.obligation_id
JOIN makesafe_invoice_void_revisions v ON v.invoice_obligation_revision_id = r.id
JOIN xero_invoices xi ON xi.xero_invoice_id = v.xero_invoice_id AND xi.job_id = r.job_id
WHERE c.obligation_revision_id = r.id
  AND c.job_id = 'b406ac52-6134-4105-9ab5-78645bd89057'
  AND c.active = true
  AND r.state = 'void_linked'
  AND o.status = 'void_linked'
  AND v.state = 'confirmed'
  AND v.target_status = 'DELETED'
  AND xi.status = 'DELETED'
  AND xi.invoice_number = 'INV-1101'
RETURNING c.obligation_revision_id, c.attendance_cycle_id, c.active, xi.invoice_number;
```

Returned **1** row, now `active=false`:

| revision | attendance_cycle_id | invoice |
| --- | --- | --- |
| `33a90de4-…` | `dd5c52f7-…` | INV-1101 |

Live ACCREC count was re-checked **0** immediately before the write. No unexpected live invoice.

## Prepare + mint

After the clear, a canon-only prepare (no override) first landed as
`68a25494-…` / $510 ex / $561 inc (`priced_from_canon`) — that revision was
immediately **superseded** and was never minted.

Commercial prepare + mint then committed:

| Field | Value |
| --- | --- |
| Obligation | `f2a081c8-3b39-473a-be6c-e37aebf47932` (open) |
| Obligation rev | `d3f3c876-d7e9-5b3a-bede-3fb33f57666e` |
| State | `create_executed` |
| Disposition | `priced_with_line_override` |
| Proposal totals | **$850 ex / $935 inc** |
| Mint | `create_ses_invoice_draft` |
| Invoice | **INV-1117** |
| Status | **DRAFT** |
| Total | **$935.00** |
| Xero id | `210f32de-3ac1-49fe-ac90-f2c41e729e3e` |
| Override kind | `commercial_quantity_not_rate` |
| Authorised by | Captain Marnin Stobbe |
| Decision key | `munster-2x5h-travel-v1` |
| Trade / floor stamped | 3 / 3 |
| Sealed labour rate | 85 |

`send_dispatched: false` (DRAFT only). Prior INV-1101 remains DELETED.

## Invoice PDF text (phone-checkable)

Extracted via `get_invoice_pdf?xero_invoice_id=210f32de-…` + `pdftotext -layout`
(full extract: `INV-1117.pdftotext.txt`).

```
Description                                             Quantity           Unit Price           GST        Amount AUD

MLB-26344 - make-safe attendance - 2 trades x 5 hours      10.00                  85.00         10%               850.00
(incl travel)

                                                                                             Subtotal             850.00
                                                                                  TOTAL GST 10%                     85.00
                                                                                          TOTAL AUD               935.00
```

Line reads as **2 trades x 5 hours (incl travel)** at **$85**, quantity **10**,
**$850** line / **$935** total — Captain's figure.

## Exactly one live DRAFT

| Job | Live non-DELETED ACCREC |
| --- | --- |
| `b406ac52-…` (SWMS-261065 / MLB-26344) | **INV-1117 DRAFT $935.00** only |

## Trade evidence unchanged

Current-cycle `job_service_reports.checklist_json.labour_hours` = **3**.

## Follow-up (not done here; no migration shipped)

Same product debt as AJBR: `confirm_ses_invoice_void_execution_v1` should also
`UPDATE makesafe_invoice_obligation_cycles SET active = false` when linking a
void. Without that, every genuine DRAFT→DELETED remint needs this hand-clear.

## Code / PR

Operations only. This report is the durable record. No product code change.
Captain sends when ready after reviewing the live DRAFT total.
