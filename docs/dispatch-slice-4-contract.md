# Dispatch slice 4: Materials by supplier, back-end contract

What `ops-api` gives the Ops screen's Dispatch tab for Materials by supplier: the
suppliers chosen for a job, an editable table of material lines under each
supplier, the working-out pad and the sketch, the job's existing purchase orders
(read only), and "x of y items ready" on the job card. One read, seven writes and
two fields on the Dispatch list.

Code: `supabase/functions/ops-api/dispatch_materials.ts` (the rules, pure),
`supabase/functions/ops-api/dispatch_materials_store.ts` (the read and the seven
writes), the `pipeline` enrichment wave and the action switch in
`supabase/functions/ops-api/index.ts`. Migration:
`supabase/migrations/20261014130000_job_materials_by_supplier.sql` (rollback
`supabase/rollbacks/20261014130000_job_materials_by_supplier_down.sql`, contract
case `supabase/tests/migration-contracts/20261014130000_job_materials_by_supplier/`).
Tests: `dispatch_materials_test.ts`, run by the "Test the Dispatch list and job
notes reads" step of `.github/workflows/pr-check.yml`.

It makes no purchase order, sends nothing to anyone, moves no money and does not
change a job's status.

## 1. The records

Three tables, all Dispatch-only. Row security on with no policy and every right
revoked from `anon` and `authenticated`: only `ops-api` reaches them.

