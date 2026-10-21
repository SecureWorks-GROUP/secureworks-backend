# Dispatch slice 3: stage rail and To do contract

What `ops-api` gives the Ops screen's Dispatch tab for slice 3 (the To do list and
the six-stop stage rail). One read addition and two writes. Builds on
`docs/dispatch-slice-1-read-contract.md`; everything there still holds.

| Part | Where |
|---|---|
| Rules (pure) | `supabase/functions/ops-api/dispatch_stage.ts` |
| The two writes | `supabase/functions/ops-api/dispatch_stage_write.ts` |
| The read | `pipeline` in `supabase/functions/ops-api/index.ts`, under `dispatch=1` |
| Tests | `dispatch_stage_test.ts` (CI step "Test the Dispatch list and job notes reads") |
| Table | `job_dispatch_state`, migration `20261014113000_job_dispatch_state.sql` |

## 1. The rule in one line

The rail's stage is Dispatch's own record, never the job status. A press writes
one `job_dispatch_state` row and one `job_events` row and nothing else: no job
status, no Jobs board move, no message, no money, no CRM, no AI read. Until a
person sets a stage, the rail reads its place from the job status (the Repairs
board stage for repair) and says so (`dispatch_stage_source`).

## 2. The read: `GET ops-api?action=pipeline&dispatch=1`

Unchanged from slice 1 except for the fields below. Without `dispatch=1` the
answer carries none of them and `job_dispatch_state` is not read.

### Top of the answer

| Field | Meaning |
|---|---|
| `dispatch_stages` | `ok` or `failed` |
| `todo_total` | the number of returned rows with `dispatch_todo` true. With no `search` it is the To do count. Absent when `dispatch_stages` is `failed` |

An answer with no job (a search that matches nothing) still carries
`dispatch_stages: "ok"` and `todo_total: 0`.

