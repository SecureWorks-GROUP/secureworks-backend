# Weekly work-order trade invoice contract

## Diagnosis against invoice #31

The acceptance artifact is Henry's invoice #31 dated 27 August 2026. It has
nine job blocks, job subtotals of `$164.60`, `$244.20`, `$48.60`, `$2,510.00`,
`$274.00`, `$35.00`, `$842.00`, `$640.00`, and `$405.00`, a `$5,163.40` job
grand total, a `$350.00` Car Loan deduction, and `$4,813.40` TO BE PAID.

Current-main diagnosis before this change:

- Trigger: the weekly `generate_trade_invoice` path rejected negative rates and
  required job attribution on extra lines. A crew pass-through or the non-job
  Car Loan line could therefore not enter the weekly invoice.
- Masking condition: `submit_work_order_invoice` could subtract selected crew
  charges, but only for one work order and it immediately attempted one Xero
  draft. The older work-order labour path stored one net holder line with
  structured prose; it did not create Henry's distinct negative lines.
- Symptom: neither route could produce nine server-totalled job blocks plus the
  final deduction, leaving the Excel invoice and its omitted-job/manual-sum
  failure modes in place.
- Proven comparison: the crew-charge flow already server-selects acknowledged
  `trade_invoice_lines` for a lead's jobs. The weekly contract now reuses those
  facts rather than accepting an amount typed by the browser.

This diagnosis would be falsified by showing that the pre-change authenticated
weekly route accepted the nine blocks, stored typed negative and non-job final
lines, returned the exact totals above, and produced a Xero bill totalling
`$4,813.40` without accepting a client-supplied aggregate. No production write
or Xero push was used to make this diagnosis.

## Server-owned money and source rules

`invoice_source = weekly_work_order` extends the existing trade invoice header,
line, draft-replacement, super/GST, and Xero paths. It does not create another
invoice table or rates table.

| Line | Authoritative source | Stored provenance |
| --- | --- | --- |
| Positive job line | Selected completed `work_orders.scope_items` quantity and rate | `source_work_order_id` |
| Crew work-order deduction | A selected, acknowledged, same-job/same-business live `trade_invoice_lines` amount; an approved override outranks stale quantity/rate display facts | `source_trade_invoice_line_id`, `source_work_order_id` |
| Direct labour deduction | Positive hours from the request, a non-cancelled same-job `job_assignments` row, and the `trade_rates` row effective on the work-order date | `deduction_user_id`, `deduction_assignment_id`, `deduction_trade_rate_id`, `source_work_order_id` |
| Travel/logistics or materials deduction | The same acknowledged crew source, classified from its stored line type/description | crew provenance above |
| Final payout deduction | Description, positive quantity, and positive rate explicitly entered for the payout obligation; the server signs and totals it | no job/source identity by design |

The client never submits positive work-order prices, crew deduction amounts,
direct-labour rates, a job subtotal, grand total, or TO BE PAID. The server
reconstructs every line, makes deductions negative, sums each job block, sums
the job blocks, subtracts final deductions, and persists the result. PostgreSQL
serializes both weekly and legacy single-work-order persistence on the same
per-business lock, revalidates source claims inside those transactions, and
prevents either route from racing the other for a work order or crew charge.
The weekly boundary replaces at most one same-trade/week draft and enforces:

```text
to_be_paid_ex = job_grand_total_ex - final_deductions_total_ex
to_be_paid_ex = subtotal_ex
```

The existing super/GST calculation still operates on `subtotal_ex`, and Xero
keeps negative lines at their exact stored amount. Labour stays at those work
amounts; super is a minus line so the bill total equals cash payable to the
trade (TO BE PAID less super). Super is paid to the fund separately.

## Trade app API contract

### 1. Load eligible work orders

```http
GET /functions/v1/ops-api?action=my_work_orders&mode=all&type=fencing&status=complete&page_size=500
Authorization: Bearer <user JWT>
```