| Table | One row per | Holds |
|---|---|---|
| `job_material_suppliers` | supplier chosen for a job (`unique (job_id, supplier_id)`) | `supplier_id` (a `suppliers` row), `supplier_name` (the contact's name when chosen), `position`, who and when |
| `job_material_lines` | material line; `id` is made in the browser (a suggested line's by the server, section 5) | `supplier_id`, `description` (1 to 300), `quantity` (`numeric(12,3)`, 0 or more, or null), `unit` (1 to 30, or null), `status`, `purchase_order_id`, `source` (`manual` or `scope`), `position`, who and when created and last changed |
| `job_dispatch_workings` | job, made on the first save | `working_out` (at most 20,000), `sketch_png` (a `data:image/png;base64,` URL, at most 400,000), each with its own updated-at and by-email |

A line's foreign key on `(job_id, supplier_id)` points at
`job_material_suppliers`: a line always sits under a supplier chosen for its own
job, moving a line is one update of `supplier_id`, and a supplier cannot be taken
off a job while a line points at it. Deleting a job deletes all three; deleting a
purchase order clears `purchase_order_id` on its lines.

`status` stores only `not_reviewed`, `to_order`, `in_stock` (a check). No slice 4
action accepts or writes `purchase_order_id`; slice 5 will.

## 2. The one rule: display status and items ready

`dispatch_materials.ts` is the only place either is worked out. The read, every
write's answer and the list's two fields all call it.

- `display_status`: `on_po` when `purchase_order_id` is set, otherwise the stored
  status. Slice 6 adds `delivered` to the same function.
- `counts.total`: every line on the job. `counts.ready`: every line whose display
  status is `in_stock` or `delivered`. In slice 4 that is the lines marked In
  stock and not on an order.

## 3. Who may call

All eight actions: staff sessions (`admin`, `owner`, `ops_manager`) and the
privileged ops key, through `_opsApiCallerIsStaffOperator`, gated in the switch as
`update_repair_stage` is. Refused (403) to a trade session, a division manager,
the routine key (default-deny) and the agent read list. The seven writes are POST
only (405 otherwise). A signed-in person is recorded by the verified session's
user id and email; the ops key has no user and is recorded by the
`operator_email` the screen stamps.

Every action: `job_id` (also `jobId`) missing or not a uuid is 400
`invalid_request`; a job not in the organisation is 404 `job_not_found`; a
make-safe job (by `dispatchWorkType`, so a repair-family job stored as make-safe
is allowed) is 409 `not_dispatch_work`. Every refusal body is
`{ error, code, ... }`.

No action writes `jobs`, `suppliers`, `purchase_orders`, `job_events`,
`business_events`, `job_media` or `job_documents`, and none calls
`ghl-proxy`, `reporting-api`, Xero, storage or any send helper. Who changed a row
and when is kept on the row.

## 4. The read: `GET ops-api?action=dispatch_materials&job_id=<uuid>`

A pure read: the job row, then five reads for that job (chosen suppliers, lines,
workings, purchase orders in one wave; then the chosen suppliers' contacts).

```
{
  job_id, job_number, work_type,
  suppliers: [ { supplier_id, name, email, active, position, added_at } ],
  lines: [ { id, supplier_id, description, quantity, unit, status, display_status,
             purchase_order_id, source, position, updated_at } ],
  counts: { total, ready },
  can_suggest: true | false,
  workings: { working_out, working_out_updated_at, sketch_png, sketch_updated_at },
  orders: [ { id, po_number, supplier_name, status, created_at,
              lines: [ { description, quantity, unit } ] } ],
  orders_status: 'ok' | 'failed'
}
```

| Field | Rule |
|---|---|
| `suppliers` | In `position` order. `name` and `email` from the supplier contact as it is now (email trimmed, null when blank). A contact that is gone or not active: `name` is the stored `supplier_name`, `email` null, `active` false. |
| `lines` | Every line on the job, in `position` order, paged past the 1,000-row ceiling. `quantity` is a number or null. |
| `can_suggest` | True only when the work type is `patio` or `fencing` and the job has no line at all (the press answers `no_frozen_scope` when there is no frozen revision). |
| `workings` | Every field null when the job has no row yet. This is the only read that returns `sketch_png`. |
| `orders` | The job's purchase orders, every status except `deleted`, oldest first. Only `id, po_number, supplier_name, status, created_at, line_items` are selected. Each stored line is flattened to `description`, `quantity` and `unit` (null where the line has none; text and numbers as stored). No price, total, account code or tax field is returned. Never written. |
| `orders_status` | `failed` when the orders read failed: then there is no `orders` key and the lines still show. |

A failed chosen-suppliers, lines, workings or supplier-contacts read answers 500
`materials_read_failed`, never an empty section.

## 5. The writes

All POST. Every success carries `counts: { total, ready }` for the job, read after
the write. If that one read fails after the write landed, `counts` is `null`
(never a made-up 0): keep the figure already shown.

### `dispatch_materials_add_supplier` `{ job_id, supplier_id }`

| Case | Answer |
|---|---|
| Added | `{ success, supplier: <read shape>, counts }`; the supplier goes last |
| Already on the job | `{ success, unchanged: true, supplier, counts }`, nothing written |
| `supplier_id` not a uuid | 400 `invalid_request` |
| Not a supplier contact of the organisation | 404 `supplier_not_found` |
| Contact not active | 409 `supplier_inactive` |

A contact with no email can be chosen; nothing is blocked.

### `dispatch_materials_remove_supplier` `{ job_id, supplier_id }`

| Case | Answer |
|---|---|
| Removed | `{ success, counts }` |
| Not on the job | `{ success, unchanged: true, counts }` |
| A line sits under it | 409 `supplier_has_lines`, nothing deleted |

### `dispatch_materials_save_line` `{ job_id, line: { id, supplier_id, description, quantity, unit, status }, expected_updated_at }`

| Case | Answer |
|---|---|
| No line with that `id`: insert | `{ success, line, counts }`. `status` left out means `not_reviewed`; `source` is `manual`; the line goes last. Leave `expected_updated_at` out. |
| A line with that `id` on this job, no `expected_updated_at` (a retried insert) | `{ success, unchanged: true, line, counts }`, the stored line, nothing written |
| A line with that `id` on this job, with `expected_updated_at`: update | Guarded on the stamp. `{ success, line, counts }`. `status` left out keeps the stored one. A changed `supplier_id` moves the line and puts it last in the job. |
| Stored `updated_at` differs from `expected_updated_at`, or the line is gone and `expected_updated_at` was sent | 409 `line_changed` with `line` (the stored line; `null` if it was removed), nothing written |
| A line with that `id` on another job | 409 `line_not_on_job` |
| `supplier_id` not chosen for this job | 409 `supplier_not_on_job` |
| The line is on a purchase order | 409 `line_on_order` with `line`, nothing written |
| The insert would take the job past 500 lines | 409 `too_many_lines` |
| `line` missing; `id` or `supplier_id` not a uuid; `description` not 1 to 300 after trimming; `quantity` not a number 0 or more (a string such as `"3"` or `"abc"` is refused, never coerced) or above 999,999,999.999; `unit` over 30 after trimming (empty becomes null); `status` not one of the three | 400 `invalid_request` |

`purchase_order_id` and `source` sent by a caller are ignored.

### `dispatch_materials_delete_line` `{ job_id, id, expected_updated_at }`

| Case | Answer |
|---|---|
| Deleted | `{ success, counts }` |
| Already gone | `{ success, unchanged: true, counts }` |
| `expected_updated_at` missing | 400 `invalid_request` |
| Stamp differs | 409 `line_changed` with `line` |
| On another job / on an order | 409 `line_not_on_job` / `line_on_order` |

### `dispatch_materials_suggest` `{ job_id, supplier_id }`

Since 19 Oct 2026 the scope is the job's latest **frozen** `scope_revisions`
row (`scope_canonical_text`, the same scoper JSON), never the live
`jobs.scope_json` (a draft revision can sit after the frozen one). No frozen
revision is 409 `no_frozen_scope`; text that is not JSON is 409
`scope_unreadable`. The answer adds `scope_revision_number`. Fencing jobs use
the fence designer's rules (`docs/dispatch-fence-scope-lines-v1.md`); a patio
reads its frozen scope once (`pricing_json` is never
selected), runs `extractMaterialsFromScope(scope, null)` unchanged, and
inserts one line per item under that supplier with `source: 'scope'` and
`status: 'not_reviewed'`. With null pricing the extractor's quote-lines fallback
cannot run, so a customer's quote line and its price never become a material
line.

A patio answer also carries `held` and `scope_supplier: null`. The live
`jobs.scope_json` is read once for that job only to warn: it runs through the
same extractor with null pricing, and when its lines differ from the frozen
revision's, `held` carries "The scope was changed after it was frozen: check
these lines against the latest scope." A failed read, no live scope or one the
extractor cannot read gives "Could not check whether the scope was changed after
it was frozen: ...". The lines always come from the frozen revision.

Two presses at once both pass the no-lines read and both insert; a suggested
line's id is fixed by job and place, so the database key on the line id lets one
set in and the other press gets 409 `lines_exist` with nothing written (one
multi-row insert is all or nothing). Tested with three presses at once.

Each suggested line's `id` is a uuid made from the job id and the line's place in
the suggestion, so two presses that both find no lines insert the same ids: the
second insert clashes on the primary key and answers `lines_exist`, and the scope
lines land once.

Cleaning: the long dash (and an en dash) with the spaces round it becomes `", "`,
the multiplication sign becomes `x`, spaces collapse, trimmed to 300. `quantity`
as given (a numeric string reads as its number, anything else as null); `unit` as
given, else null. `unit_price` and `notes` are never stored. An item with no
description is dropped.

| Case | Answer |
|---|---|
| Lines added | `{ success, added: <n>, lines: [...], counts }` |
| The scope gives nothing | `{ success, added: 0, lines: [], counts }` |
| Work type not `patio` or `fencing` | 409 `no_suggestion_for_work_type` |
| No frozen scope revision (a live scope alone included) | 409 `no_frozen_scope` |
| Supplier not on the job | 409 `supplier_not_on_job` |
| The job already has any line, including a second press landing at the same time | 409 `lines_exist` |
| The extractor throws on the stored scope | 409 `scope_unreadable` (never `added: 0`) |

A scope shaped like SWP-26701's gives the four lines in the slice 4 build note
section 9.2; the test drives the real extractor on that shape.

Each suggested line also records where it came from (migration
`20261019200000`, applied before the ops-api that reads it): `source_kind`
(`fence_scope_revision` or `patio_scope_revision`), `source_version_id` (the
frozen `scope_revisions` row), `source_version` (its revision number as text)
and `source_line_id` (the material key, below). Every line the read returns
carries `source_version` (null on a hand-made line). A unique index on
`(job_id, source_version_id, source_line_id)` means one revision's material is
taken once per job.

### `dispatch_materials_suggest_changes` `{ job_id, supplier_id }`

The variation press (delivery slice S7, materials). After the scope is frozen
again, it adds only what the newest frozen revision asks for beyond the revision
the job's scope lines were last taken from (the highest `source_version` they
name), onto a supplier already chosen on the job. It compares the two frozen
revisions by material key, never the lines on the job, so no existing line is
changed or second-guessed: a quantity a person edited, a line a person deleted
and a line already on an order all stay as they are.

The material key is `m:<description, lower case, spaces collapsed>|<unit>`
(cut with a short hash past 96 characters); a second line of the same material
in one revision is `<key>#2`, and the two add up when compared.

- A material the newer revision asks more of: one new line for the difference.
- A material it newly asks for: its lines as suggested.
- Every added line is `not_reviewed`, `source: 'scope'`, no price, no order, no
  send, positioned after the job's last line, and names the newer revision, so
  it becomes the base for the next press.
- A material it asks less of (`changes.reduce`), no longer asks for
  (`changes.removed`, `after: 0`), or that has no quantity on either side
  (`changes.unchecked`) is listed as `{ description, unit, before, after }` for a
  person; nothing is written for it. A revision that only reduces adds nothing,
  so the base stays and the reduction keeps being listed. Once a press adds
  anything, the newer revision becomes the base, so its reductions are listed
  on that press only: act on them then.
- The base revision is read whether it is still `frozen` or was `superseded` by
  the newer freeze; a draft never is.
- Materials are matched by key, so a material the scoper renamed or gave a new
  unit reads as removed plus new: the new name's full quantity is added and the
  old one is listed under `removed`. Check both before ordering.

| Case | Answer |
|---|---|
| Lines added | `{ success, added, lines, changes, up_to_date: false, taken_from_revision_number, scope_revision_number, held?, scope_supplier?, counts }` |
| The lines already come from the newest frozen revision | `added: 0`, `up_to_date: true`, nothing written |
| Only reductions, removals or uncomparable materials | `added: 0`, `up_to_date: false`, `changes` filled, nothing written |
| Work type not `patio` or `fencing` | 409 `no_suggestion_for_work_type` |
| Supplier not on the job | 409 `supplier_not_on_job` |
| No scope lines on the job | 409 `no_scope_lines` (use `dispatch_materials_suggest`) |
| A scope line without its source recorded (made before the migration, or with no numeric `source_version`) | 409 `source_not_recorded`: compare by hand |
| The base revision can no longer be read | 409 `base_scope_missing` |
| The base revision is newer than the latest frozen one | 409 `base_scope_newer` |
| A second press landing at the same time | 409 `changes_already_taken` (ids are fixed by job, revision and key) |
| More than the job's line limit | 409 `too_many_lines` |
| No frozen revision, or one that cannot be read | 409 `no_frozen_scope` / `scope_unreadable` |

### `dispatch_materials_save_workings` `{ job_id }` plus exactly one of

- `working_out`: text, at most 20,000; an empty string clears it. Guard:
  `expected_working_out_updated_at`.
- `sketch_png`: a string starting `data:image/png;base64,` whose decoded bytes
  begin with the PNG signature, at most 400,000 characters; `null` clears it.
  Guard: `expected_sketch_updated_at`.

The two are guarded separately, so saving the text never collides with saving
the sketch. On a job with no row the expected stamp is null (or left out).

| Case | Answer |
|---|---|
| Saved | `{ success, workings: { working_out_updated_at, sketch_updated_at }, counts }`; the sketch is never sent back |
| Stamp differs | 409 `workings_changed` with `field` and that field's stored value and stamp |
| Neither or both fields; a bad value | 400 `invalid_request` with the server's own message (for an over-400,000 sketch the screen shows "Sketch not saved: too large") |

## 6. The Dispatch list: `GET ops-api?action=pipeline&dispatch=1`

Per row, when the materials read worked:

| Field | Type | Meaning |
|---|---|---|
| `materials_lines_total` | integer | lines on the job (0 for a job with none) |
| `materials_lines_ready` | integer | lines whose display status is In stock or Delivered |

At the top of the answer: `dispatch_materials: 'ok' | 'failed'` (also on an empty
answer).

- One more enrichment read in the same `Promise.all` wave, the last entry:
  `job_material_lines` for every returned job, selecting
  `job_id, status, purchase_order_id` only. It never reads `job_dispatch_workings`
  or a description.
- A failed read answers `dispatch_materials: 'failed'`, leaves both fields off
  every row and is logged. It does not mark the list `degraded`.
- Without `dispatch=1` none of this runs and the answer is unchanged.

Cost on production: not observed. The read did not exist when this was written,
and no production credential was used. Measure `pipeline&dispatch=1` wall time
before and after the deploy and record both figures here.

## 7. Where the build note and the code differ

- `purchase_orders.status` is `NOT NULL` live, so the orders read uses
  `.neq('status', 'deleted')` without dropping any row.
- The note's suggestion section says "`quantity` as given". The extractor passes a
  stored beam count through as it is, which can be text; the suggestion reads a
  numeric string as its number and anything else as no quantity, rather than
  storing text in a numeric column.
- The note does not say what a write answers when its own after-write counts read
  fails; it answers `counts: null` (section 5).
- The note does not say what the suggestion does with a scope the extractor
  throws on; it answers 409 `scope_unreadable` rather than `added: 0`, so an
  unreadable scope never looks like an empty one.
- `OPS_AGENT_SERVER_KEY` is classified as the server key today
  (`_resolveOpsApiAuthIntent`), so the "agent read list" refusal is proved by the
  eight actions' absence from `AGENT_READ_ALLOWED_ACTIONS`.
