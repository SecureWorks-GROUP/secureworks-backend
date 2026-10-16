# Dispatch slice 6: Deliveries, back-end contract

What `ops-api` gives the Dispatch tab to track every purchase order on a job
through three states: expected, confirmed by the supplier, sighted on site.
Three writes, a wider `dispatch_materials` read, two more fields on the
`pipeline&dispatch=1` list, and one condition in the supplier reply reader.

Code: `supabase/functions/ops-api/dispatch_deliveries.ts` (the rules, pure:
which orders are rows and their order, which count, the three cells and
`step`, `expected_editable`, `all_sighted`, the rail line text, the date
check; nothing else restates them), `dispatch_deliveries_store.ts` (the three
writes), `dispatch_materials_store.ts` (the read, and the shared count read
every Dispatch write answers with), `dispatch_materials.ts` (one branch in
`dispatchMaterialDisplayStatus`), the action switch and the `pipeline` read in
`index.ts`. Migration: `supabase/migrations/20261016150000_dispatch_deliveries.sql`
(rollback `supabase/rollbacks/20261016150000_dispatch_deliveries_down.sql`,
contract case `supabase/tests/migration-contracts/20261016150000_dispatch_deliveries/`).
Recorded answers (made-up job, suppliers, person): `docs/dispatch-slice-6-recorded-answers.json`.

Nothing here sends to anyone, calls Xero, writes `jobs` or
`job_dispatch_state`, changes an order's `status`, `line_items`,
`delivery_confirmed_at`, `xero_po_id` or `job_id`, writes a business event or
calls a paid AI read.

## 1. The records

`purchase_orders` gains six nullable columns, no default, and one check. No
table, trigger, function or publication.

| Column | Meaning |
|---|---|
| `confirmed_delivery_set_at` | when a person set the confirmed date by hand |
| `confirmed_delivery_set_by` | that person (`users.id`), null for the ops key |
| `confirmed_delivery_set_by_email` | that person's email |
| `delivery_sighted_at` | when the person pressed Mark sighted |
| `delivery_sighted_by` | that person (`users.id`), null for the ops key |
| `delivery_sighted_by_email` | that person's email |

Check `purchase_orders_delivery_sighted_named`:
`(delivery_sighted_at IS NULL) = (delivery_sighted_by_email IS NULL)`. A
sighting always names a person. `delivery_confirmed_at` keeps its meaning (a
supplier confirmation) and is neither written nor drawn.

## 2. The rules (`dispatch_deliveries.ts`)

- **Rows:** per chosen supplier (slice 4 `position` order), its Dispatch orders
  (`source = 'dispatch'`, that `supplier_id`) oldest first, else one
  `{ kind: 'not_ordered', supplier_id, supplier_name }` row; then every other
  order on the job, oldest first (`made_in_dispatch: false`). Never a
  cancelled or deleted order, or one whose `po_type` is set and not `material`.
- **Counted:** not cancelled or deleted, `po_type` `material` or null. Drafts and
  outside orders count. `all_sighted`: at least one counted order and every one
  sighted.
- **Confirmed `state`:** `date` when a confirmed date is stored (whoever wrote
  it; `by_hand` only with `confirmed_delivery_set_at`); `status_only` when none
  but status is `confirmed`, `delivered` or `billed`; `not_confirmed` when none
  and sighted; else `waiting`.
- **`step`:** 3 sighted; 2 confirmed (`date` or `status_only`); 1 any other
  order; 0 a `not_ordered` row.
- **`expected_editable`:** false on an order in Xero (`xero_po_id` set): the
  Xero order sync overwrites `delivery_date`.
- **Rail line** (`dispatchDeliveryRailLine(total, sighted, stage_index)`), only
  with a counted order: not all sighted "<n> of <m> orders sighted on site.";
  all sighted at stop 5 or 6 "Every order on this job is sighted on site.";
  all sighted elsewhere "Every order on this job is sighted on site. Press
  Materials on site to move the job." It moves nothing.
- **Date:** a real `YYYY-MM-DD` (30 February refused) or null.
- **Line status:** a line on an order with `delivery_sighted_at` set has
  `display_status: 'delivered'`, which counts as ready. The stored line
  `status` is never written.

## 3. `GET dispatch_materials` (still a pure read)

The orders read also selects `po_type, delivery_date, confirmed_delivery_date,
confirmed_delivery_set_at, confirmed_delivery_set_by,
confirmed_delivery_set_by_email, delivery_sighted_at, delivery_sighted_by,
delivery_sighted_by_email` (`updated_at` was already there). One `users`
`id, name` read for the setter and sighter ids, only when there is one. No
price field.

Each `orders[]` entry gains `po_type`, `updated_at` and
`delivery: { expected, expected_editable, confirmed: { state, date, set_by, set_at, by_hand }, sighted: { at, by } | null, step, counted }`.
`set_by` and `by` are the person's `users.name`, else the stored email.

