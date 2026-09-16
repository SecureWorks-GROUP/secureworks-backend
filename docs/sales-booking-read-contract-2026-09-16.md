# `sales_booking_read` — consumer contract (v1, 2026-09-16)

`GET ops-api?action=sales_booking_read` is the single read behind the Sales
Booking view. It replaces the branch-local preview server
(`scripts/sales-booking-local-api.mjs` on secureworks-ux
`patio/sales-booking-20260912`) and keeps that script's response shape.

Implementation and the full rationale: `supabase/functions/ops-api/sales_booking_read.ts`.
Regressions: `supabase/functions/ops-api/sales_booking_read_test.ts`.

## It is read-only, and send stays held

No write of any kind: no Supabase mutation, no GHL write, no calendar create,
no send. Every dependency is a reader and a test parses the module for write
verbs. `send_hold: true` and `policy.{activation,send,calendar_write}: 'held'`
are constants the view renders; they are not the enforcement, because this
action has no send or calendar-write capability to gate.

## Request

| Param | Default | Notes |
|---|---|---|
| `resource` | `nithin` | `nithin` (patio) or `marnin` (fencing/Stratco). Anything else is a 400. |
| `week_start` | current Perth week | ISO date, MUST be a Monday. A non-Monday or an impossible date is a 400. |
| `scoper_user_id` | the resource's own | Overrides the CALENDAR read only. The roster still comes from the resource's pipeline. |
| `include_thread_facts` | `true` | `false` skips every GHL thread read. |
| `thread_limit` | 80 (max 250) | Newest-activity-first cap on thread reads. |
| `thread_budget_ms` | 18000 | Wall-clock cap on the thread sweep. |
| `case_ids` | all | Comma-separated: read threads for these cases only. |

Auth is the ops-api default: an ops API key, or a signed-in
admin / owner / ops_manager session. It is deliberately NOT on the make-safe
routine allow-list and NOT a lead-installer read.

## Response

Reference keys, unchanged: `ok`, `fixture:false`, `send_hold:true`,
`version:'sales-booking-api/v1'`, `week_start`, `coverage`, `cases[]`,
`drafts`, `policy`.

Additions:

- **`diary[]`** — the scoper's PRIMARY Outlook events for Mon..Sun of
  `week_start`. Each entry: `event_id`, `start`, `end` (ISO with `+08:00`),
  `title`, `kind` (`busy` | `leave` | `personal`), `source` (`outlook_primary`),
  plus `show_as`, `blocks_capacity`, `is_all_day`, `location`, `title_withheld`.
  `events` is the SAME array under the key the shipped view already reads.
- **`thread_facts{}`** — keyed by case id: `last_inbound_at`,
  `last_human_outbound_at`, `last_outbound_at`, `quiet_window`, `quiet_hours`,
  `classification`, `read_ok`, `reason`, `message_count`,
  `template_outbound_count`.
- **`diary_read`** — `{read_ok, reason, source, calendar_email}`. Also mirrored
  at `resource.calendar` (with `leave: 'not_read'`) for the shipped view.
- **`resource`** — the selected profile: `lane`, `pipeline_id`,
  `scoper_user_id`, `sender_line`, `sender_line_source`.
- **`defaults`** — the Captain defaults this response was produced under, so
  the view shows what the server assumed rather than hard-coding it.

## Reading it honestly

- **`coverage.full_population`** is TRUE only when the GHL roster scan reached
  the real end of the result set with no degradation. FALSE means the book is
  incomplete, never that it is small. Every gap is a sentence in
  `coverage.gaps`.
- **`diary` empty with `diary_read.read_ok:false`** is an UNREAD calendar, not a
  clear week. Unread coverage is never free capacity.
- **`thread_facts[id].read_ok:false`** means nothing was proved about that
  thread. The case still appears, and its `status` stays the default
  `needs_decision` with `status_source:'unread'`.
- **Cases with no entry in `thread_facts`** were never attempted (a bound was
  hit). `coverage.gaps` names how many and why. Do not paint them as clear.
- **`kind` comes from provider fields only.** `showAs:oof` is leave; a private
  sensitivity is `personal` (its subject and location are withheld); everything
  else is `busy`. A subject that merely says "leave" is not a leave fact.
- **`classification` never emits `booked`.** A booking is a calendar /
  commitment fact this read cannot attribute to a case, and guessing one would
  invent it.

Templates: an outbound body containing `thanks for reaching out to secureworks`
or `sorry we missed your call` is automation. It never becomes
`last_human_outbound_at`, never starts the quiet window, and never makes a case
look answered.

## Known caveat

`scoper_preferences.work_calendar_email` is LIVE DRIFT: production carries it
and the jarvis `sw_scoper_calendar_events` tool reads it, but the only repo file
defining it is `supabase/migrations/_drafts/20260505060000_scoper_preferences_work_calendar_email.sql`.
It is deliberately NOT declared in `scripts/edge-function-schema-requirements.txt`
(that manifest needs a ledgered migration version, and this column has none).
The read checks the PostgREST error instead, so an absent column surfaces as
`diary_read.read_ok:false` with `scoper_preferences_unreadable: ...` rather than
as a silently empty week. Confirm it read-only with:

```sql
select user_id, work_calendar_email from public.scoper_preferences
 where user_id in ('5862cf1d-0a3b-4836-8fd1-d69f95aa2f73',
                   '706c5258-70dd-483a-b36c-af6864b24498');
```
