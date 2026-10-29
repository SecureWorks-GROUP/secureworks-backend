# Dispatch v2 board: backend contract

Branch `feat/dispatch-board-v2` (worktree `be-dispatch-board-v2`). Slices 1, 3
(backend side), 4 (backend side) and 7 (data) of the Dispatch v2 brief.
Rules: `supabase/functions/ops-api/dispatch_board.ts`. Tests:
`dispatch_board_test.ts`, `dispatch_po_guard_test.ts`,
`send-po-email/send_po_email_test.ts`.

Nothing here is deployed or applied. The migration below is a file only.

## The rules in business words

- The Dispatch list shows a job only when its **real** pipeline status is Order
  Materials, Awaiting Supplier, Order Confirmed, Schedule Install, Scheduled,
  In Progress or Rectification, and its type is fencing, patio or decking.
  In Progress and Rectification were added 27 Oct 2026 (Shaun and Marnin:
  extra materials, a flashing or a downpipe, are ordered once the crew is on
  site); they stay in Active whatever the install day and never carry
  `install_date_passed`. A repair shows when its Repairs
  board stage is Materials or Scheduled. Nothing earlier, no make-safes (even
  for a search), no insurance or miscellaneous jobs, no test records, no legacy
  jobs. The legacy `processing` status is not shown.
- `job_dispatch_state` (the v1 Dispatch-only stage rail) decides nothing on the
  v2 board.
