# Dispatch scope material lines, stage 2

Copy a stored Scope Engine order onto the job's existing material list. Stage 1 (`docs/dispatch-scope-order-lines-v1.md`) stores the order. This step matches the supplier name and copies the known lines. It does not price a line from the order, create a supplier, raise a purchase order, or send.

## Actions

Both are staff-only, the same gate as stage 1. They are not on the routine, agent-read, or lead-installer lists. Every response carries `sends: false`.

- `GET dispatch_scope_material_lines?job_id=` reads the job's `job_material_lines` rows, including lines this step did not write. Each row includes `created_by` and `updated_by`.
- `POST dispatch_scope_order_apply` body `{ job_id, scope_id }` copies that scope. A caller-supplied `unit_price` is ignored.

Apply reads the stored scope-order rows. It does not read `jobs.scope_json` and it does not accept an order document. Import first.

## Supplier match

The stated `supplier_name` is compared with `suppliers.name` and `suppliers.aliases` after Unicode normalise, trim, lower case, and collapsed internal spaces. Punctuation, "Pty Ltd" and a place name are not removed, so Metroll does not match Metroll Perth.

One active record wins. `is_active` null counts as active here, because the column is missing on the contract-stack suppliers stub; slice 4's add button still requires `is_active` true. Two active hits are `ambiguous`. None is `unmatched`. Only inactive hits are `unmatched` with reason `supplier_inactive`. A blank name is `supplier_not_stated`. The stored flag is `matched`, `unmatched` or `ambiguous`. Nothing in this step inserts into `suppliers`.

A matched supplier that is not yet on the job gets one `job_material_suppliers` row. A contact already on the job keeps its `supplier_name`. Removing lines does not remove that row.

## What is copied

A line is copied only when `product_unknown` is false, `product` is set, and the supplier match is exactly one active supplier. It is inserted into `job_material_lines` with `status` `to_order` and `source` `scope`. The row carries `product`, `quantity`, `length_mm` (the piece), `stock_length_mm`, `stock_qty`, `cuts`, the matched `supplier_id`, and `scope_id` plus `demand_id`. The row id is the SHA-256 of `dispatch-scope-material:<job id>:<scope id>:<demand id>`.

`unit_price` is set only when `material_price_ledger` has a `confirmed` row whose `material_code` is the engine product id and whose `supplier_name` normalises to the matched supplier's name or a known alias. Newest `confirmed_at`, then the smaller id, wins. Pending and dismissed rows do not count. A negative or non-numeric price is skipped. Anything else stores null. A failed ledger read, or a full page at the 200-row cap, fails the apply and writes nothing.

Lines that are not copied come back in `flagged` with `unknown_product`, `supplier_unmatched`, `supplier_ambiguous`, `supplier_inactive` or `supplier_not_stated`. A line can carry a product reason and a supplier reason.

## Replace

`dispatch_replace_scope_material_lines` is the one writer. It replaces only that scope's lines that are not already on a purchase order. A line with `purchase_order_id` set is left as stored, and it is not inserted again. Manual lines (`scope_id` and `demand_id` null, including a slice 4 suggestion) and every other scope stay. Re-apply keeps `created_at`, `created_by` and `created_by_email` for a demand that is still present.

An apply whose scope has stored order lines but nothing copyable still clears that scope's not-on-order material lines and writes the flags. An apply whose scope has no stored order lines is `no_lines` and writes nothing. Re-importing the scope order clears `supplier_match`; the next apply sets it again.

The job cap is 500 material lines, the same cap as `dispatch_materials_save_line`. The count is lines that will remain plus lines this apply will insert. Over the cap is `too_many_lines` and writes nothing.

## Price note

`product_unknown` is false when the engine named a `productId` and every `toConfirm` note is the generic `to confirm`. `price_to_confirm` records that note. A different note, an unresolved demand, or a blank product keeps `product_unknown` true. `price_to_confirm` is not a price and is not copied onto the material line.
