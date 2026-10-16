# Dispatch slice 7: schedule the trade, confirm the install

What `ops-api` gives the Ops screen's Dispatch tab for slice 7: who is booked for
the install and on what day, and Dispatch's own install confirmation mark. One
read addition and one write. Builds on `docs/dispatch-slice-3-contract.md`;
everything there still holds except the To do rule at Trade scheduled (section 3).

| Part | Where |
|---|---|
| Rules (pure) | `supabase/functions/ops-api/dispatch_install.ts` |
| The write | `supabase/functions/ops-api/dispatch_install_write.ts` |
| The read | `pipeline` in `supabase/functions/ops-api/index.ts`, under `dispatch=1` |
| Columns | four on `job_dispatch_state`, migration `20261014190000_job_dispatch_install_confirmed.sql` |

## 1. The rule in one line

The mark is Dispatch's own record (ruling I1), never the calendar's lock on a
booking. A press writes the four `install_confirmed_*` columns of the job's
`job_dispatch_state` row and one `job_events` row, and nothing else: no booking,
no job status, no Dispatch stage, no message, no money, no CRM, no AI read. The
calendar's lock (`job_assignments.confirmation_status`) is shown as a fact and
never counted.

## 2. The read: `GET ops-api?action=pipeline&dispatch=1`

No new read. Under `dispatch=1` only, the existing bookings read
(`job_assignments`, same filter, same place in the wave) also selects
`id, user_id, assignment_type, scheduled_end, is_lead, confirmation_status,
person:user_id(name)`, and slice 3's `job_dispatch_state` read selects
`install_confirmed_at, install_confirmed_by, install_confirmed_by_email,
install_confirmed_for_day, install_confirmer:install_confirmed_by(name)`. The
plain `pipeline` answer is byte for byte unchanged, `assignment_count`,
`first_`, `next_` and `last_scheduled_date` included.

### Top of the answer

| Field | Meaning |
|---|---|
| `dispatch_installs` | `ok` or `failed` |
| `todo_total` | as slice 3, counted by the rule in section 3 |

**A failed read is never "not booked".** When the bookings read errors, the
answer has `dispatch_installs: "failed"` **and** `dispatch_stages: "failed"`,
no `todo_total`, and no stage or install field on any row (To do can no longer
be decided). When the state read errors, both are `failed` too. Both are logged.

### Per row

```
dispatch_install: {                    null on a make-safe row
  state: 'ahead' | 'past' | 'none',
  day: 'YYYY-MM-DD' | null,            earliest install day on or after today (Perth); else the latest; else null
  end_day: 'YYYY-MM-DD' | null,        latest scheduled_end among that day's bookings, when later than day
  people: [ { name, lead } ],          everyone booked on day, lead first, then name in C order; blank name "Name not on record"
  also_days: [ 'YYYY-MM-DD' ],         every later distinct install day on or after today, uncapped
  calendar_confirmed: boolean,         a booking on day has confirmation_status 'confirmed' (shown, never counted)
  confirmed: { at, by, for_day } | null,   by = the confirmer's users.name, else the stored email
  confirmed_current: boolean
}
dispatch_install_open: 'not_confirmed' | 'moved' | 'booked_after' | null
```

