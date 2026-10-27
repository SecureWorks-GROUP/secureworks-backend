# Dispatch v2 board: backend contract

Branch `feat/dispatch-board-v2` (worktree `be-dispatch-board-v2`). Slices 1, 3
(backend side), 4 (backend side) and 7 (data) of the Dispatch v2 brief.
Rules: `supabase/functions/ops-api/dispatch_board.ts`. Tests:
`dispatch_board_test.ts`, `dispatch_po_guard_test.ts`,
`send-po-email/send_po_email_test.ts`.

Nothing here is deployed or applied. The migration below is a file only.

## The rules in business words

- The Dispatch list shows a job only when its **real** pipeline status is Order
  Materials, Awaiting Supplier, Order Confirmed, Schedule Install or Scheduled,
  and its type is fencing, patio or decking. A repair shows when its Repairs
  board stage is Materials or Scheduled. Nothing earlier, no make-safes (even
  for a search), no insurance or miscellaneous jobs, no test records, no legacy
  jobs. The legacy `processing` status is not shown.
- `job_dispatch_state` (the v1 Dispatch-only stage rail) decides nothing on the
  v2 board.
- **Archive** is Dispatch's own view and never changes the real status. A
  Scheduled job goes there the day after its last install day (Perth time; a
  booking's `scheduled_end` counts). A job already moved past Scheduled (In
  Progress, Complete, Invoiced...) is also in Archive, placed by its install
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

The Arrival line also reads `dispatch_supplier_order_emails` (status `sent`),
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