- **Archive** is Dispatch's own view and never changes the real status. A
  Scheduled job goes there the day after its last install day (Perth time; a
  booking's `scheduled_end` counts). A job already moved past Rectification
  (Complete, Final Payment, Invoiced...) is also in Archive, placed by its install
  day; with no install booking at all it is in neither view. Archive shows the
  last 30 days by last install day; a search shows every Archive job, however
  old.
- A Scheduled job with nothing booked stays in Active with `no_install_booked`.
- An earlier stage whose install day has already gone stays Active with
  `install_date_passed` (only Scheduled leaves by date).
- A tentative booking counts as booked (most bookings are tentative).
- Deposit: paid is the Ops Dash rule (a PAID ACCREC invoice whose reference
  carries DEP). Repairs need no deposit. A failed invoice read is `unknown`,
  never "not paid".
- Days in stage: whole Perth days since the change that moved the job into its
  current status (`status_changed` job_events) or Repairs stage
  (`repair_stage_changed`). A re-save of the same status does not restart the
  count; a move out and back in does. Scheduled with no event falls back to
  `jobs.scheduled_at`. Otherwise `null` with source `unknown`.

## 1. `pipeline` with the v2 board

`GET ops-api?action=pipeline&dispatch=1&board=v2[&view=active|archive][&search=...]`

Staff only (same gate as `pipeline&dispatch=1`). `view` defaults to `active`;
any value other than `archive` is Active. Without `board=v2` the answer is
exactly the v1 answer (tested).

The answer is the usual pipeline answer (`columns`, `total`, the v1
`dispatch_*` status keys) with two additions:

- every kept row has a `board` object;
- the top level has a `board` summary.

`columns` and `total` hold only the rows on the view asked for. The v1 row
fields (`dispatch_stage`, `dispatch_todo`, `dispatch_install`, ...) and
`todo_total` are still on the answer for old callers; **a v2 screen must
ignore them** and read `board` only.

### Row `board` (example: Active, Scheduled patio)

```json
{
  "view": "active",
  "track": "pipeline",
  "stage_key": "scheduled",
  "stage_label": "Scheduled",
  "stage_order": 5,
  "stage_phase": "window",
  "real_status": "scheduled",
  "repair_stage": null,
  "title": "SWF-1003 · Jane Mary Smith",
  "job_number": "SWF-1003",
  "client_name": "Jane Mary Smith",
  "suburb": "Balcatta",
  "work_type": "patio",
  "days_in_stage": 3,
  "in_stage_since": "2026-10-20T02:00:00Z",
  "days_in_stage_source": "status_event",
  "install": {
    "booked": true,
    "day": "2026-10-25",
    "first_day": "2026-10-25",
    "last_day": "2026-10-25",
    "archive_on": "2026-10-26",
    "passed": false,
    "tentative": true
  },
  "deposit": { "required": true, "paid": false, "state": "not_paid" },
  "flags": {
    "deposit_not_paid": true,
    "no_install_booked": false,
    "install_date_passed": false
  },
  "moves": {
    "action": "update_job_status",
    "field": "status",
    "current": "scheduled",
    "targets": [
      { "key": "order_materials", "label": "Order Materials", "direction": "back" },
      { "key": "awaiting_supplier", "label": "Awaiting Supplier", "direction": "back" },
      { "key": "order_confirmed", "label": "Order Confirmed", "direction": "back" },
      { "key": "schedule_install", "label": "Schedule Install", "direction": "back" }
    ]
  },
  "arrival": {
    "today": "2026-10-23",
    "install_day": "2026-10-25",
    "orders": [
      {
        "key": "box:6f1c...",
        "source": "supplier_box",
        "supplier_id": "6f1c...",
        "supplier_name": "Stratco",
        "order_sent": true,
        "sent_at": "2026-10-19T00:00:00Z",
        "delivery_date": "2026-10-24",
        "date_source": "box",
        "date_confirmed": true,
        "box_id": "9a2e...",
        "box_date_source": "by_hand",
        "box_date_set_at": "2026-10-22T03:00:00Z",
        "box_date_set_by_email": "shaun@...",
        "fulfilment": "delivery",
        "mark": "solid",
        "flag": null
      }
    ],
    "counts": { "orders": 1, "sent": 1, "confirmed": 1, "late": 0 },
    "all_confirmed_in_time": true
  }
}
```

Field notes:

| Field | Values |
|---|---|
| `track` | `pipeline` (fencing, patio, decking) or `repairs` |
| `stage_key` | pipeline: `order_materials`, `awaiting_supplier`, `order_confirmed`, `schedule_install`, `scheduled`; repairs: `materials`, `scheduled`. In Archive also a later status (`in_progress`...) or repair stage (`on_site`, `complete`) |
| `stage_phase` | `window` (one of the board stages) or `after` (past Scheduled, Archive only) |
| `stage_order` | 1-based position in the track; 0 when `after` |
| `real_status` | `jobs.status` as stored |
| `repair_stage` | the Repairs stage for a repair, else null |
| `title` | `"<job number> · <full client name>"` |
| `days_in_stage_source` | `status_event`, `repair_stage_event`, `status_stamp`, `unknown` |
| `install` | null when the bookings read failed. `day` is the earliest install day on or after today, else the latest. `tentative` = every booking on `day` is still tentative |
| `deposit.state` | `paid`, `not_paid`, `not_required` (repair), `unknown` (invoice read failed) |
| `flags.deposit_not_paid` | red "Deposit not paid": only when `state` is `not_paid` |
| `flags.no_install_booked` | amber "No install booked": Scheduled, bookings read fine, nothing booked |
| `flags.install_date_passed` | a stage before Scheduled whose install days are all past |
| `moves` | null for a job past Scheduled (moved from the Ops Dash, not Dispatch) |
| `arrival` | null when an Arrival read failed (see `board.reads.arrival`) |

Arrival order fields:

| Field | Values |
|---|---|
| `key` | `box:<supplier_id>` for a supplier box, `po:<id>` for a purchase order under no box |
| `source` | `supplier_box`, `dispatch_order` (v1 Dispatch PO), `other_order` (a material PO made elsewhere) |
| `order_sent` | the supplier's v2 order email has status `sent` (a test copy never counts), or the v1 PO status says sent |
| `delivery_date` | the box's own date, else the date our sent email asked for, else the v1 PO's confirmed or expected date |
| `date_source` | `box`, `requested` (from our email, never confirmed), `order`, or null |
| `date_confirmed` | box: `delivery_date_confirmed_at` set; PO: `confirmed_delivery_date` set |
| `box_id` | the supplier box's id (what `dispatch_v2_set_delivery_date` takes); null for a PO |
| `box_date_source` | how the box's OWN date was set: `by_hand` or `supplier_reply`; null when the box has no date of its own (or for a PO) |
| `box_date_set_at`, `box_date_set_by_email` | when and by whom the box's own date was last set; null as above. Send `box_date_set_at` back as `expected_set_at` |
| `fulfilment` | `delivery` or `pickup`, read from the opening line of the box's newest sent order email (`for pickup:`); null for a PO or a box with nothing sent. The screen then says Delivery |
| `mark` | `solid` (confirmed), `ring` (date, not confirmed), `none` (no date) |
| `flag` | `no_date` (sent, no date yet: red), `after_install` (date after the install day: red), `not_sent` (still being put together, not red), or null |
| `counts.late` | orders flagged `no_date` or `after_install` |
| `all_confirmed_in_time` | at least one order, every one confirmed and none after the install |

Cancelled, deleted and labour/subcontract POs are never on the Arrival line.

### Top-level `board` (example: Active)

```json
{
  "version": "v2",
  "view": "active",
  "today": "2026-10-23",
  "searching": false,
  "archive_days": 30,
  "archive_from": "2026-09-23",
  "stages": {
    "pipeline": [
      { "track": "pipeline", "key": "order_materials", "label": "Order Materials", "order": 1 },
      { "track": "pipeline", "key": "awaiting_supplier", "label": "Awaiting Supplier", "order": 2 },
      { "track": "pipeline", "key": "order_confirmed", "label": "Order Confirmed", "order": 3 },
      { "track": "pipeline", "key": "schedule_install", "label": "Schedule Install", "order": 4 },
      { "track": "pipeline", "key": "scheduled", "label": "Scheduled", "order": 5 }
    ],
    "repairs": [
      { "track": "repairs", "key": "materials", "label": "Materials", "order": 1 },
      { "track": "repairs", "key": "scheduled", "label": "Scheduled", "order": 2 }
    ]
  },
  "reads": { "installs": "ok", "days_in_stage": "ok", "deposits": "ok", "arrival": "ok" },
  "groups": [
    { "key": "order_materials", "track": "pipeline", "label": "Order Materials", "count": 1, "job_ids": ["..."] },
    { "key": "awaiting_supplier", "track": "pipeline", "label": "Awaiting Supplier", "count": 0, "job_ids": [] },
    { "key": "order_confirmed", "track": "pipeline", "label": "Order Confirmed", "count": 0, "job_ids": [] },
    { "key": "schedule_install", "track": "pipeline", "label": "Schedule Install", "count": 0, "job_ids": [] },
    { "key": "scheduled", "track": "pipeline", "label": "Scheduled", "count": 2, "job_ids": ["...", "..."] },
    { "key": "repair_materials", "track": "repairs", "label": "Repairs: Materials", "count": 1, "job_ids": ["..."] },
    { "key": "repair_scheduled", "track": "repairs", "label": "Repairs: Scheduled", "count": 0, "job_ids": [] }
  ],
  "total": 4
}
```

- Active always has these seven groups, in this order, empty ones included.
  Scheduled groups are sorted by install day (soonest first, nothing booked
  last); the others by days in stage (longest waiting first); ties by job
  number.
- Archive has one group `{ "key": "archive", "track": "archive", "label": "Archive", ... }`,
  sorted by last install day, newest first.
- `archive_from` is the oldest last install day Archive shows without a
  search; null while searching.
- `reads.*` is `failed` when that side read failed. A failed read never hides
  a job: a failed bookings read keeps every window job Active (no amber flag)
  and Archive comes back empty; failed events give `days_in_stage: null`; a
  failed invoice read gives deposit `unknown`; a failed Arrival read gives
  `arrival: null`.
- An answer with no jobs still carries the full `board` summary.

## 2. `dispatch_arrival` (new, pure read)

`GET ops-api?action=dispatch_arrival&job_id=<uuid>` (`jobId` also accepted).
Staff sessions and the privileged ops key only (403
`operator_access_required` otherwise). Not on the trade, routine or agent-read
lists. For the job screen's full Arrival line.

Errors: 400 `invalid_request` (missing or malformed id, before any query),
404 `not_found`, 409 `not_dispatch_work` (make-safe, insurance, other types).

```json
{
  "job_id": "00000000-0000-4000-8000-000000000003",
  "job_number": "SWF-1003",
  "work_type": "patio",
  "stage": { "track": "pipeline", "key": "scheduled", "label": "Scheduled", "order": 5, "phase": "window" },
  "install": {
    "booked": true, "day": "2026-10-25", "first_day": "2026-10-25",
    "last_day": "2026-10-25", "archive_on": "2026-10-26", "passed": false, "tentative": true
  },
  "installs": "ok",
  "arrival": { "...": "same shape as the row's board.arrival" },
  "arrival_read": "ok"
}
```

`stage` is null for a job outside the board's stages (for example Accepted).
`install` is null and `installs` is `failed` when the bookings read failed;
`arrival` is null and `arrival_read` is `failed` when an Arrival read failed.

## 3. Moving a job (existing actions, unchanged)

The header rail uses `board.moves`. No new write action was added.

**Pipeline jobs: `update_job_status`** (existing, the Ops Dash move).
`POST ops-api?action=update_job_status`

```json
{
  "jobId": "<uuid>",
  "status": "order_confirmed",
  "expected_statuses": ["awaiting_supplier"],
  "source": "dispatch",
  "operator_email": "shaun@..."
}
```

- `expected_statuses` (send `[board.moves.current]`) makes the move
  compare-and-set: if someone moved the job meanwhile nothing is written and
  the answer is
  `{ "success": false, "job_id": "...", "skipped": "status_changed", "expected_statuses": ["awaiting_supplier"], "status_seen": "scheduled" }`.
  The screen should then reload the list.
- Success: `{ "success": true, "job_id": "...", "new_status": "order_confirmed", "job_number": "SWF-1003" }`.
- Forwards and backwards both work; the action does no transition check.
- Same side effects as the Ops Dash: a `status_changed` job_event (this is
  what days in stage reads), the business event, the GHL stage move (when the
  job has a GHL opportunity), and the manager text for fencing and patio when
  the job enters Order Confirmed, Schedule Install or Scheduled from outside
  those three. While `job_work_order_auto_issue_v1` is on, entering one of
  these statuses may also issue the job work order (switched off today).
- `source: "dispatch"` is recorded on the event so a Dispatch move can be told
  apart from an Ops Dash move.

**Repairs: `update_repair_stage`** (existing, the Repairs board move).
`POST ops-api?action=update_repair_stage` with
`{ "jobId": "<uuid>", "stage": "scheduled", "operator_email": "..." }`.
Staff only. Answer
`{ "success": true, "job": { "id", "job_number", "repair_stage", "previous_repair_stage" } }`.
It writes a `repair_stage_changed` job_event and never `jobs.status`.

`set_dispatch_stage` and `set_dispatch_install_confirmed` ("Mark confirmed")
still exist for old callers but the v2 screen must not call them.

## 3a. Setting a delivery date by hand (`dispatch_v2_set_delivery_date`, new)

Shaun's ruling: "we can tweak delivery dates manually". A supplier often
confirms a day by phone, so staff can set, change or clear a supplier order's
delivery date by hand. Code: `supabase/functions/ops-api/dispatch_v2_delivery_date.ts`.
Tests: `dispatch_v2_delivery_date_test.ts`.

`POST ops-api?action=dispatch_v2_set_delivery_date`

```json
{
  "box_id": "<job_material_suppliers id, from board.arrival.orders[].box_id>",
  "delivery_date": "2026-10-29",
  "confirmed": true,
  "expected_set_at": "2026-10-22T03:00:00Z",
  "operator_email": "shaun@..."
}
```

- `box_id`, or instead `job_id` + `supplier_id` (one box per supplier per job).
- `delivery_date`: required. A real date `YYYY-MM-DD`, or `null` to clear.
  Past dates and dates after the install are allowed (the line shows the red).
- `confirmed`: required with a date (`true` = solid, the supplier agreed it;
  `false` = ring). Ignored on a clear; `true` with `null` is refused.
- `expected_set_at` (optional guard): the `box_date_set_at` the screen showed,
  or `null` when the box had no date of its own. If the box changed since,
  nothing is written and the answer is 409 `date_changed` with the box as it
  is now. Without it, the write is still compare-and-set against the stamp
  just read, so two presses at once never quietly overwrite each other.
- `operator_email`: needed with the ops key and must name a person in
  `users`; a signed-in session is named by the session.

Staff sessions and the privileged ops key only (403 `operator_access_required`
otherwise). GET is 405. Not on the trade, routine or agent-read lists. In
`scripts/_ops-api-required-actions.txt` as `# probe=source-only`.

What it writes: the seven delivery date columns of that one
`job_material_suppliers` row, and one `job_events` row. Never `jobs` (no stage
or status change, `job_status_changed` is always `false`), suppliers,
purchase orders, the order emails, the reply tables, Xero, GHL, SMS or email.

- Set: `delivery_date`, `delivery_date_source = 'by_hand'`,
  `delivery_date_set_at` = now, `delivery_date_set_by_email` = the person;
  confirmed also stamps `delivery_date_confirmed_at`/`_by`/`_by_email`,
  unconfirmed clears those three.
- Clear: all seven columns go back to null. The Arrival line then falls back
  to the date our order email asked for (`date_source: "requested"`, a ring),
  else a v1 PO date, else "no date yet".
- **By hand overrides a supplier-reply date.** Whatever date is on the box
  (including one accepted from a supplier reply) is replaced, and the box then
  says `by_hand` with the person's email. The audit row records
  `replaced_supplier_reply: true`. The latest press wins either way: pressing
  Accept on a newer supplier reply later replaces a hand-set date. Open reply
  suggestions are left as they are (not dismissed). The reply scan already
  skips suggesting a date equal to the box's confirmed date, by hand or not.
- Saving exactly what is there (same date, same tick, already `by_hand`), or
  clearing a box with no date, writes nothing: `"unchanged": true`. The same
  date saved over a supplier-reply date is a change (it becomes `by_hand`).

Audit row (`job_events`): `event_type` `dispatch_v2_delivery_date_set` or
`dispatch_v2_delivery_date_cleared`, `user_id` the signed-in person (null for
the ops key), `detail_json`
`{ box_id, supplier_id, supplier, from: { delivery_date, confirmed, source }, to: { ... }, replaced_supplier_reply, via: "screen" | "terminal", operator_email }`.
A failed audit insert does not undo the date; the answer then carries
`"audit_logged": false`.

Answer:

```json
{
  "success": true,
  "job_status_changed": false,
  "box": {
    "box_id": "...", "job_id": "...", "supplier_id": "...", "supplier_name": "Stratco WA",
    "delivery_date": "2026-10-29", "delivery_date_source": "by_hand", "confirmed": true,
    "set_at": "...", "set_by_email": "shaun@...", "confirmed_at": "...", "confirmed_by_email": "shaun@..."
  },
  "arrival": { "...": "the dispatch_arrival answer for the job, after the write" }
}
```

`arrival` is null if that read failed (the date is still saved; read
`dispatch_arrival` again). The list card's thin line and count come from the
next `pipeline&dispatch=1&board=v2` read.

Errors: 400 `invalid_request` (bad body, before any read), 400
`operator_required`, 404 `box_not_found` (no such box, or another
organisation's), 409 `not_dispatch_work` (make-safe or another type), 409
`date_changed`, 500 `dispatch_write_failed`.

## 3b. Material stages and "waiting on us" (`dispatch_v2_set_material_stage`, new)

Shaun and Marnin, 27 Oct 2026: the materials need their own stages, separate
from the job's, and the board must say what is waiting on us rather than on a
supplier or the client. Code: `supabase/functions/ops-api/dispatch_v2_material_stage.ts`
(the rules) and `dispatch_v2_material_stage_write.ts` (the set press). Tests:
`dispatch_v2_material_stage_test.ts`.

One stage per supplier order (a `job_material_suppliers` row, the supplier
box). The eight stages, in order, and who each waits on:

| Key | Label | Waiting on | Next thing to do |
|---|---|---|---|
| `order_materials` | Order materials | us | Send the order to X |
| `sent` | Sent to supplier | supplier | Waiting on X to reply |
| `quote_received` | Quote received | us | Check the quote from X |
| `awaiting_payment` | Awaiting payment | us | Pay X |
| `order_confirmed` | Order confirmed | us until the install is booked, then supplier | Book the install and tell the client / Waiting on X for the materials |
| `manufacturing` | Manufacturing | supplier | X is making it |
| `ready` | Materials ready | us | Arrange delivery or pickup from X |
| `delivered` | Delivered | nobody | (none) |

**The stage a box shows: whatever happened last decides.** The newest of:

- the stage a person set (`material_stage`, at `material_stage_set_at`);
- the newest order email sent from the box (shows Sent to supplier);
- the newest change to a line still to be ordered (no order email, no
  purchase order, not In stock; shows Order materials).

On the same moment a set stage wins. A delivery date confirmed after that
lifts an earlier stage to Order confirmed (never pulls a later one back). A
date set or confirmed before the box's newest send belongs to an earlier
order, so it neither lifts the stage nor shows as the date: the newest send's
asked-for date shows instead. Nothing is written when a send or a line moves
the stage on; the stage shown is worked out on each read. A purchase order
with no box takes its stage from its status (sent, submitted, authorised,
acked = Sent to supplier; confirmed = Order confirmed; delivered, billed =
Delivered; anything else = Order materials).

**Extra orders.** An order is an extra when its newest send (or, still to be
ordered, today) is on or after the install's first day; a purchase order
when it was made on or after that day. No install booked = never an extra. An
extra or delivered order never carries the red `after_install` flag, and a
delivered order never carries `no_date`.

### New fields

Each `board.arrival.orders[]` entry (and `dispatch_arrival`) gains:

```json
{
  "material_stage": "awaiting_payment",
  "material_stage_label": "Awaiting payment",
  "material_stage_source": "set",
  "material_stage_set_at": "2026-10-28T02:00:00Z",
  "material_stage_set_by_email": "hugo@...",
  "waiting_on": "us",
  "todo": "Pay Metroll",
  "extra": false
}
```

`material_stage_source` is `set` (a person chose it and nothing newer
happened), `worked_out` (from the box) or `order` (a purchase order's
status); `material_stage_set_at` and `_by_email` are only filled for `set`.
`arrival.counts` gains `open` (not delivered), `on_us` and `extra_open`
(extras not delivered), and `arrival.waiting_on_us` lists each `todo` waiting
on us, in box order.

Each row's `board` gains `waiting: { on_us, todo[] }`: the job's own step
first ("Order the materials" at Order Materials or Repairs Materials when
nothing is ordered yet, known only when the Arrival line read; "Book the
install" at Schedule Install), then `arrival.waiting_on_us`. The top-level
`board` gains `waiting_on_us`, the count of rows waiting on us.
`dispatch_arrival` also answers `waiting`. Each supplier in the materials
panel read (`dispatch_v2_materials`) gains `material_stage: { box_id, key,
label, source, set_at, set_by_email }`, where `set_at` is the stored stamp the
set press guards on (null = never set).

### The set press

`POST ops-api?action=dispatch_v2_set_material_stage`

```json
{
  "box_id": "<job_material_suppliers id>",
  "material_stage": "awaiting_payment",
  "expected_set_at": "2026-10-22T05:00:00Z",
  "operator_email": "shaun@..."
}
```

- `box_id`, or instead `job_id` + `supplier_id`.
- `material_stage`: one of the eight keys.
- `expected_set_at` (optional guard): the `material_stage.set_at` the screen
  showed, or `null` when the box had no stage of its own. Changed since =
  409 `stage_changed` with the box as it is now. Without it the write is still
  compare-and-set against the stamp just read.
- `operator_email`: needed with the ops key, must name a person in `users`.

Pressing a stage always stamps it again (now, by the person), even the same
stage: that is how a person says "still at this stage" after a newer send or
line moved the box on. Gate as section 3a: staff sessions and the privileged
ops key only, GET 405, on no allow-list, `# probe=source-only`.

What it writes: the three `material_stage*` columns of that one box and one
`job_events` row, `dispatch_v2_material_stage_set`, `detail_json`
`{ box_id, supplier_id, supplier, from, to, via, operator_email }` (`from` is
the stored stage before, null if none). Never `jobs` (`job_status_changed` is
always `false`), suppliers, purchase orders, the order emails, Xero, GHL, SMS
or email. A failed audit insert does not undo the stage (`"audit_logged":
false`).

Answer: `{ success, job_status_changed: false, box: { box_id, job_id,
supplier_id, supplier_name, material_stage, material_stage_label, set_at,
set_by_email }, arrival }`, with `arrival` the fresh `dispatch_arrival`
answer (null if that read failed).

Errors: 400 `invalid_request`, 400 `operator_required`, 404 `box_not_found`,
409 `not_dispatch_work`, 409 `stage_changed`, 500 `dispatch_write_failed`.

Migration: `supabase/migrations/20261028170000_dispatch_v2_material_stages.sql`
(rollback in `supabase/rollbacks/`): three nullable columns on
`job_material_suppliers` and a check that a stage is one of the eight and
always has when and by whom. Listed in
`scripts/edge-function-schema-requirements.txt`: the materials panel read
selects the columns, so ops-api must not deploy ahead of it.

## 3c. The payment step and ASAP (pieces A and C: contract, not built yet)

Shaun, 29 Oct 2026: when a supplier we have no account with comes back with a
quote, the order waits on us to pay, and stays there until someone records in
Dispatch that we paid. Example: SWR-261597 (Lysaght). Same day: most orders go
out "as soon as you can", so a box needs an ASAP choice, and the job should
suggest the earliest install day once every order has a date. Design and
rulings: the Dispatch payment step proposal (sections 1 to 10 and its
independent check) and the build plan's "Settled" list, both 29 Oct 2026.
Section 11 of the proposal (job stage driven by material stages, client
texts) is on hold and is NOT in this contract.

This section is the contract the screens (pieces B and D) build against.
Nothing in it is built, applied or deployed yet. Piece A is branch
`dispatch/payment-step-a`; piece C is branch `dispatch/asap-c`, stacked on A.
Nothing merges to main until Shaun says "merge to main".

### 3c.1 The rules in business words

1. **On account or pay first.** Five suppliers are on account: Bunnings,
   Fence Makers, Fencing Warehouse WA, R&R Fencing and Stratco WA. Every
   other supplier pays first, including a box whose supplier is not linked to
   the approved supplier list at all, so nothing slips past payment. The list
   is kept in one place (`dispatch_approved_supplier_emails.on_account`);
   there is no tick on the box.
2. **A matched reply moves a box forward, once.** When a supplier's reply is
   tied to that box's newest order (same email thread, the supplier's own
   order number, or a person tied it to that order), and the box is at Sent
   to supplier, the box moves on by itself: pay first to **Awaiting
   payment**, on account to **Quote received**. A reply tied only to the job
   (most hand-sent Outlook orders today), an invoice, or a second and third
   reply never moves a box. Automatic moves go forward only. A person can
   still pick any stage, backwards included, at any time.
3. **The payment gate.** On a pay-first box that is not paid for the current
   order, a confirmed date (Accept on a reply, or a date ticked by hand) is
   saved but does NOT lift the stage to Order confirmed. It lifts an earlier
   stage only as far as Awaiting payment (a supplier who has confirmed a date
   is waiting on our money). On account boxes are not gated: a confirmed date
   lifts to Order confirmed as today.
4. **Mark paid** is a record only: it pays nobody, touches no Xero, sends
   nothing. It stamps who and when on the box and moves the box to **Order
   confirmed**. **Undo paid** takes the stamp off; the box then shows what it
   would have shown without it.
5. **Paid counts for the order it was marked against.** A paid stamp counts
   only while it is newer than the box's newest order email (a second order
   to the same supplier reuses the box) and newer than the latest hand pick
   of Awaiting payment (picking Awaiting payment by hand re-opens the
   payment). The latest such pick is kept on the box in
   `payment_reopened_at`, so picking another stage by hand afterwards (for
   example Manufacturing) does not make the old stamp count again: the
   payment stays open until Mark paid or Pay on is pressed again. A box
   re-opened before that column existed is still read from its stored
   Awaiting payment pick, while that is the stored stage.
6. **Pay on pickup / Pay on delivery** confirms the order without paying: the
   box moves to Order confirmed exactly as Mark paid would, and carries a
   visible tag ("Pay on pickup"). It counts for the current order on the same
   terms as paid. Allowed on any box, on account included. Mark paid can
   still be pressed later (on the day they pay); both stamps are kept.
7. **Paid with no date waits on the supplier.** An Order confirmed box with no
   date for the current order (no box date, no asked-for date) is waiting on
   the supplier, "Waiting on X for a date", instead of "Book the install":
   you cannot book an install without a date. This applies to every Order
   confirmed box, however it got there.
8. **The job-wide "Move to Order Confirmed?" offer is withheld** while any
   pay-first box on the job is unpaid. That offer moves the whole job and
   texts the fencing or patio manager, so it must not run past the payment
   step. The rail move (`update_job_status`) itself is untouched: a person
   can still move the job by hand.
9. **Pickup wording.** A pickup order (its order email says "for pickup") is
   labelled **Picked up** at its last stage instead of Delivered, and at
   Materials ready its next step reads "Materials ready to be picked up,
   Mon 2/11" (the pickup date). A pickup whose date is the install's first
   day skips Materials ready: the crew collects it on the way, so the screen
   leaves Materials ready out of that box's strip and picker
   (`skips_ready: true`).
10. **ASAP or Pick a date (piece C).** Every box has a date choice. New boxes
    start on ASAP. ASAP greys out the calendar, the order email says
    `Date: ASAP` in plain text, and the send is allowed (the Date line is
    not empty). A sent ASAP order with no supplier date yet is "ASAP, waiting
    on their date": an amber dashed ring, **not** red "no date" and **not**
    counted late.
11. **Earliest install (piece C).** Once every open order on the job has a
    confirmed date, the job suggests the earliest install: the next working
    day after the last order arrives (Monday to Friday, skipping WA public
    holidays). Delivery Thu 5 Nov suggests Fri 6 Nov; delivery Fri 6 Nov
    suggests Mon 9 Nov. A suggestion only: it never books anything.

What never happens here: no email, SMS, Xero payment, GHL move or job status
change. No write to `suppliers` (the 06:55 Xero sync owns it). Mark paid,
Undo paid and Pay on pickup/delivery write one supplier box and one
`job_events` row each.

If the replies switch (`dispatch_v2_replies_v1`) is off, no reply is read,
nothing moves by itself and boxes sit at Sent: a safe fallback. A reply takes
up to about 7 minutes to show (5 minute scan plus a 2 minute delay).

### 3c.2 Data (migration files only, never applied by hand)

Each feature is its own migration so it can be reverted on its own. Every
migration has a rollback in `supabase/rollbacks/<name>_down.sql`. Each new
column the code selects is listed in
`scripts/edge-function-schema-requirements.txt`, so ops-api cannot deploy
ahead of its column (migrations auto-apply on merge to main, before the
function deploy).

| Migration (piece) | What |
|---|---|
| `20261029120000_dispatch_v2_on_account_suppliers.sql` (A) | `dispatch_approved_supplier_emails.on_account boolean NOT NULL DEFAULT false`; sets `true` for exactly `Bunnings`, `Fence Makers`, `Fencing Warehouse WA`, `R&R Fencing`, `Stratco WA` in org `00000000-0000-0000-0000-000000000001` (names as stored, checked read-only 29 Oct 2026: all five present and active, 26 entries in all). |
| `20261029120100_dispatch_v2_box_paid.sql` (A) | On `job_material_suppliers`: `paid_at timestamptz NULL`, `paid_by uuid NULL REFERENCES users(id) ON DELETE SET NULL`, `paid_by_email text NULL`. Check: `(paid_at IS NULL) = (paid_by_email IS NULL)`. |
| `20261029120200_dispatch_v2_box_pay_on.sql` (A) | On `job_material_suppliers`: `pay_on text NULL CHECK (pay_on IN ('pickup','delivery'))`, `pay_on_set_at timestamptz NULL`, `pay_on_set_by uuid NULL REFERENCES users(id) ON DELETE SET NULL`, `pay_on_set_by_email text NULL`. Check: `pay_on` set if and only if `pay_on_set_at` and `pay_on_set_by_email` are set. |
| `20261029120300_dispatch_v2_box_payment_reopened.sql` (A, review fix) | On `job_material_suppliers`: `payment_reopened_at timestamptz NULL`, stamped by `dispatch_v2_set_material_stage` on every hand pick of Awaiting payment (rule 5). |
| `20261030120000_dispatch_v2_box_date_mode.sql` (C) | On `job_material_suppliers`: `order_date_mode text NULL CHECK (order_date_mode IN ('asap','date'))`, `order_date_mode_set_at timestamptz NULL`, `order_date_mode_set_by_email text NULL`. The column is added with no default (existing boxes stay NULL, read as below), then `SET DEFAULT 'asap'` so every new box starts on ASAP. |

No backfill. Only two boxes have ever been sent from Dispatch (both on
SWR-261597). On day one Twinside moves to Awaiting payment by its own
thread reply; Lysaght stays at Manufacturing because a person picked it after
the reply, and a person's pick wins.

How a box's terms are found: `job_material_suppliers.supplier_id` ->
`dispatch_approved_supplier_email_links.supplier_id` (primary key, so one
entry per Xero supplier) -> the linked entry, counted only while `active`.
On account when that entry's `on_account` is true; pay first otherwise,
including no link or a link to a retired entry.

### 3c.3 The rules as pure functions (no database)

Business rules live in modules that import nothing from the database, so the
local preview stand-in can import them with Deno as they are:

- `supabase/functions/ops-api/dispatch_v2_payment.ts` (piece A): terms,
  which stamps count, the payment object, the reply step, the gate.
- `supabase/functions/ops-api/dispatch_v2_material_stage.ts` (existing,
  extended): `dispatchMaterialStageOf` takes the new optional inputs and
  calls the payment module; every new input is optional, so a caller that
  passes none gets exactly today's answer.
- `supabase/functions/ops-api/dispatch_v2_working_days.ts` (piece C): working
  days, the WA public holiday list, the earliest install.

Each rule is its own named step function with one call line, so reverting one
feature's commit removes one step and leaves the others standing.

```ts
// dispatch_v2_payment.ts
export type DispatchV2PaymentTerms = "on_account" | "pay_first" | "unknown";

// unknown = the account list read failed: behave exactly as today (no
// reply move, no gate) and say so in reads.accounts.
export function dispatchV2PaymentTerms(input: {
  readOk: boolean;
  linked: boolean;          // an active approved entry is linked
  onAccount: boolean | null;
}): DispatchV2PaymentTerms;

export type DispatchV2PaymentInput = {
  terms: DispatchV2PaymentTerms;
  paidAt: unknown; paidByEmail: unknown;
  payOn: unknown; payOnSetAt: unknown; payOnSetByEmail: unknown;
  newestSentAt: unknown;                 // the box's newest sent order email
  storedStage: unknown; storedStageAt: unknown; // the person's pick
  materialStage?: string;                // the stage finally shown (for state)
};

export type DispatchV2Payment = {
  terms: DispatchV2PaymentTerms;
  // not_needed: on account and no tag. unpaid: pay first, nothing counts.
  // paid / pay_on_pickup / pay_on_delivery: that stamp counts (paid wins
  // when both count). unknown: terms unknown.
  state: "not_needed" | "unpaid" | "paid" | "pay_on_pickup" |
    "pay_on_delivery" | "unknown";
  paid: boolean;               // a paid stamp counts for the current order
  paid_at: string | null;      // only when it counts
  paid_by_email: string | null;
  pay_on: "pickup" | "delivery" | null; // only when it counts
  pay_on_set_at: string | null;
  pay_on_set_by_email: string | null;
  // A stamp that is on the box but belongs to an earlier order (older than
  // the newest send, or than the latest hand pick of Awaiting payment).
  earlier_order_paid_at: string | null;
  earlier_order_pay_on_set_at: string | null;
  // The confirmed date is saved but the gate is holding the stage.
  holds_stage: boolean;
  // Counts towards "any box unpaid" (pay first, unpaid, not delivered).
  blocks_job_move: boolean;
  // What the screen may offer on this box.
  can_mark_paid: boolean;      // pay first (or unknown terms) and not paid
  can_undo_paid: boolean;      // a counting paid stamp is on the box
  can_set_pay_on: boolean;     // always true for a supplier box
  // The stored stamps the presses guard on (raw, null = never set).
  guard: { paid_at: string | null; pay_on_set_at: string | null };
};

export function dispatchV2PaymentOf(input: DispatchV2PaymentInput): DispatchV2Payment;

// The stage a reply moves a box to: pay first -> awaiting_payment, on account
// -> quote_received, unknown -> null (no move).
export function dispatchV2ReplyStage(terms: DispatchV2PaymentTerms):
  "awaiting_payment" | "quote_received" | null;

// Whether one matched reply is tied to the box's newest order: state
// 'matched', order_id equals the newest sent order email's id, received
// (else matched) after that email's sent_at.
export function dispatchV2ReplyTiedToOrder(
  reply: { state: unknown; order_id: unknown; received_at: unknown; matched_at: unknown },
  newestSent: { id: string; sent_at: string } | null,
): boolean;
```

`dispatchMaterialStageOf` gains these optional inputs:

```ts
{
  // existing: stored, storedAt, sentAts, unsentLineChanges, confirmedAt
  terms?: DispatchV2PaymentTerms;          // default "unknown" = today's rule
  payment?: DispatchV2Payment;             // from dispatchV2PaymentOf
  newestSent?: { id: string; sent_at: string } | null;
  replies?: { id: string; state: unknown; order_id: unknown;
              received_at: unknown; matched_at: unknown; rung: unknown }[];
}
```

and its answer gains `source: "reply" | "payment"` (besides `set`,
`worked_out`), `reply: { email_id, received_at, rung } | null` and
`held_by_payment: boolean`.

**The stage rule, in order** (each line is one step function):

1. Whatever happened last, as today: the person's pick, the newest send
   (Sent), the newest change to a line still to order (Order materials).
2. *Payment step* (`dispatch_v2_payment.ts`): a counting paid stamp or Pay on
   tag is one more candidate, at its stamp time, key `order_confirmed`,
   source `payment`. Newest still wins, so a person's later pick beats it.
3. *Reply step*: if the winner is `sent`, the box has no counting paid/Pay on
   stamp, and a reply tied to the newest order (above) arrived after the
   winner's moment, the box shows `dispatchV2ReplyStage(terms)`, source
   `reply`. The earliest such reply is the one named. Never from any other
   stage (forward only), never when terms are unknown.
4. *Date lift with the gate*: a current confirmed date newer than the winner
   lifts an earlier stage. Pay first with no counting stamp: lifts only to
   `awaiting_payment` (if the stage is earlier) and sets `held_by_payment`.
   Otherwise (on account, paid, Pay on, or unknown terms): lifts to
   `order_confirmed` as today.

Who it waits on and the next step (`dispatchMaterialWaitingOn` /
`dispatchMaterialTodo` gain an optional context `{ fulfilment, date,
hasDate, skipsReady }`; without it they answer as today):

| Stage | Change |
|---|---|
| `order_confirmed`, no date for the current order | waiting on `supplier`, "Waiting on X for a date" (rule 7) |
| `ready`, pickup | "Materials ready to be picked up, Mon 2/11" (the box's date; "Materials ready to be picked up" with no date) |
| `ready`, delivery | "Arrange delivery from X" |
| `delivered`, pickup | label "Picked up" |

`skips_ready` = pickup, and the box's date (own or asked-for) equals the
install's first day.

```ts
// dispatch_v2_working_days.ts (piece C)
// WA public holidays, Perth days. Kept here by hand with the source and the
// date it was checked; extend before the last year runs out. A day missing
// from the list is treated as a working day.
export const WA_PUBLIC_HOLIDAYS: readonly string[];  // 2026 and 2027 at least
export function isWaWorkingDay(day: string): boolean; // Mon-Fri, not a holiday
export function nextWaWorkingDayAfter(day: string): string;
export function dispatchEarliestInstall(input: {
  today: string;
  orders: { open: boolean; date: string | null; confirmed: boolean }[];
}): { day: string; after_day: string } | null; // null unless every open order is confirmed
```

The holiday list to carry (to be checked against the WA Government list in
the piece C PR): 2026: 1 Jan, 26 Jan, 2 Mar, 3 Apr, 6 Apr, 27 Apr (Anzac Day
falls on a Saturday), 1 Jun, 28 Sep, 25 Dec, 28 Dec (Boxing Day falls on a
Saturday). 2027: 1 Jan, 26 Jan, 1 Mar, 26 Mar, 29 Mar, 26 Apr (Anzac Day
falls on a Sunday), 7 Jun, 27 Sep, 27 Dec, 28 Dec.

Earliest install = next working day after the later of (the last open
order's confirmed date, today). Delivered orders do not hold it up. An order
with no confirmed date (ASAP waiting, a ring, nothing yet) makes it `null`.

### 3c.4 New fields on the existing reads

All new fields are additive. A screen talking to an older backend sees none
of them and must behave as today (piece B's "works with old backend too").
Unknown values of existing enums (`material_stage_source`, `flag`) must be
treated as today's nearest value (`worked_out`, `null`).

**Each `board.arrival.orders[]` entry** (the board row, `dispatch_arrival`,
and the `arrival` echoed by every write):

```json
{
  "material_stage": "awaiting_payment",
  "material_stage_label": "Awaiting payment",
  "material_stage_source": "reply",
  "material_stage_reply": {
    "email_id": "<dispatch_v2_supplier_emails id>",
    "received_at": "2026-10-29T04:58:00Z",
    "rung": "thread"
  },
  "held_by_payment": true,
  "waiting_on": "us",
  "todo": "Pay Lysaght",
  "skips_ready": false,
  "payment": {
    "terms": "pay_first",
    "state": "unpaid",
    "paid": false,
    "paid_at": null,
    "paid_by_email": null,
    "pay_on": null,
    "pay_on_set_at": null,
    "pay_on_set_by_email": null,
    "earlier_order_paid_at": null,
    "earlier_order_pay_on_set_at": null,
    "holds_stage": true,
    "blocks_job_move": true,
    "can_mark_paid": true,
    "can_undo_paid": false,
    "can_set_pay_on": true,
    "guard": { "paid_at": null, "pay_on_set_at": null }
  },
  "date_mode": "asap",
  "flag": "asap"
}
```

| Field | Values |
|---|---|
| `material_stage_source` | adds `reply` (moved by a matched reply) and `payment` (moved by Mark paid or Pay on) |
| `material_stage_reply` | the reply that moved it; null unless source is `reply` |
| `held_by_payment` | a confirmed date is saved but the payment gate holds the stage |
| `material_stage_label` | `Picked up` instead of `Delivered` for a pickup |
| `skips_ready` | pickup on the install's first day: leave Materials ready out of the strip and picker |
| `payment` | as `DispatchV2Payment` above; `null` for a purchase order with no box |
| `date_mode` (C) | `asap` or `date`: the newest sent email's Date line (`Date: ASAP` = asap) for a sent order; else the box's `order_date_mode`; a NULL mode (box made before piece C) is `date` when the box or open email has a date, else `asap`. Null for a purchase order |
| `flag` (C) | adds `asap`: sent, ASAP, no date yet. Not red, not counted late. `no_date` is now only a sent "Pick a date" order with no date |

**`board.arrival`** gains:

```json
{
  "counts": { "unpaid": 1, "held_by_payment": 1, "asap_waiting": 1 },
  "payment": { "any_unpaid": true, "unpaid_suppliers": ["Lysaght"] },
  "earliest_install": { "day": "2026-11-05", "after_day": "2026-11-04" }
}
```

- `counts.late` no longer counts `asap` orders (C).
- `payment.any_unpaid` is true when any box has `payment.blocks_job_move`.
  `null` when the account list read failed (unknown): the screen then keeps
  today's behaviour.
- `earliest_install` (C) is null until every open order has a confirmed date.
  When it is known and no install is booked, `waiting_on_us` carries one line
  "All materials by Wed 4/11. Book the install from Thu 5/11 and tell the
  client" in place of each order's "Book the install and tell the client".

**Each board row's `board`** gains `payment_hold: true | false | null` (the
same as `arrival.payment.any_unpaid`; null when unknown or the Arrival read
failed). The screen hides the job-wide "Move to Order Confirmed?" offer while
it is `true`. `board.waiting.todo` picks up the new todo lines unchanged.

**Top-level `board.reads`** gains `accounts` and `replies` (`ok` or
`failed`). A failed read never blanks the Arrival line: a failed account
read gives terms `unknown` on every box (today's rule: no gate, no reply
move, `payment_hold: null`); a failed replies read gives no reply moves.

**`dispatch_arrival`** gains the same `payment_hold` and `reads`
(`accounts_read`, `replies_read`) next to `arrival_read`.

**`dispatch_v2_materials`** (the materials panel read): each supplier gains
`payment` (the same object, computed with the same functions) and
`approved_email.on_account`; its `material_stage` object gains `source`
values `reply` / `payment`, `reply`, `held_by_payment`, the pickup label, and
`skips_ready`. Piece C adds `date_mode: { mode, set_at, set_by_email,
derived }` to each supplier (`derived: true` when the stored mode is NULL and
the mode was worked out).

**`dispatch_v2_suggestion_accept`** (Accept on a reply) answer gains:

```json
{
  "stage_move_offer": null,
  "stage_move_held": { "reason": "unpaid", "suppliers": ["Lysaght"] },
  "payment_hold": true,
  "box_payment": { "...": "the accepted box's payment object" }
}
```

`stage_move_offer` is null whenever any pay-first box on the job is unpaid
after the accept; `stage_move_held.reason` is `unpaid`, or
`payment_unknown` when the boxes could not be read (the offer is withheld
then too: it texts a manager). Otherwise `stage_move_held` is null and the
offer is as today. The suggestion note under Accept ("Lysaght stays at
Awaiting payment until someone presses Mark paid") is screen wording from
`box_payment.holds_stage`.

### 3c.5 New actions

All four presses share the gate of `dispatch_v2_set_material_stage`: staff
sessions and the privileged ops key only (403 `operator_access_required`
otherwise), POST only (GET 405), on no trade, routine or agent-read list,
listed in `scripts/_ops-api-required-actions.txt` as `# probe=source-only`.
Each takes `box_id`, or instead `job_id` + `supplier_id`, and
`operator_email` (needed with the ops key, must name a person in `users`).
Each write is compare-and-set against the stamp it guards, so two presses at
once never quietly overwrite each other. Each writes one
`job_material_suppliers` row and one `job_events` row (`user_id` the person,
null for the ops key; a failed audit insert does not undo the write and the
answer then carries `"audit_logged": false`). Never `jobs`
(`job_status_changed` is always `false`), suppliers, purchase orders, order
emails, replies, Xero, GHL, SMS or email.

Common answer:

```json
{
  "success": true,
  "unchanged": false,
  "job_status_changed": false,
  "box": {
    "box_id": "...", "job_id": "...", "supplier_id": "...", "supplier_name": "Lysaght",
    "material_stage": "order_confirmed", "material_stage_label": "Order confirmed",
    "payment": { "...": "DispatchV2Payment" }
  },
  "arrival": { "...": "the fresh dispatch_arrival answer, null if that read failed" }
}
```

Common errors: 400 `invalid_request` (bad body, before any read), 400
`operator_required`, 404 `box_not_found`, 409 `not_dispatch_work`, 500
`dispatch_write_failed`, 500 `dispatch_read_failed`.

**`POST ops-api?action=dispatch_v2_mark_paid`** (A)

```json
{ "box_id": "...", "expected_paid_at": null, "operator_email": "shaun@..." }
```

- `expected_paid_at` (optional guard): `payment.guard.paid_at` as shown
  (null = no stamp on the box). Changed since: 409 `paid_changed` with the
  box as it is now.
- Writes `paid_at` = now, `paid_by`, `paid_by_email`. A stamp from an
  earlier order is replaced. A box already paid for the current order writes
  nothing: `"unchanged": true`.
- 409 `on_account` when the box's supplier is on the account list (no
  payment step; "Pay on" is still allowed). 409 `terms_unknown` is never
  returned: if the account list cannot be read the press is refused 500
  `dispatch_read_failed` instead of guessing.
- Event `dispatch_v2_marked_paid`, `detail_json { box_id, supplier_id,
  supplier, order_email_id (the newest sent email, or null), replaced_paid_at,
  had_date, stage_before, stage_after, via, operator_email }`.

**`POST ops-api?action=dispatch_v2_undo_paid`** (A)

```json
{ "box_id": "...", "expected_paid_at": "2026-10-29T06:40:00Z", "operator_email": "shaun@..." }
```

- `expected_paid_at` is **required** here (the stamp being undone). Changed
  since: 409 `paid_changed`. No stamp on the box: `"unchanged": true`.
- Clears `paid_at`, `paid_by`, `paid_by_email`. The stage shown goes back to
  what the other rules give (usually Awaiting payment).
- Event `dispatch_v2_paid_undone`, `detail_json { box_id, supplier_id,
  supplier, undone_paid_at, undone_paid_by_email, stage_before, stage_after,
  via, operator_email }`.

**`POST ops-api?action=dispatch_v2_set_pay_on`** (A)

```json
{ "box_id": "...", "pay_on": "pickup", "expected_set_at": null, "operator_email": "shaun@..." }
```

- `pay_on`: `pickup`, `delivery`, or `null` to take the tag off. Anything
  else is 400 `invalid_request`.
- `expected_set_at` (optional guard): `payment.guard.pay_on_set_at`.
  Changed since: 409 `pay_on_changed`.
- Set writes `pay_on`, `pay_on_set_at` = now, `_by`, `_by_email`; null
  clears all four. The same value already counting, or clearing an empty
  tag, writes nothing (`"unchanged": true`).
- Events `dispatch_v2_pay_on_set` / `dispatch_v2_pay_on_cleared`,
  `detail_json { box_id, supplier_id, supplier, from, to, order_email_id,
  stage_before, stage_after, via, operator_email }`.

**`POST ops-api?action=dispatch_v2_set_date_mode`** (C)

```json
{ "box_id": "...", "date_mode": "asap", "operator_email": "shaun@..." }
```

- `date_mode`: `asap` or `date`. Writes `order_date_mode`,
  `order_date_mode_set_at`, `order_date_mode_set_by_email`. Same value:
  `"unchanged": true`. It never touches a held or sent email; the next Make
  email uses it. Event `dispatch_v2_date_mode_set`.
- Choosing ASAP does not clear a box date already set (a supplier date stays
  a supplier date).

**`dispatch_v2_make_email`** (existing, C) accepts `date_mode: "asap" |
"date"` (default: the box's mode, NULL read as above). `asap` requires
`delivery_date` null (else 400 `invalid_request`), writes `Date: ASAP` in
the body, stores `delivery_date` null, saves the mode on the box, and leaves
`date` out of `missing`. The send check (`dispatchV2EmptyDetailLines`) is
unchanged: `Date: ASAP` is not an empty line, so the send is allowed; a
blank Date line on a "Pick a date" email is still refused (409
`email_details_missing`). ASAP is read back from the Date line exactly as
pickup is read from the opening line: a hand edit of that line changes what
Dispatch thinks. The payment step never reads reply or email wording, only
the account list.

### 3c.6 Commits (one feature each, so any one can be reverted)

Piece A, branch `dispatch/payment-step-a`, PR "Dispatch: payment step (piece
A of 4)":

| # | Commit | Contains |
|---|---|---|
| A0 | Dispatch: payment step and ASAP contract | this section |
| A1 | Dispatch: on-account supplier list | on_account migration + rollback + schema line; `dispatchV2PaymentTerms`; account read on board, `dispatch_arrival`, materials; `payment.terms`, `reads.accounts` |
| A2 | Dispatch: Mark paid and Undo paid | paid migration + rollback + schema lines; `dispatchV2PaymentOf` (paid, counts for the order sent); payment step in the stage rule; the two actions, routing, action list; tests |
| A3 | Dispatch: Pay on pickup or delivery | pay_on migration + rollback + schema lines; tag in the payment object and step; `dispatch_v2_set_pay_on`; tests |
| A4 | Dispatch: unpaid date holds the stage | the gate in the date lift; `held_by_payment`, `holds_stage`; tests (Accept and by-hand date both covered, one shared rule) |
| A5 | Dispatch: replies move forward only | reply step; replies read on board and materials; `material_stage_reply`, `reads.replies`; tests (multiple replies, job-only match, invoice after paid, reply before send) |
| A6 | Dispatch: paid with no date waits on the supplier | waiting_on / todo for Order confirmed with no date; tests |
| A7 | Dispatch: hold the job move while a box is unpaid | `arrival.payment`, `payment_hold`, accept answer `stage_move_held`; tests |
| A8 | Dispatch: pickup wording and install-day pickup | Picked up label, ready wording, `skips_ready`; tests |

Piece C, branch `dispatch/asap-c` (stacked on A), PR "Dispatch: ASAP and
earliest install (piece C of 4)":

| # | Commit | Contains |
|---|---|---|
| C1 | Dispatch: ASAP or Pick a date on each box | date mode migration + rollback + schema lines; `dispatch_v2_set_date_mode`; make_email `date_mode`, `Date: ASAP`; `date_mode` on reads; tests |
| C2 | Dispatch: ASAP orders are not late | `flag: "asap"`, `counts.asap_waiting`, `late` excludes; tests |
| C3 | Dispatch: earliest install suggestion | `dispatch_v2_working_days.ts` with the dated WA holiday list; `earliest_install`; the single waiting line; tests |

A4 to A8 each add one step function and one call line in the same stage
rule, so a revert of one may need a one-line touch-up where a later commit
sits next to it; no feature depends on another's data except A3 to A8 on
A1's terms and A4 to A7 on A2's payment object.

### 3c.7 Open points

- Rule 3's "lifts only as far as Awaiting payment" (a confirmed date on a
  pay-first box still at Sent) is this contract's reading of "saves the date
  but holds the stage": it stops the board saying "waiting on the supplier"
  when the supplier has confirmed and is waiting on our money. Say if the
  stage should instead stay exactly where it is.
- Rule 2 counts a reply tied to the order by a person (Assign or a confirmed
  best guess that names the order) the same as a thread match. Live data
  29 Oct 2026: 27 matched replies are job-number only (no order, never
  move), 3 are hand-assigned to the job only (no order, never move), 2 are
  thread matches on SWR-261597's orders (move).
- Rule 7 changes Order confirmed with no date for every box, not only paid
  ones (a hand-picked Order confirmed on a website order with no date now
  says "Waiting on X for a date" until the date is typed in).
- Who may press Mark paid: the stage picker's rule (any staff sign-in or the
  ops key naming a person). No narrower role was asked for.
- The holiday list must be extended by hand before the end of 2027; a
  missing year only means a holiday counts as a working day in the
  suggestion.
- Migration contract tests need psql, which is not installed on this PC;
  CI runs them on the PR.

## 4. Dispatch purchase orders are refused by the old paths (slice 4)

A purchase order with `source = 'dispatch'` is refused, before any job,
supplier or Xero token read, by:

- `POST ops-api?action=push_po_to_xero` `{ "id": "<po uuid>" }`
- `POST ops-api?action=email_po` `{ "id": "<po uuid>" }`
- the `send-po-email` function (`{ "po_id": ... }`)

Answer (HTTP 409):

```json
{
  "error": "PO-2001 was made in the Dispatch tab, so it cannot be pushed to Xero. Send it from the job's Dispatch tab instead.",
  "code": "dispatch_po_refused",
  "action": "push_po_to_xero",
  "po_id": "<po uuid>"
}
```

`action` is `push_po_to_xero`, `email_po` or `send_po_email`. The acceptance
auto-push already skipped Dispatch orders. Rule:
`supabase/functions/_shared/dispatch_po_guard.ts`. The old PO board should
hide its Push to Xero and Email buttons when a PO's `source` is `dispatch`
(screen work, not done here).

## 5. Migration (file only, not applied)

`supabase/migrations/20261023160000_dispatch_v2_board_arrival_dates.sql`
(rollback `supabase/rollbacks/20261023160000_dispatch_v2_board_arrival_dates_down.sql`).

Adds seven nullable columns to `job_material_suppliers` (in v2 one supplier box
is one order):

| Column | Meaning |
|---|---|
| `delivery_date date` | the day the order is due on site |
| `delivery_date_source text` | `by_hand` or `supplier_reply` |
| `delivery_date_set_at timestamptz` | when the date was set |
| `delivery_date_set_by_email text` | who set it |
| `delivery_date_confirmed_at timestamptz` | when the date was confirmed (null = ring) |
| `delivery_date_confirmed_by uuid` (users) | who confirmed it |
| `delivery_date_confirmed_by_email text` | who confirmed it |

Checks: the source is one of the two values; a date always has `set_at` and a
source; a confirmation needs a date and a person's email. Writers: Accept on
a supplier reply (`dispatch_v2_suggestion_accept`, source `supplier_reply`)
and the by-hand action in section 3a (source `by_hand`).

The Arrival line also reads `dispatch_supplier_order_emails` (status `sent`,
with `body_text` for delivery or pickup, 29 Oct 2026),
which comes with the supplier order emails slice
(`20261023214200_dispatch_v2_emails_draft_list_and_order_emails.sql`, sibling
branch). Until both migrations are applied, `board.reads.arrival` is `failed`
and every `arrival` is null; the rest of the board works.

No `scripts/edge-function-schema-requirements.txt` lines were added: the read
degrades instead of failing, as the slice 6 precedent allows.
`dispatch_arrival` was added to `scripts/_ops-api-required-actions.txt`.

## 6. Not done, and open points

- **Box delivery date writers.** Slice 8's Accept writes the box date with
  `delivery_date_source = 'supplier_reply'`; `dispatch_v2_set_delivery_date`
  (section 3a) writes it by hand. A sighting ("on site") for an emailed order
  is still not built (v1 POs keep theirs).
- **What slice 8 calls an order.** Slice 8's `order_id` is "one per supplier
  box"; this board treats the `job_material_suppliers` row as the order. The
  emails slice keeps one `dispatch_supplier_order_emails` row per send. These
  three need to agree before merge.
- **Order sent** reads only `dispatch_supplier_order_emails.status = 'sent'`
  (plus v1 PO statuses). If the emails slice names it differently, adjust
  `DISPATCH_BOARD_SENT_EMAIL_SELECT` in `dispatch_board.ts`.
- **Decking** is listed with fencing and patio. Decking jobs get no manager
  text from `update_job_status` (that is fencing and patio only).
- **Legacy `processing`** status is not shown (one fencing job sits there
  today and will drop off the Dispatch list).
- **`schedule_install`** is not in the fencing/patio stage lists of the state
  machine, but `update_job_status` accepts it and jobs sit in it today.
- **A job moved to In Progress mid-install** goes to Archive by its install
  day like any other.
- The Archive's narrowing read looks back 44 days (30 + 14) for a booking; a
  single booking row longer than 14 days would be missed without a search.
- `job_detail` itself is unchanged; the job screen reads `dispatch_arrival`
  for the full Arrival line.
- Migration contract tests (`supabase/tests/migration-contracts/`) were not
  run: psql is not installed on this PC.