The answer gains `deliveries: { rows, counted, sighted, all_sighted }`. An order
row is `{ kind: 'order', purchase_order_id, po_number, supplier_name,
supplier_id, made_in_dispatch, in_xero, status, updated_at, delivery }`. No
cap.

Failures: orders read fails, `orders_status: 'failed'` and no `deliveries`
(slice 4's rule). Only the `users` read fails: names fall back to the stored
emails, nothing marked failed. `lines[].display_status` and `counts.ready`
count Delivered lines; which orders are sighted comes from the orders read
alone, so a failed slice 5 chip read never hides a Delivered line.

## 4. `GET pipeline&dispatch=1`

Only under `dispatch=1`, the existing purchase order read selects
`job_id, id, status, po_type, delivery_sighted_at` instead of `job_id`. Plain
`pipeline` is unchanged byte for byte; `po_count` is worked out as before.

- Per row: `deliveries_orders_total` (counted orders) and
  `deliveries_orders_sighted`. A row the order read did not cover (a draft)
  gets neither.
- Top level: `dispatch_deliveries: 'ok' | 'failed'`.
- `materials_lines_ready` counts Delivered lines.
- The order read fails: `dispatch_deliveries: 'failed'` and
  `dispatch_materials: 'failed'`, both sets of fields off every row. Slice 6
  adds no `degraded` marker for it (the pre-existing `pipeline.purchase_orders`
  enrichment error that has always followed a failed order read is unchanged).

Wall time of the `dispatch=1` read on production, before and after: not
observed (no production call was made from the build); acceptance step P1
records it.

## 5. The three writes

POST only. Staff session or the privileged ops key (`_opsApiCallerIsStaffOperator`,
gated as `update_repair_stage`); not on `ROUTINE_ALLOWED_ACTIONS`,
`AGENT_READ_ALLOWED_ACTIONS` or `LEAD_INSTALLER_READ_ACTIONS`. Every press names
a person: the signed-in user, or for the ops key an `operator_email` matching a
`users` row (else 400 `operator_required`).

All take `purchase_order_id` and `expected_updated_at` (the order's
`updated_at` the screen showed).

| Action | Input | Writes | Event |
|---|---|---|---|
| `dispatch_delivery_set_expected` | `delivery_date` (date or null) | `delivery_date` only. 409 `order_in_xero` when `xero_po_id` is set | `po_delivery_expected_set` `{ po_id, po_number, supplier, from, to, operator_email }` |
| `dispatch_delivery_set_confirmed` | `confirmed_delivery_date` (date or null), `via` (`deliveries` or `thread`) | the date plus the three `confirmed_delivery_set_*` stamps; null clears all four. Allowed on an order in Xero | `po_delivery_confirmed_set` `{ po_id, po_number, supplier, from, to, via, operator_email }` |
| `dispatch_delivery_mark_sighted` | `sighted` true or false | the three `delivery_sighted_*` columns; false clears them. Allowed before a confirmation and on an order in Xero | `po_delivery_sighted` `{ ..., sighted_at }` / `po_delivery_sighted_cleared` `{ ..., was_sighted_at, was_sighted_by_email }` |

Common:

- One `update ... where id and updated_at`. No row: 409 `order_changed` with
  `order` (the latest, in the read's `orders[]` shape); nothing written.
- 400 `invalid_request` on a bad id, date, `via`, `sighted` or stamp.
- 404 `order_not_found` when the order is not in the organisation or on no job.
- 409 `not_dispatch_work` (make-safe by `dispatchWorkType`; a repair-family job
  stored as make-safe is allowed), `order_cancelled` (cancelled or deleted),
  `not_material` (`po_type` set and not `material`).
- Same value: `unchanged: true`, no write, no event. A confirmed date the reply
  reader wrote, set again by a person, is stamped as theirs.
- One `job_events` row per real press (`user_id` the signed-in user, null for
  the ops key). If it fails after the order row landed: success with
  `audit_logged: false`.
- Answer: `{ success, order, deliveries: { counted, sighted, all_sighted }, counts }`,
  `counts` being slice 4's `{ total, ready }` for the job. Either is `null`
  when its read after the write fails; the screen keeps its figure.

## 6. The reply reader

`analyseSupplierQuote` selects `confirmed_delivery_set_at`, and in all three
places it writes `confirmed_delivery_date` leaves that column out when it is
set: a date a person set by hand is never replaced by a machine's reading of an
email. Each of those writes is its own update carrying
`confirmed_delivery_set_at IS NULL`, so a person's press during the AI call
still wins (the high-confidence status move is a separate, unguarded update).
Everything else it does is unchanged.

## 7. Every Dispatch write's `counts`

Slices 4 and 5's writes answer `counts` through the same shared read
(`readDispatchJobCounts`), which now also reads the orders the job's lines are
on (`id, delivery_sighted_at`, only when a line is on one, deleted orders left
out as in the `dispatch_materials` read) so Delivered lines count there too.
A failed read answers `counts: null`, as before.
