# Dispatch scope order lines, stage 1

Turn a Scope Engine material order into lines attached to one job, with no retyping. This is the first store. It does not price a line, match a supplier contact, raise a purchase order, or send anything.

The numbered seven-stage design was not in this repository or in `scope-engine-v2`. The input shapes below follow the engine's own order document (`docs/ORDER-FORM.md` on `step-2-to-6-wip`) and the user's stage-1 requirements.

## Actions

Both are staff-only, the same gate as Materials by supplier: a staff session (`admin`, `owner`, `ops_manager`) or the privileged ops key. They are not on the routine, agent-read, or lead-installer lists.

- `GET dispatch_scope_order_lines?job_id=` reads the job's stored lines.
- `POST dispatch_scope_order_import` body `{ job_id, order }` replaces that job's scope-order snapshot with the parsed lines.

A make-safe job is allowed. The patio-only `dispatch_materials_suggest` path is a different reader of the old scoping-tool `scope_json` and is not used here. This action does not select `scope_json`.

## Accepted `order` documents

1. `{ schema: "scope-engine-order/v1", lines: [...] }`. Quantity and length are numbers or null. A string is refused. `product_unknown: true`, a non-empty `to_confirm`, or `unresolved: true` flags the line and keeps a stated product. A blank product is always flagged. `candidates` are ignored.
2. `{ schemaVersion: "supplier-order/v1", suppliers, unresolved, cutList }`. One stored line per purchase line. `demand_id` is the single demand, or the sorted demand ids joined with `|`. `product` is `productId`. `sku`, `cost` and `candidates` are ignored. `cutList` is not extra lines. An unresolved demand is its own flagged line. A purchase line whose demands are all unresolved is dropped, because those rows cover it. A purchase line that mixes unresolved and known demands is not stored and not split: the known demand ids come back in `withheld_demand_ids`.
3. A demand list. `product` is `engineKey`. The supplier is always null. Colour, profile and references are not a supplier. Cuts use `lengthMm`. A line whose key contains the word "unknown" is not flagged for that reason.
4. `{ schema: "scope-engine-v2/job@1", elements }`, stated members only. Roof areas and drawing profiles are skipped. A member with `from` and `to` has quantity 1 and a plan length (the rounded hypotenuse). A post, riser or bracket with no span has no length. A member-set or truss-set uses `layout.count` when it is stated, including 0, otherwise the number of offsets. `ends: true` does not add pieces. Covering, infill and gutter quantity is null. Each downpipe is its own line. A flashing's profile is not the product, so the product is blank and flagged. An unrecognised kind is flagged and kept. Nothing on a job element is read as a supplier.

An empty parse is `no_lines` and writes nothing, so a bad payload cannot wipe the job. A repeated demand id in one document is refused and writes nothing. The same demand on the same job updates the existing row. Demands absent from the new document are removed after the save. The row id is the SHA-256 of `dispatch-scope-order:<job id>:<demand id>`, so a retry is the same row.

## What a row is not

`dispatch_scope_order_lines` has no `supplier_id`, no price, and no `purchase_order_id`. A stated `supplier_name` is text only. Unknown products are flagged and never guessed. The response always carries `sends: false`. No email, Xero, `job_events`, or `business_events` write happens here.

## Example jobs

The fixtures under `supabase/functions/ops-api/scope_engine_examples/` are the `examples/` directory of `scope-engine-v2` branch `step-2-to-6-wip`. They are not the sealed rounds and not the held-out set. `createOrder` is not run: a geometry job's lines are the members it states, not nested stock.
