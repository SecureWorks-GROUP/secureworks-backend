# `sales_booking_read` — consumer contract (v1, 2026-09-16; diary source GHL 2026-09-17; pack/stamp 2026-09-17)

`GET ops-api?action=sales_booking_read` is the single read behind the Sales
Booking view. It replaces the branch-local preview server
(`scripts/sales-booking-local-api.mjs` on secureworks-ux
`patio/sales-booking-20260912`) and keeps that script's response shape.

Roster, diary, and threads: `supabase/functions/ops-api/sales_booking_read.ts`.
Pack publish, captain stamp, and the read overlay:
`supabase/functions/ops-api/sales_booking_pack.ts`.
Regressions: `sales_booking_read_test.ts` and `sales_booking_pack_test.ts`
beside those files.
The GHL calendar window is one unpaged `/calendars/events` GET in
`supabase/functions/ghl-proxy/calendar_events.ts`. `ops-api` uses that
reader; `GET ghl-proxy?action=calendar_events` is the same GET as an HTTP
action (`userId` or `calendarId`, plus `start` and `end`).

## The read writes nothing; send stays held

`sales_booking_read` is still a reader: no Supabase mutation, no GHL write,
no calendar create, no send. `send_hold: true` and
`policy.{activation,send,calendar_write}: 'held'`
are constants the view renders; they are not the enforcement, because this
action has no send or calendar-write capability to gate.

The first writes are `sales_booking_pack_publish` and
`sales_booking_stamp_write` below. They persist pack/stamp rows only.
Nothing is sent.

## Request

| Param | Default | Notes |
|---|---|---|
| `resource` | `nithin` | `nithin` (patio) or `marnin` (fencing/Stratco). Anything else is a 400. |
| `week_start` | current Perth week | ISO date, MUST be a Monday. A non-Monday or an impossible date is a 400. |
| `scoper_user_id` | the resource's own | Overrides the CALENDAR read only, and only when it matches a v1 scoper (Nithin / Marnin). The roster still comes from the resource's pipeline. An unknown uuid is `ghl_user_unmapped`, never a guessed GHL user. |
| `include_thread_facts` | `true` | `false` skips every GHL thread read. |
| `thread_limit` | 200 (max 250) | Newest-activity-first cap on thread reads, spent on scoped rows only. |
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

- **`diary[]`** — the scoper's GHL calendar events for Mon..Sun of
  `week_start`. Each entry: `event_id`, `start`, `end` (ISO with `+08:00`),
  `title`, `kind` (`busy` | `leave` | `personal`), `source` (`ghl_calendar`),
  plus `show_as`, `blocks_capacity`, `is_all_day`, `location`, `title_withheld`.
- **`thread_facts{}`** — keyed by case id: `last_inbound_at`,
  `last_human_outbound_at`, `last_outbound_at`, `quiet_window`, `quiet_hours`,
  `classification`, `read_ok`, `reason`, `message_count`,
  `template_outbound_count`.
- **`diary_read`** — `{read_ok, reason, source, calendar_email, ghl_user_id}`.
  `source` is `ghl_calendar`. `calendar_email` may be null; `ghl_user_id` is
  the confirmed GHL user id or null when unread.
- **`resource`** — the selected profile: `lane`, `pipeline_id`,
  `scoper_user_id`, `sender_line`, `sender_line_source`,
  `scope_stage_ids`, plus `calendar`
  `{ok, error, mailbox}` copied from `diary_read` (not a second calendar
  read). The Booking door paints "Calendar not connected" when
  `resource.calendar.ok` is false.
- **`defaults`** — the Captain defaults this response was produced under, so
  the view shows what the server assumed rather than hard-coding it.
- **`pack`** — `{present, as_of}` for the latest `sales_booking_packs` row
  with `kind=pack`. Absent when the engine has not published this week.
- **`stamp`** — `{present, as_of, approved, rejected, decisions, stage_moves}`
  from the latest `kind=stamp` row. The captain Send stamp; nothing is sent.
- Per case **`proposal`** — `{disposition, day, window_start, window_end,
  draft, why[]}` merged from that pack by opportunity id. Pack row ids are
  `opp:<ghlOpportunityId>`; merge strips the `opp:` prefix only (`opp-…`
  is a live GHL id and is left intact). No match → `null`.
  `proposals` is the engine's `proposals.json`: a top-level array, or
  `{leads: [...]}`. Window fields are `day`, `start`, `end`. `why[]` is
  collected from the row's `why` and `failures` only.
