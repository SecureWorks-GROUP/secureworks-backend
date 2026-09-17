# `sales_booking_read` — consumer contract (v1, 2026-09-16; diary source GHL 2026-09-17; pack/stamp 2026-09-17; thread cache 2026-09-17)

`GET ops-api?action=sales_booking_read` is the single read behind the Sales
Booking view. It replaces the branch-local preview server
(`scripts/sales-booking-local-api.mjs` on secureworks-ux
`patio/sales-booking-20260912`) and keeps that script's response shape.

Roster, diary, and threads: `supabase/functions/ops-api/sales_booking_read.ts`.
Pack publish, captain stamp, thread-facts cache, and the read overlay:
`supabase/functions/ops-api/sales_booking_pack.ts`.
Regressions: `sales_booking_read_test.ts` and `sales_booking_pack_test.ts`
beside those files.
The GHL calendar window is one unpaged `/calendars/events` GET in
`supabase/functions/ghl-proxy/calendar_events.ts`. `ops-api` uses that
reader; `GET ghl-proxy?action=calendar_events` is the same GET as an HTTP
action (`userId` or `calendarId`, plus `start` and `end`).

## Page load may persist thread facts; send stays held

Live GHL thread reads stay the source of truth. Page load serves cached
`kind=thread_facts` facts that are still fresh (GHL last activity not newer
than `read_at`, and cache younger than 6 hours) and live-refreshes only the
rest, newest first, under the time budget. A 429 after retries still
serves a stale cached thread when one exists. That persist is the only
write on the read path. No GHL mutation, no calendar create, no send.
`send_hold: true` and `policy.{activation,send,calendar_write}: 'held'`
are constants the view renders; they are not the enforcement.

The stored thread-facts map is the latest row merged with this sweep: a
short refresh cannot drop keys the stored row already held. Skip persist
and prune when the latest-row read errors (a failed read is not an empty
store). Skip the write when the merged map equals the row just read.
After insert, delete only older `as_of` for the same resource, week_start,
and kind — a concurrent newer row stays.

`sales_booking_pack_publish` and `sales_booking_stamp_write` persist
pack/stamp rows only. `sales_booking_threads_refresh` (api key, POST) does
a full background refresh for one resource into the same thread-facts
store. Nothing is sent.

GHL 429 Too Many Requests on roster pages and thread reads retries three
times with exponential backoff and jitter. Remaining 429s are
`coverage.remaining_429_count`.

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
  `template_outbound_count`, `read_at`.
- Per case **`suburb`**, **`job_type`**, **`enquiry_at`**, **`pipeline_stage_id`**
  beside `stage_name`. Suburb is contact city, a WA suburb parsed from the
  street line, or `jobs.site_suburb` when GHL has no parseable city/address.
  Job type is enquiry tags then the resource book lane (Nithin patio, Marnin
  fencing). Either field is `"not given"` when none of those exist — never
  invented. A live-week missing-rate bar is not acceptance: 14 Sep 2026
  measured Nithin 39 of 107 and Marnin 192 of 448 suburb not given after
  contact hydrate and job-site fill (job type 0 of 107 / 0 of 448). That is
  a CIO data gap, not a code defect. `enquiry_at` is opportunity created.
- **`coverage.threads_cached` / `threads_fresh` / `threads_unread` /
  `remaining_429_count`** — honest cache vs live vs unread vs leftover 429s.
- **`diary_read`** — `{read_ok, reason, source, calendar_email, ghl_user_id, mapped_by}`.
  `source` is `ghl_calendar`. `calendar_email` may be null; `ghl_user_id` is
  the confirmed GHL user id or null when unread. `mapped_by` is `email` or
  `name` when that id was confirmed, else null. Name is the weaker match:
  `reason` is then `ghl_user_mapped_by_name`.
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
- `POST sales_booking_threads_refresh` (api key only): body `{resource,
  week_start?}`. Force-refreshes in-scope threads for that resource, persists
  `kind=thread_facts` (`week_start` 1970-01-05), returns the same read payload.
  No send.

Table: `sales_booking_packs`. Pack and stamp keep history; latest = greatest
`as_of` per `(resource, week_start, kind)` and older rows are ignored.
Thread facts keep one latest row per resource at `week_start` 1970-01-05:
writers insert then delete older `as_of` only. RLS on, no client
access. Migrations `20260917130000_sales_booking_packs.sql` and
`20260917180000_sales_booking_thread_facts.sql` (kind check includes
`thread_facts`).

## Reading it honestly

- **`coverage.enumerated`** and **`cases[]`** are the scoped book: open
  opportunities whose GHL stage still needs a visit, a reply or a quote
  (`resource.scope_stage_ids`, the visit/reply/quote prefix of wiki
  `harness/ops/skills/secureworks-scope-booking/profiles/patio-nithin.json`
  and `fencing-stratco-marnin.json` `pipeline_stages`). Dropped as first-touch
  inflation, not visit/reply/quote: patio **Client Needs To Be Contacted**
  (`09759a42-…`, 193 of 300 live Nithin rows on 17 Sep); fencing **New Lead
  (Call + Qualify)** (`cc401467-…`, 22 live Marnin rows), **Stale Lead**
  (`8c43212e-…`, ghl-proxy maps to cancelled), **Called, No Answer**
  (`341d6a77-…`). Quote-sent, won, hold, lost, archive, and blank or unknown
  stage ids are also left out.
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
and holds the `public.users.email` for that scoper (`nithin@` /
`marnin@secureworkswa.com.au`, source
`20260322000005_fix_user_roles.sql` plus the wiki profile `calendar_email`).
The live GHL id is confirmed at read time against `GET /users/?locationId=`:
unique email first, then unique first/display name (`name_match: nithin` /
`marnin`). Live 17 Sep: Nithin's recorded email was absent from that roster
(`ghl_user_unmapped`); a unique name match maps him and `diary_read` stays
`read_ok` with `mapped_by: name`, `reason: ghl_user_mapped_by_name`, and
`calendar_email` set to the live GHL email. Zero or several name matches stay
unread with `ghl_user_unmapped` — never first-match-wins. Khairo is not
mapped.
