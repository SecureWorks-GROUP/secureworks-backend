# Job trace read contract (`job-trace-v1`)

ops-api `job_trace` (Integrated Job Framework INT-34, requirement R-24) is the one read every integration acceptance is checked with. It takes one job and returns its chain link by link, with each link's key, row ids and state, and names the **first missing link** with a reason code. Code: `supabase/functions/ops-api/job_trace.ts`. Tests: `job_trace_test.ts`. Recorded answer: `docs/job-trace-recorded-answers.json`.

Read only. No table write, no provider call, no model call, no flag. Nothing in it decides a placement: it reports what the matcher, the queue, the work order seal and Xero's copy already say.

## Request

`GET ops-api?action=job_trace&job_number=SWF-26979` (or `job_id=<uuid>`). A bare call is refused with 400 before any read. An unknown job is 404. A job number on two jobs is 409 with both ids.

## Who reads it, and in which shape

| Caller | Shape |
|---|---|
| admin or owner session | `view: "staff"`: each item may carry `amounts`, copied from the row (the figures the Money pages already show) |
| the ops key (auth mode `api_key`, which the agents also hold) | `view: "figure_free"`: every `amounts` object removed |
| anyone else (ops_manager, trades, the routine) | 403 `operator_access_required` |

The trace never computes a figure. The scope revision is read without its canonical text, and the job without its expected-cost figures (only `expected_costs->>scope_revision_id`).

## The links

| Link | Name | Read from | Present when | Not present |
|---|---|---|---|---|
| L1 | `quote` | `scope_revisions` (id, status, hashes), `quote_revisions` (sent), `quote_builder_versions` (issued scope) | the accepted scope revision is found, by the rule the work order fill uses (`job_work_order_quote_fill.ts`) | `job_not_accepted`, `no_accepted_quote`; partial `accepted_without_frozen_revision` |
| L2 | `material_lines` | `job_material_lines` | at least one line, none `not_reviewed`, every `to_order` line on an order | `no_material_lines`; partial `lines_not_reviewed`, `lines_not_on_order` |
| L3 | `orders` | `purchase_orders` (not deleted), `job_order_emails` (not discarded) | every PO is a Dispatch PO with a sent email | `no_purchase_orders`; partial `legacy_po`, `order_not_sent`, `order_send_unknown` |
| L4 | `supplier_bills` | `job_materials_facts`, `materials_reconciliation_queue`, `xero_invoices` ACCPAY (linked to the job, or named by a PO's reference or `xero_bill_id`) | every known bill has a materials fact (its `source` and `confidence` shown) | `no_supplier_bills`, `bill_not_placed`, `bill_linked_no_fact` (missing when none is placed, partial when some are) |
| L5 | `work_order` | `work_orders` kind `job` | approved and sealed | `no_job_work_order`; partial `work_order_draft`, `work_order_not_sealed` |
| L6 | `crew_lines` | `trade_invoice_lines`, `trade_invoices` | every line's invoice has a Xero bill and the line is on the job work order | `no_crew_lines`; partial `crew_bill_held`, `crew_bill_not_in_xero`, `line_not_on_work_order` |
| L7 | `invoices` | `xero_invoices` ACCREC (voided and deleted left out), `job_contacts` | a non-draft invoice, and one per live party when there are several | `no_customer_invoice`; partial `invoice_draft_only`, `party_not_invoiced` |
| L8 | `card` | `context_ledger_generations` (live), `context_ledger_items` (status counts only) | never yet: the H7 bill outcome is not on main | `no_live_card_reading`; partial `h7_not_released` |

Item states: L3 `sent`, `not_sent`, `send_unknown`, `legacy`; L4 `placed`, `not_placed`, `linked_no_fact`, `assigned`; L6 `billed`, `held`, `not_in_xero`; L7 `draft`, `owing`, `paid`. A bill's `found_via` says how the trace found it (`materials_fact`, `xero_copy_job_link`, `named_by_po_reference`, `queue_suggestion`): a bill named only by a PO's reference is a lead the trace reports, never a placement. A crew bill mirror (`trade_invoices.xero_bill_id`) is never read as a supplier bill.

## The first gap

`first_gap` is the first link that is `missing`, or `unknown` if a link before it could not be read (a failed read is `unknown` with `reason: read_failed` and an `error`, never `missing`). A `partial` link is reported but does not break the chain. Every code and its meaning is in the answer's `reasons`.

## Limits

Each read takes at most 500 rows (a link that hits it says `truncated: true`). The trace makes two rounds of parallel reads and at most one more (the queue rows for bills a PO names). Not measured against the edge time limit on production: that is an acceptance step after deploy.

## Changing it

The answer's shape is versioned (`version`). A new link, a new reason or a changed rule changes the recorded answer: regenerate it and say why in the PR. When the H7 reader merges, INT-10 reads it in L8.