**A failed stage read is never "nothing set".** When the `job_dispatch_state`
read errors, the answer has `dispatch_stages: "failed"`, no `todo_total`, no
`dispatch_` field on any row, `degraded: true`, and
`pipeline.job_dispatch_state` in `enrichment_errors`. The rest of the list
(slice 1's fields) still comes back, so All jobs still lists. The screen shows
"Could not load Dispatch stages. Retry." for To do and for the rail when
`dispatch_stages` is `failed` or the fields are missing.

### Per row, when the stage read worked

| Field | Type | Meaning |
|---|---|---|
| `dispatch_stage` | string or null | `not_started`, or one of the six stage keys. `null` on a make-safe row: make-safe jobs have no rail |
| `dispatch_stage_index` | 0 to 6, or null | 0 for `not_started`, 1 Accepted to 6 Trade scheduled. `null` on a make-safe row |
| `dispatch_stage_source` | `set`, `job_status`, `repairs_board`, or null | `set`: a person pressed a stop. Otherwise where the place was read from. `null` on a make-safe row |
| `dispatch_stage_from` | string or null | when the source is not `set`: the raw job status or Repairs board stage it was read from (`order_materials`, `approved`). Null when set |
| `dispatch_stage_set_at` | timestamp or null | when it was set. Null unless the source is `set` |
| `dispatch_stage_set_by` | string or null | the setter's name from `users`, else the operator email stamped on the press, else null. Null unless the source is `set` |
| `dispatch_todo` | boolean | whether the job is in To do (section 4) |
| `dispatch_todo_out` | string or null | for a patio or decking job inside the Dispatch window that the council rule holds out: `in_council`, `council_to_come`, `council_not_decided`. Null otherwise |
| `dispatch_next_step` | string or null | the hand-typed line, at most 40 characters. Always null on a make-safe row |

The read adds one enrichment read (`job_dispatch_state` for every returned job,
chunked and paged like the other thirteen, inside the same `Promise.all` wave)
and one projected path on the jobs read, `ds_repair_stage:metadata->>repair_stage`,
stripped from the response like the other `ds_` aliases. Neither `metadata` nor
`scope_json` is selected whole. The setter's name is embedded through the
`stage_set_by` foreign key to `users`, so no further read is made.

### Cost

Measured 14 Oct 2026 on production, database side only, `explain analyze` of the
Dispatch jobs read (324 rows): 421 ms with slice 1's projection, 432 ms with
`metadata->>repair_stage` added (within run-to-run noise: the family paths
already read `metadata`). The `job_dispatch_state` read is one index lookup per
chunk on a table that starts empty. **Not observed:** the HTTP wall time of
`pipeline&dispatch=1` before and after the deploy. No ops key was available to
the build, and the after figure needs the deploy. Measure both on the first
acceptance run and write them here.

## 3. The two writes

Both are `POST`, staff sessions (admin, owner, ops manager) and the privileged
ops key only, gated in the dispatch exactly as `update_repair_stage` is. Not the
routine key (absent from `ROUTINE_ALLOWED_ACTIONS`), not the agent read list,
not a trade or a division manager (the front door answers 403
`operator_access_required`). A non-POST call is 405.

Attribution: a signed-in person is named by the verified session (user id and
email); the ops key has no user and is named by the `operator_email` the screen's
`opsPost` stamps.

Both refuse the same way: 400 when `job_id` is missing or is not a job id; 404
for a job not in the organisation; 409 `not_dispatch_work` for a make-safe job.
A repair-family job stored as `type = makesafe` is a repair (work type by
`dispatchWorkType`) and is allowed.

### `set_dispatch_stage`, body `{ job_id, stage, expected_stage }`

- `stage`: one of `accepted`, `deposit_paid`, `materials_ordered`,
  `supplier_confirmed`, `materials_on_site`, `trade_scheduled`. Missing or
  unknown is 400. `not_started` is 400: it cannot be set.
- `expected_stage`: required (400 when missing). The `dispatch_stage` the screen
  was showing, `not_started` included. If the job's stage is now something else
  the answer is **409** with `code: "stage_changed"`, `job_id`, `job_number` and
  every `dispatch_` field as they are now, and nothing is written.
- Setting the stage the job already has **set**: success with `unchanged: true`,
  no write, no event row.
- Setting the stage a job only shows from its job status or Repairs board stage
  is a real write: it pins the job there.
- Writes, in order: the state row (insert on the first press, otherwise an
  update guarded on the stage it read; a row inserted or moved in between is the
  same 409 `stage_changed`, never an overwrite), then one `job_events` row of
  type `dispatch_stage_changed`, `user_id` when a person is signed in,
  `detail_json` `{ from_stage, from_source, to_stage, operator_email, changed_at }`.
  If the event row fails after the stage landed, the error is logged and the
  answer is success with `audit_logged: false`.
- Answer: `{ success, job_id, job_number, dispatch_stage, dispatch_stage_index,
  dispatch_stage_source: "set", dispatch_stage_set_at, dispatch_stage_set_by,
  previous_stage, previous_source, dispatch_todo, dispatch_todo_out, audit_logged }`
  (plus `unchanged: true` on a repeat).
  Since slice 7 it also reads the job's bookings (read only) to answer
  `dispatch_todo`; see `docs/dispatch-slice-7-contract.md`, section 3.

### `set_dispatch_next_step`, body `{ job_id, text }`

- `text` must be a string (400 otherwise). It is trimmed and every run of white
  space becomes one space; over 40 characters after that is 400. An empty result
  clears the line (stored as null).
- Writes the next-step columns of the state row only (a stage on the row is left
  as it is; a first line creates the row with no stage), then one `job_events`
  row of type `dispatch_next_step_set`, `detail_json`
  `{ text, previous_text, operator_email }`.
- Saving the line the job already has: success with `unchanged: true`, no write,
  no event row. (Not in the build note; it keeps the audit free of no-op rows.)
- Answer: `{ success, job_id, dispatch_next_step, next_step_set_at, audit_logged }`.

### What neither may do

No write to `jobs` of any kind (so no `trg_jobs_updated`, and a card does not jump
to the top of the list). No call to `updateJobStatus`, `logBusinessEvent`,
`capture_business_event`, `ghl-proxy`, `reporting-api`, Xero, or any send helper.
No `business_events` row. No change to a booking, invoice, purchase order or work
order. The only event rows are the two types above. `job_events` has no type
check, and its one trigger stands aside for every type but three make-safe report
types, so these rows start nothing. `dispatch_stage_test.ts` drives both writes
through every success and refusal path and fails on any client call other than
`from()`, any network call, any table but `jobs` (read only), `job_dispatch_state`
and `job_events`, or any change to a `jobs` row; it also drives the handler with
the routine key and expects 403 with no table reached.

## 4. The rules (`dispatch_stage.ts`)

### Where an unset job sits

| # | Stop | Key | Fencing, patio, decking and other types, by job status | Repair, by Repairs board stage |
|---|---|---|---|---|
| 0 | not on the rail yet | `not_started` | `partially_accepted` | `wo_in`, `scoping`, `quoted`, `variation` |
| 1 | Accepted | `accepted` | `accepted`, `awaiting_deposit`, `deposit` | `approved` |
| 2 | Deposit paid | `deposit_paid` | `approvals`, `order_materials`, `processing` | `materials` |
| 3 | Materials ordered | `materials_ordered` | `awaiting_supplier` | never read |
| 4 | Supplier confirmed | `supplier_confirmed` | `order_confirmed`, `schedule_install` | never read |
| 5 | Materials on site | `materials_on_site` | never read: set by hand only | never read |
| 6 | Trade scheduled | `trade_scheduled` | `scheduled`, `in_progress`, `rectification`, `complete`, `final_payment`, `invoiced`, `get_review`, `archived` | `scheduled`, `on_site`, `complete` |

- The Repairs board stage is `insuranceRepairStage`, the function the Repairs
  board itself uses: the stored `metadata.repair_stage`, else its fallback from
  the job status. No other repair mapping exists.
- `approvals` reads stop 2 for every type, as the build note's count query does;
  the note's table names it under patio only, and no non-patio job sat at
  Approvals on 14 Oct 2026.
- A status outside the Dispatch list (only reachable through an explicit
  `status` filter) reads `not_started`.

### Which jobs are in To do

A listed job is in To do when all of these hold:

1. Its work type (`work_type`) is fencing, patio, decking or repair. Make-safe and
   every other type are out.
2. Its job status is one of `accepted`, `awaiting_deposit`, `deposit`, `approvals`,
   `order_materials`, `processing`, `awaiting_supplier`, `order_confirmed`,
   `schedule_install`, `scheduled`; and, for repair, its Repairs board stage is
   `approved`, `materials` or `scheduled`.
3. The patio council rule does not hold it (below).
4. Its place on the rail (set, else read) is 1 to 5, or 6 under slice 7's
   install rule (`docs/dispatch-slice-7-contract.md`, section 3).

So a job set at a stop stays there whatever the Jobs board does next, but a job
whose work has started, or that is cancelled or lost, is out of To do whatever
was set (the set stage still shows on its rail).

### The patio council rule

A patio or decking job is held out of To do while its status is `approvals`
(`in_council`), or while its status is `accepted`, `awaiting_deposit` or
`deposit` and `council_required` is `true` (`council_to_come`) or null
(`council_not_decided`). `council_required = false` needs no council.

### Counts at build time

The build note's query (its section 9.2), re-run 14 Oct 2026 on production:
To do 28 (fencing 13, patio 13, decking 0, repair 2); listed fencing 208, patio
88, repair 25, insurance 3. No listed repair job lacks a stored Repairs board
stage.

## 5. The table `job_dispatch_state`

One row per job (`job_id` primary key, cascade on job delete), created on the
first press. Columns: `org_id`, `stage` (the six keys or null), `stage_set_at`,
`stage_set_by` (users, null for the ops key), `stage_set_by_email`, `next_step`
(1 to 40 characters or null), `next_step_set_at`, `next_step_set_by`,
`next_step_set_by_email`, `created_at`, `updated_at`. A stage always has its set
time. Row security on with no policy and every right revoked from `anon` and
`authenticated`: only ops-api reads and writes it. Contract case:
`supabase/tests/migration-contracts/20261014113000_job_dispatch_state/`.
Rollback: `supabase/rollbacks/20261014113000_job_dispatch_state_down.sql` (roll
`ops-api` back first). Listed in `scripts/edge-function-schema-requirements.txt`
so `ops-api` cannot deploy ahead of it.

## 6. A sample answer to stub from

Made-up job numbers; two rows of a `dispatch=1` answer, other row keys as in
slice 1.

```json
{
  "columns": {
    "awaiting_supplier": [
      {
        "id": "00000000-0000-4000-8000-000000000015",
        "job_number": "SWF-900015",
        "status": "awaiting_supplier",
        "work_type": "fencing",
        "dispatch_stage": "materials_ordered",
        "dispatch_stage_index": 3,
        "dispatch_stage_source": "job_status",
        "dispatch_stage_from": "awaiting_supplier",
        "dispatch_stage_set_at": null,
        "dispatch_stage_set_by": null,
        "dispatch_todo": true,
        "dispatch_todo_out": null,
        "dispatch_next_step": null
      }
    ],
    "approvals": [
      {
        "id": "00000000-0000-4000-8000-000000000017",
        "job_number": "SWP-900017",
        "status": "approvals",
        "work_type": "patio",
        "dispatch_stage": "materials_on_site",
        "dispatch_stage_index": 5,
        "dispatch_stage_source": "set",
        "dispatch_stage_from": null,
        "dispatch_stage_set_at": "2026-10-15T01:30:00+00:00",
        "dispatch_stage_set_by": "Office Person",
        "dispatch_todo": false,
        "dispatch_todo_out": "in_council",
        "dispatch_next_step": "CHASE COUNCIL"
      }
    ]
  },
  "total": 2,
  "dispatch_stages": "ok",
  "todo_total": 1
}
```

A recorded live answer is not observed yet: the fields exist only once this
change is deployed.