- Per case **`stamp_state`** — `'none' | 'approved' | 'rejected'`. Stamp
  `approved` and `rejected` lists carry the door's bare GHL opportunity ids
  (the case ids); pack-style `opp:<id>` is also accepted. Matching a case
  uses both forms.
- **`drafts`** — filled from the pack's drafts map (opportunity id → text),
  with a row `draft` filling a missing map entry. Empty `{}` when no pack
  is present.

Publish / stamp actions (same table, no send):

- `POST sales_booking_pack_publish` (api key only): body
  `{resource, week_start, as_of, proposals, coverage, drafts}` where
  `proposals` is the engine's `proposals.json` (array or `{leads}`),
  `coverage` its `coverage.json`, and `drafts` a map of opportunity id to
  draft text. Stores `kind=pack`. Returns `{ok, id, as_of}`.
- `POST sales_booking_stamp_write` (api key or signed-in
  admin / owner / ops_manager): body `{resource, week_start, stamp}` where
  `stamp` is `{captain, approved, rejected, decisions, stage_moves}`.
  Stores `kind=stamp` with `as_of` now. No other side effect.
- `GET sales_booking_stamp_read` (api key only): `{resource, week_start}`
  returns the latest stamp payload and `as_of`, or
  `{ok:true, stamp:null, as_of:null}`.

Table: `sales_booking_packs`. Latest = greatest `as_of` per
`(resource, week_start, kind)`. An older pack is ignored. RLS on, no client
access. Migration `20260917130000_sales_booking_packs.sql`.

## Reading it honestly

- **`coverage.enumerated`** and **`cases[]`** are the scoped book: open
  opportunities whose GHL stage still needs a visit, a reply or a quote
  (`resource.scope_stage_ids`, the visit/reply/quote prefix of wiki
  `harness/ops/skills/secureworks-scope-booking/profiles/patio-nithin.json`
  and `fencing-stratco-marnin.json` `pipeline_stages`). Quote-sent, won,
  hold, lost, archive, and blank or unknown stage ids are left out.
  **`coverage.excluded_by_stage`** is how many unique open rows were dropped
  for that reason. **`coverage.total`** stays the GHL open-pipeline search
  total (unscoped). CRM row count is not visit demand.
- **`coverage.full_population`** is TRUE only when the GHL roster scan reached
  the real end of the result set with no degradation. FALSE means the book is
  incomplete, never that it is small. Every gap is a sentence in
  `coverage.gaps`. The live search is `pipelineId` + `status=open`; GHL v3
  search takes only one `pipelineStageId`, so stage scope is applied after
  enumeration and before the thread pass.
- **`diary` empty with `diary_read.read_ok:false`** is an UNREAD calendar, not a
  clear week. Unread coverage is never free capacity. Named unread reasons
  include `ghl_user_unmapped` (no confirmed GHL user for that scoper) and
  `ghl_calendar_page_failed` (the unpaged GHL events GET did not complete).
- **`thread_facts[id].read_ok:false`** means nothing was proved about that
  thread. The case still appears, and its `status` stays the default
  `needs_decision`. Classification lives only in `thread_facts`.
- **Cases with no entry in `thread_facts`** were never attempted (a bound was
  hit). `coverage.gaps` names how many and why. Do not paint them as clear.
- **`kind` and `blocks_capacity` come from GHL `appointmentStatus` only.**
  Confirmed/booked (and any non-cancelled status) block; cancelled or deleted
  does not block but is still returned with `show_as:'cancelled'`. GHL has no
  leave/personal sensitivity, so those kinds are never invented from a title.
  **`is_all_day` is `event.isAllDay === true` only** — no midnight or duration
  inference. **`title_withheld` is always false** (GHL has no
  private-sensitivity flag).
- **`classification` never emits `booked`.** A booking is a calendar /
  commitment fact this read cannot attribute to a case, and guessing one would
  invent it.

Templates: an outbound body containing `thanks for reaching out to secureworks`
or `sorry we missed your call` is automation. It never becomes
`last_human_outbound_at`, never starts the quiet window, and never makes a case
look answered.

## GHL user mapping

There is no `ghl_user_id` on `users`, `scoper_preferences`, or ghl-proxy
config. `SALES_BOOKING_GHL_USERS` is keyed by resource (`nithin`, `marnin`)
and holds the `public.users.email` for that scoper (`nithin@` / `marnin@`).
The live GHL id is confirmed at read time against `GET /users/?locationId=`.
If the email is missing from that roster, or `scoper_user_id` is not a v1
scoper, the diary is unread with `ghl_user_unmapped`. Khairo is not mapped.
GHL user ids were not confirmed against a live location in this change; a
live read after CI is owed to the CIO's key holder.
