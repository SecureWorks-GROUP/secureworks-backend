# Dispatch scope order lines, stage 1

Turn a Scope Engine supplier order into lines attached to one scope on a job. This store does not price a line, match a supplier contact, raise a purchase order, or send anything.

The engine that computes the order is `SecureWorks-GROUP/scope-engine-v2` branch `step-2-to-6-wip`: resolve, materials list, `engineDemand`, `createOrder`. This repository does not vendor that engine. It imports the `supplier-order/v1` document `createOrder` writes.

## Actions

Both are staff-only, the same gate as Materials by supplier: a staff session (`admin`, `owner`, `ops_manager`) or the privileged ops key. They are not on the routine, agent-read, or lead-installer lists.

- `GET dispatch_scope_order_lines?job_id=` reads every scope's stored lines for the job.
- `POST dispatch_scope_order_import` body `{ job_id, scope_id, order_version, order }` replaces that scope's lines and leaves every other scope on the job.

`scope_id` is the source document id (an example job's `id`, such as `example-attached-fascia`). `order_version` is the caller's version string (the engine's `revisions.catalogue`, `patio-bought-items-2026-10-17` on these fixtures). It is stored and updated. It is not part of the row key.

A make-safe job is allowed. The patio-only `dispatch_materials_suggest` path is a different reader of the old scoping-tool `scope_json` and is not used here. This action does not select `scope_json`.

## Accepted `order` documents

The body is measured as UTF-8 JSON before it is parsed. Over 2,000,000 bytes is `order_too_large` and writes nothing.

1. `{ schemaVersion: "supplier-order/v1", suppliers, unresolved, cutList }`. This is what `createOrder` writes. One stored line per purchase line. `lengthMm` is the bar to buy (`stock_length_mm`, `stock_qty` = the purchase quantity). `cuts` are the piece lengths, coalesced. `length_mm` is that piece length when every cut is the same length, otherwise null. `cutList` is not extra lines. When a purchase line has no cuts, the matching `cutList` demand fills them. When it has no element references, `cutList.references` fills those. A `cutList` entry with no demand id is refused. Cuts already on the purchase line are the pieces on that bar and are not replaced by a fuller `cutList`. `sku`, `cost`, `specification`, `candidates` and `knownSubtotalExGst` are ignored.
2. `{ schema: "scope-engine-order/v1", lines: [...] }`. Quantity and length are numbers or null. A string is refused. A stated length that disagrees with the cuts is the buy length; the cuts stay the pieces. `product_unknown: true`, a `to_confirm` note other than the generic price note, or `unresolved: true` flags the product and keeps a stated product. A `to_confirm` list that is only `to confirm` sets `price_to_confirm` and leaves a named product known. A blank product is always flagged. `candidates` are ignored.
3. A demand list. `product` is `engineKey`. The supplier is always null. The stated cut length is the piece (`length_mm`); `stock_length_mm` and `stock_qty` stay null. Cuts use `lengthMm`. A line whose key contains the word "unknown" is not flagged for that reason.

`{ schema: "scope-engine-v2/job@1" }` is refused. A job's members are not quantities or cut lengths. Import the supplier order.

An unresolved demand is its own flagged line. A purchase line whose demands are all unresolved is dropped, because those rows cover it. A purchase line that mixes unresolved and known demands is not stored and not split: the known demand ids come back in `withheld_demand_ids`.

`createOrder` numbers demands `material-1`, `material-2`, in document order. Those numbers are not the row key. A positional id is rewritten from the sorted element references, the product and the buy length. A caller-supplied id (`fence-rails`, `post-1`) stays. Two stock lengths of the same demand are two rows. Quantity is not part of the id, so a changed quantity updates the same row.

An empty parse is `no_lines` and writes nothing, so a bad payload cannot wipe the scope. A repeated demand id in one document is refused and writes nothing. Missing `scope_id` or `order_version` is `invalid_request` before any table is opened.

## What a row is

`dispatch_scope_order_lines` is keyed on `(job_id, scope_id, demand_id)`. The row id is the SHA-256 of `dispatch-scope-order:<job id>:<scope id>:<demand id>`, so a retry of the same scope is the same row and a fence `post-1` is a different row from a patio `post-1`. `element_refs` stores the engine's element references. `cuts` stores piece lengths. `stock_length_mm` and `stock_qty` store the bar to buy.

Re-import of one scope runs `dispatch_replace_scope_order_lines` and replaces only that scope, in that function's transaction. The function snapshots the scope, deletes it, then inserts the new lines: one statement cannot see its own delete through the primary key, so a re-import of the same row id would otherwise raise a duplicate key. A demand that is still present keeps `created_at`, `created_by` and `created_by_email`. Demands that left are counted in `removed`.

The table has no `supplier_id`, no price, and no `purchase_order_id`. A stated `supplier_name` is text only. `price_to_confirm` is the generic price note, not a price. Unknown products are flagged and never guessed. The response always carries `sends: false`. No email, Xero, `job_events`, or `business_events` write happens here.

## Example orders

`supabase/functions/ops-api/scope_engine_examples/` are the engine's `examples/` inputs, including `scope-engine-v2/job@1`. They are not imported as members.

`supabase/functions/ops-api/scope_engine_orders/` are price-stripped `supplier-order/v1` documents produced by `createOrder` on `step-2-to-6-wip` for attached-fascia, attached-wall, carport and courtyard. Revisions are `patio-bought-items-2026-10-17`. `toConfirm` notes are reduced to the generic `to confirm` price note, stored as `price_to_confirm`. A named `productId` with only that note stays `product_unknown: false`. On fascia, wall and carport the rafters and purlins share the RHS purchase lines. On courtyard the purlins and the rafters are separate lines.

A fence post is not an engine patio post. The stored rule is a 2550 mm cut (1800 sheet + 150 plinth rail + 600 in the ground) on a 2700 mm stock post.

Stage 2 (`docs/dispatch-scope-material-lines-v1.md`) matches the stated supplier name and copies known lines onto `job_material_lines`.
