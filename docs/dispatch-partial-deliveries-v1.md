# Dispatch S5: partial deliveries (v1)

Status: built on branch `w0/s5-partial-deliveries`, not deployed. Design:
`operations/workstreams/W0/s5-partial-deliveries-design-20261020.md`. This
document is the field contract. Slice 6 (`docs/dispatch-slice-6-contract.md`)
is unchanged except where it says so below.

## What it adds

A supplier often delivers an order in parts: 18 of 42 panels on Thursday, the
other 24 the next week. Slice 6 only knows "sighted" for a whole order. S5
records what arrived per material line, in as many parts as it came.

- One row per part delivery: `job_material_line_receipts` (migration
  `20261020180000_dispatch_line_receipts.sql`). Append-only. Undo is a void,
  never an edit or a delete.
- A line's delivery state is worked out on read, never stored:
  `delivered`, `part_delivered`, or `on_po`.
- An order is on site when it is sighted, or when every line on it is
  delivered by receipts.

Nothing in S5 writes a line's status or quantity, an order's status,
`line_items`, `delivery_confirmed_at`, `xero_po_id` or `job_id`, `jobs`, or
`job_dispatch_state`. It writes no `job_events` row, no `business_events` row,
and sends nothing. The only rows a press writes are receipt rows.

## Rules (one owner: `ops-api/dispatch_line_receipts.ts`)

A receipt counts for a line only while it is live (not voided) and names the
order the line is on now. Receipts written against an order the line has since
left stay as history and count for nothing.

Line state, for a line on an order:

- `delivered` when either:
  - the order's sighting covers the line, or
  - live receipts reach the line's quantity. A line with no quantity (null
    or 0) is delivered by one live receipt.
- `part_delivered` when live receipts are above 0 but below the quantity.
- otherwise the slice 4 status (`on_po`).

A sighting covers a line only if the line was already on the order when the
order was sighted. Each line carries `purchase_order_attached_at`, stamped by
trigger `trg_job_material_lines_po_attached` whenever `purchase_order_id`
changes. No writer can set it by hand. The sighting covers the line when the
stamp is null (a line put on its order before S5, which keeps reading exactly
as slice 6 read it) or the stamp is at or before `delivery_sighted_at`. A line
added to an order after it was sighted needs its own receipts. This answers W1's
finding that `dispatch_commit_order_update` has no sighted guard.

Order on site: the order is sighted and has no lines, or every line on it is
delivered (by sighting or by receipts). Only counted orders count, the same set
slice 6 counts.

Rail line (`dispatchDeliveryRailLine` in `dispatch_deliveries.ts`, mirrored by
`deliveriesRailLine` in the UX), `<n>` being orders on site:

- With at least one line part delivered:
  `<n> of <m> orders on site; <k> lines part delivered.` (singular forms for 1).
- With none, but the on-site count differs from the sighted count (an order
  received in full by receipts, or a sighted order with a line added after the
  sighting): `<n> of <m> orders on site.`, or `Every order on this job is on
  site.` plus the slice 6 press hint before stop 5. It never says "sighted"
  for an order that was not sighted.
- Otherwise the slice 6 text, unchanged. A job with no receipts reads byte for
  byte as before.

Quantities are compared in thousandths (the column is `numeric(12,3)`).
Receiving more than the line's quantity is allowed; the answer carries a
warning `{ code: "over_quantity", ordered, received }`.

## Writes

Both are staff-only, POST, in the existing `dispatch_delivery_*` case block of
`ops-api/index.ts`. Implementation: `ops-api/dispatch_deliveries_store.ts`.
The ops key must name the person in `operator_email`, as for the slice 6
writes.

### `dispatch_delivery_record_receipt`

Body: `{ job_id, line_id, quantity, received_on, note?, client_receipt_id }`.

- `client_receipt_id` is a uuid made by the browser per press. It becomes the
  row id, so a retried press writes one row and answers `unchanged: true`.