**Install bookings:** `assignment_type = 'install'`, `status` not `cancelled`
(null counts, checked in code), `is_ghost` false, `role` not `observer`,
`scheduled_date` set. Today is the Perth day (`_perthTodayYmd`); a booking dated
today counts as ahead. Bookings are read for the listed non-draft jobs (the
existing read's scope), so a draft shown through a `status=draft` filter reads
`none`.

**`confirmed_current`:** with `for_day`, while the job still has an install
booking on `for_day`, past or ahead (one confirmation is for the install, so it
does not lapse when `day` moves on to the next install day); with `for_day`
null, while no install is booked ahead.

**`dispatch_install_open`**, set only on a stop 6 job in To do: `not_confirmed`
(no mark), `moved` (no install booking remains on the mark's `for_day`),
`booked_after` (marked with nothing booked, a booking made since). Null
otherwise.

## 3. To do (one condition changed in slice 3's `dispatchTodo`)

```
in To do = stop 1 to 5
        or (stop 6 and state is 'ahead' or 'none' and not (confirmed and confirmed_current))
```

Everything else in slice 3's rule stands: the window, the work types, the
council hold. Ruling I7: on go-live, every stop 6 job in the window with an
install ahead (or none) and no mark comes back into To do.

`set_dispatch_stage` answers its `dispatch_todo` by the same rule: it reads the
job's bookings (read only). Its answer carries no install field. If the bookings
read fails the stage write still goes through, the failure is logged, and
`dispatch_todo` is `null` (unknown).

## 4. The write: `POST ops-api?action=set_dispatch_install_confirmed`

Staff session or the privileged ops key only (gated as `update_repair_stage`);
not the routine key, a trade session or the agent read list (403
`operator_access_required`). GET is 405.

Body: `{ job_id, confirmed, expected_install_day, expected_confirmed_at,
operator_email? }`.

Who it names: a signed-in person by the verified session (`install_confirmed_by`
is their user id; the email is the session's, else their `users.email`). The ops
key has no user: `operator_email` must match a `users` row (case does not
matter), and that row's email is stored; `install_confirmed_by` is null.

| Answer | When |
|---|---|
| 400 | `job_id` missing or not a uuid; `confirmed` not a boolean; `expected_install_day` absent or not `YYYY-MM-DD`/null; `expected_confirmed_at` absent or not a time/null |
| 400 `operator_required` | the ops key with no `operator_email`, or one matching no user |
| 404 | the job is not in the organisation |
| 409 `not_dispatch_work` | a make-safe job (by `dispatchWorkType`; a repair-family make-safe is allowed) |
| 409 `install_changed` | the server's install `day` differs from `expected_install_day`; carries the current fields; nothing written |
| 409 `confirmation_changed` | the stored `install_confirmed_at` differs from `expected_confirmed_at`, a row was inserted in between, or the guarded update matched no row; carries the current fields; nothing written |

- `confirmed: true` writes `install_confirmed_at` now, `install_confirmed_by`,
  `install_confirmed_by_email`, `install_confirmed_for_day` = the server's
  `day`. Already confirmed for that day: `unchanged: true`, no event. Another
  day: replaced.
- `confirmed: false` clears the four columns. Not confirmed: `unchanged: true`.
- No row: inserted (stage and next step stay null). Otherwise an update guarded
  on the `install_confirmed_at` it read.
- Then one `job_events` row (`user_id` when a person is signed in):
  `dispatch_install_confirmed` `{ for_day, people, booking_ids,
  calendar_confirmed, previous: { at, by_email, for_day } | null,
  operator_email }`, or `dispatch_install_confirmed_cleared` `{ was_confirmed_at,
  was_confirmed_by_email, was_for_day, operator_email }`. If it fails after the
  state row landed: logged, success with `audit_logged: false`.

Answer: `{ success, unchanged?, job_id, dispatch_install, dispatch_install_open,
dispatch_todo, dispatch_todo_out, audit_logged }`, from the same functions as
the list.

Never written: `jobs`, `job_assignments`, `business_events`,
`jarvis_event_log`, the stage and next-step columns. Never called:
`createAssignment`, `updateAssignment`, `deleteAssignment`,
`confirmAssignment`, `bulkConfirm`, `updateJobStatus`, `logBusinessEvent`,
`capture_business_event`, `sendSmsViaGhl`, `ghl-proxy`, `reporting-api`, Xero
or any send.

## 5. The record

`job_dispatch_state` gains `install_confirmed_at timestamptz`,
`install_confirmed_by uuid references users(id) on delete set null`,
`install_confirmed_by_email text`, `install_confirmed_for_day date`, all
nullable, and two checks: `job_dispatch_state_install_confirmed_named`
(a time and an email together or neither) and
`job_dispatch_state_install_confirmed_dated` (no user or day without a time). No
table, trigger, function or publication. Rollback:
`supabase/rollbacks/20261014190000_job_dispatch_install_confirmed_down.sql`.
Contract case: `supabase/tests/migration-contracts/20261014190000_job_dispatch_install_confirmed/`.
`20261016160000_job_dispatch_install_for_day_comment.sql` restates the
`install_confirmed_for_day` column comment to the section 2 rule; it changes
nothing else.

## 6. List read time on production

Before: not observed (this change was built without production API access).
After: not observed. The desk measures `pipeline&dispatch=1` wall time on
production before and after the deploy and records both figures here.