Use `work_orders[].scope_items` as read-only positive lines and
`work_orders[].negative_charges` as crew-deduction choices. A card is eligible
for the weekly builder when `can_add_to_weekly_invoice` is true. An existing
same-user draft exposes `weekly_draft_id` so it can be reopened; `can_invoice`
remains false to prevent a duplicate single-work-order invoice.

For direct labour names, the existing job detail route returns the assigned
crew without exposing their pay rate:

```http
GET /functions/v1/ops-api?action=trade_job_detail&jobId=<job_id>
Authorization: Bearer <user JWT>
```

Use `crew[].user_id` and `crew[].name`. The submit route independently proves
the assignment and resolves the dated rate.

### 2. Save or replace the one weekly draft

```http
POST /functions/v1/ops-api?action=save_trade_invoice_draft
Authorization: Bearer <user JWT>
Content-Type: application/json

{
  "week_start": "2026-08-24",
  "gst_on": false,
  "work_order_blocks": [
    {
      "work_order_id": "<completed work order id>",
      "crew_charge_line_ids": ["<negative_charges[].line_id>"],
      "labour_deductions": [
        { "user_id": "<crew user id>", "hours": 2 }
      ]
    }
  ],
  "final_deductions": [
    {
      "description": "Car Loan",
      "quantity": 1,
      "unit": "ea",
      "unit_rate": 350
    }
  ],
  "notes": "optional"
}
```

`week_start` must be Monday. Every work order must be complete and its
completion date (falling back to scheduled date) must be inside that week.
Weekly blocks cannot be mixed with `manual_assignments`, `labour_lines`, or
legacy `extra_items`.

The response contains only server-calculated invoice shape:

```json
{
  "success": true,
  "draft_id": "<uuid>",
  "job_blocks": [],
  "final_deductions": [],
  "grand_total": 5163.40,
  "final_deductions_total": 350.00,
  "to_be_paid": 4813.40,
  "gross_earned": 4813.40,
  "gst": 0,
  "total_inc": 4813.40
}
```

Each `job_blocks` object includes its `source_work_order_id`. Use that value as
the render key: separate work orders for the same job remain separate blocks
with their own date, address, lines, and subtotal.

### 3. Submit the reconstructed weekly invoice

Send the same source-selection fields to the existing submit action, adding the
current `draft_id` when a draft was saved:

```http
POST /functions/v1/ops-api?action=generate_trade_invoice
```

The route re-reads and revalidates every source; it does not trust the saved
browser rendering. A successful response returns the same `job_blocks`,
`final_deductions`, and totals plus invoice/Xero identifiers. If Xero is
unavailable it returns `code: XERO_PUSH_FAILED` with `success: true`: the local
invoice and exact lines are recoverable and no second submission should be
created. Tests must stub the Xero boundary; never use this route against live
credentials for UI testing.

### 4. Render saved detail

```http
GET /functions/v1/ops-api?action=get_trade_invoice&invoice_id=<invoice id>
```

For `invoice_source = weekly_work_order`, render `job_blocks` in order, each
block's `subtotal`, then the separate `final_deductions` section and the three
server totals. Do not recalculate them in `trade.html`. Keep the existing
`trade_payable`, super, and GST fields as their current accounting split; they
do not replace the invoice's TO BE PAID label.

## Required `trade.html` change

Replace the single-card-only action for this workflow with a week selector and
multi-select over `can_add_to_weekly_invoice` work orders. Within each selected
job block:

1. render the positive `scope_items` read-only;
2. render `negative_charges` as selectable Work Order deductions;
3. load the job's `crew` on expansion and accept hours only for direct labour;
4. render only the draft/submit response's line amounts and subtotal.

Add a final deductions section below all jobs. Save through
`save_trade_invoice_draft`, submit through `generate_trade_invoice`, and render
the returned `grand_total`, `final_deductions_total`, and `to_be_paid`. Do not
call `submit_work_order_invoice` for selected weekly blocks, and do not send any
client-computed total or deduction rate other than the explicit final payout
obligation.