- `quantity` is above 0 and at most 999999999.999. A line with no quantity
  takes exactly 1 and only once (`line_already_received`).
- `received_on` is `YYYY-MM-DD`, not after today in Perth. The database refuses
  a later date too.
- `note` is optional, 1 to 300 characters after trimming.

Refusals: 400 `invalid_request` / `operator_required`; 404 `job_not_found`,
`line_not_found`; 409 `not_dispatch_work` (make-safe), `line_not_on_order`,
`order_cancelled`, `not_material`, `line_already_received`,
`receipt_id_in_use` (that id is used on another line), `line_changed` (the
database refused because the line moved or the date check failed between the
read and the insert); 500 `deliveries_write_failed`.

### `dispatch_delivery_void_receipt`

Body: `{ job_id, receipt_id }`. Sets `voided_at`, `voided_by`,
`voided_by_email` once. A second void answers `unchanged: true`. Refusals: 400
`invalid_request`; 404 `receipt_not_found`; 500 `deliveries_write_failed`.

### Answer (both writes)

```
{ success: true, unchanged?: true, warning?: {...},
  receipt: { id, quantity, received_on, note, recorded_at, recorded_by,
             voided, voided_at, voided_by },
  line: { id, purchase_order_id, display_status, received_quantity, receipts },
  deliveries: { ...slice 6 summary, on_site, all_on_site, lines_part_delivered },
  counts: { ...the shared materials counts } }
```

`line`, `deliveries` and `counts` are null when the read after the write
failed. The write still happened.

The three slice 6 writes now answer `deliveries` and `counts` through the same
read, so their summary also carries the three S5 fields.

## Reads

`dispatch_materials`:

- Each line on an order adds `received_quantity` (live receipts on its current
  order) and `receipts` (every receipt on its current order, voided ones
  included, oldest first, each with `voided`).
- `display_status` may now be `part_delivered`.
- Lines not on an order are unchanged.
- `deliveries.rows[]` order rows add `on_site` and `lines_part_delivered`.
- `deliveries` adds `on_site`, `all_on_site`, `lines_part_delivered`.
- A failed receipts read is treated as a failed orders read
  (`orders_status: 'failed'`), never as nothing received.

`pipeline&dispatch=1`:

- Rows add `deliveries_orders_on_site` and `deliveries_lines_part_delivered`.
- Materials counts take receipts into account.
- A failed receipts read fails the materials fields, as a failed lines read
  does.

## Database

- `job_material_line_receipts`:
  - The `id` is the client receipt id. `line_id` references
    `job_material_lines` `ON DELETE RESTRICT`. `job_id`, `purchase_order_id`
    and `created_by`/`voided_by` are plain foreign keys (no cascade).
  - Guard trigger `trg_job_material_line_receipts_guard`:
    - On insert, the receipt must match its line's job, org and current order,
      must not be dated after today in Perth, and must be written live.
    - On update, the only change allowed is one void.
    - Deletes are always refused.
  - Row security is on with no policy. All rights are revoked from PUBLIC,
    anon and authenticated; service_role gets SELECT, INSERT and UPDATE.
- `job_material_lines.purchase_order_attached_at` and its trigger, as above.

Contract case: `supabase/tests/migration-contracts/20261020180000_dispatch_line_receipts/`.
Rollback: `supabase/rollbacks/20261020180000_dispatch_line_receipts_down.sql`.
Apply the migration before the matching ops-api (it is in
`scripts/edge-function-schema-requirements.txt`).

## Known limits (v1)

- A line with receipts cannot be deleted (`dispatch_materials_delete_line`
  answers 409 `line_has_receipts`). Void the receipts first. Voided rows still
  hold the foreign key, so in practice such a line stays. The same foreign keys
  stop a job, or a draft order that holds receipts, from being hard-deleted.
- Cancelling an order that has receipts is not blocked. Its receipts stop
  counting because a cancelled order is not counted.
- Two presses with different ids at the same moment on a line with no quantity
  can both land. The read still says delivered.
- The migration version was not checked against the live ledger.
