# Trade invoice time entries (12 Oct 2026)

Owner's ask, 12 Oct 2026: a trade invoicing SecureWorks Group for hours must
enter the date worked and a start and finish time, and that is stamped against
the job, so inconsistencies show and a job's story can be pieced together.

This is the back end. The trade app screens are a paired change in
`secureworks-ux`.

- Rule owner: `supabase/functions/ops-api/trade_invoice_time_entry.ts`
- Migration: `supabase/migrations/20261012180000_trade_invoice_time_entries.sql`
- Tests: `supabase/functions/ops-api/trade_invoice_time_entry_test.ts`,
  `supabase/tests/migration-contracts/20261012180000_trade_invoice_time_entries/`

## The contract

Every invoice line that bills a trade's time carries:

| Field | Form | Notes |
| --- | --- | --- |
| `work_date` | `YYYY-MM-DD` | The Perth calendar day worked. Never after today, Perth |
| `start_time` | `HH:MM`, 24-hour | Perth local time. Exactly `HH:MM`: a time with seconds is refused |
| `finish_time` | `HH:MM`, 24-hour | After `start_time` on the same `work_date`. Exactly `HH:MM` |
| `break_minutes` | whole minutes | Optional, default 0 |

- Hours are `(finish_time - start_time) - break_minutes`, rounded to 2 decimal
  places. The server computes and stores them. A client hours figure more than
  0.01 away is refused.
- One line is one job on one day. Two days on a job is two lines. A shift
  across midnight is two lines.
- The trade types every time line's date and times. The trade app pre-fills
  none of them and no longer sends any `source: 'extra_day'` value; the server
  never read that value, so nothing here depends on it.
- A line is a time line when its type is Labour, Fencing, Patio, Make Safe or
  General Labour (`TRADE_INVOICE_TIME_LINE_TYPES`, the same list the existing
  hours guard reads). Materials, travel, equipment, commission, work order and
  other lines carry none of these fields; any sent on them are ignored.

### What the trade app sends

| Action | Where the fields go |
| --- | --- |
| `generate_trade_invoice` | on each `manual_assignments[]` entry (job card), beside `assignment_id`. The same `assignment_id` may repeat, once per day worked. `hours` may be omitted. |
| `generate_trade_invoice` | on each time-type `extra_items[]` entry (a searched-in hours line). `quantity` may be omitted; the server sets it to the computed hours. |
| `save_trade_invoice_draft` | on each `labour_lines[]` entry and each time-type `extra_items[]` entry. |

### What comes back on a refusal

HTTP 422, body `{ ok: false, success: false, saved: false, code, error, userMessage }`.
Nothing is written before a refusal.

| Code | When | Flag off | Flag on |
| --- | --- | --- | --- |
| `time_entry_required` | a time line has none of the three fields | accepted | refused |
| `time_entry_required` | a job card the server collected itself has no saved job-view times and no same-day stamps | accepted | refused, naming each job and day |
| `time_entry_required` | a time line has some but not all three | refused | refused |
| `time_entry_future_date` | `work_date` is after today, Perth | refused | refused |
| `time_entry_finish_before_start` | finish is not after start | refused | refused |
| `time_entry_hours_mismatch` | client hours differ from the computed hours by more than 0.01 | refused | refused |
| `time_entry_invalid` | a malformed date, time or break, or a break as long as the shift | refused | refused |
| `time_entry_overlap` | two lines for the same job card overlap on one day | refused | refused |

The refusal for job cards the server collected itself (lanes 3 and 6 below) is
one answer for the whole invoice. Its message names every job and day that
needs times and gives both ways to fix it: log the hours on that job for that
day with a start and finish time, or enter them on that job's card in the
Weekly Invoice. The body also carries them as `needs_times`:
`[{ assignment_id, job_id, job_number, work_date }]`, where `work_date` is the
card's scheduled day. Cards that already have an entry are not named.

### What every read returns

Each invoice line carries `work_date`, `start_time`, `finish_time` and
`break_minutes` (all null when the line has no entry): `get_trade_invoice`,
`my_invoices`, `generate_trade_invoice`'s returned invoice,
`list_trade_invoice_lines`, `list_trade_invoices` and
`crew_charges_on_my_jobs`. `start_time` and `finish_time` are stored as text
`HH:MM`, so every read answers the contract form as it stands.

`my_hours` (the read the Weekly Invoice card uses) carries, on each
`assignments[]` card, `logged_time_entry`: `{ work_date, start_time,
finish_time, break_minutes, hours }` or `null`. See "Times saved on the job
view" below.

## The flag

`feature_flags.trade_invoice_time_entry_required_v1`, seeded **off**.

- Off: the fields are stored when sent and a time line without them is
  accepted, exactly as before.
- On: a time line without them is refused `time_entry_required`.
- A missing or unreadable flag reads as off: a flag fault never stops a trade
  submitting.

Firstmate turns the flag on only on the owner's word, after the trade app
screens are live. Until then no trade is locked out of invoicing.

## Every path a trade's time line is written through

| # | Action | Lane | How the lines are saved | Where the entry comes from |
| --- | --- | --- | --- | --- |
| 1 | `generate_trade_invoice` | job cards (`manual_assignments`) | direct insert | the request. A card with an entry is its own line; a card without one still groups per job. |
| 2 | `generate_trade_invoice` | searched-in hours lines (`extra_items`, time types) | direct insert | the request |
| 3 | `generate_trade_invoice` | auto-collected clock lane (no job cards sent) | direct insert | flag off: the clock's own on and off stamps. Flag on: the trade's saved job-view times while they make the card's hours, else those stamps |
| 4 | `save_trade_invoice_draft` | no week | direct insert | the request, stored as sent |
| 5 | `save_trade_invoice_draft` | dated week | `persist_weekly_trade_invoice_v2` | the request, stored as sent |
| 6 | `submit_trade_invoice` | legacy hourly lane | direct insert | flag off: the assignment's started and completed stamps. Flag on: the trade's saved job-view times while they make the hours this lane bills, else those stamps |

Not time lines, unchanged: the weekly work-order invoice (`work_order_blocks`:
priced scope lines, crew deductions and `labour_deduction` lines),
`submit_work_order_invoice`, the per-metre lane of `submit_trade_invoice`, and
work order, commission, materials, travel, equipment and other extras
(including the named crew `wo_labour_lines` inside a work order line).
`review_crew_charge` and `acknowledge_invoice_line` change a saved line's
review fields only. `log_my_job_hours` writes hours on the job card, not an
invoice line; see "Times saved on the job view".

### Decisions worth knowing

- **Drafts are never refused.** A draft is a working copy: each field is kept
  when well formed and dropped when not (a day worked after today is dropped
  the same way), a half-filled entry is kept, and a complete entry sets the
  line's hours. Submit is where an entry is required
  and checked. Drafts are also not in a job's list.
- **Auto-collected lanes (3 and 6) never ask for what the trade already
  gave.** Nobody types on those lanes. The billed hours do not move.
  - Flag off, unchanged: the entry is the clock's stamps (lane 3) or the
    assignment's started and completed stamps (lane 6), read in Perth time.
    The lines group per job as before, and a line that is one card says when
    it was worked. Saved job-view times are not read.
  - Flag on: each card is its own line, and takes its entry in this order.
    First, the trade's own times saved on the job view for that card (see
    below), but only while they make the hours that line bills: the card's
    `hours_worked` on lane 3, completed minus started on lane 6. A stored
    entry always makes the hours its line bills, so saved times that
    disagree are never stamped and their hours are never billed in place of
    the lane's own. Else the same-day pair of stamps, as above. Only a card
    with neither is refused `time_entry_required`, and that one refusal names
    every job and day that needs times and both ways to give them, so the
    trade fixes exactly those and submits again. Nothing is written before
    the refusal.
  - If the saved times cannot be read the submit fails with that reason. It
    is never treated as "none saved", which would name cards the trade has
    already given times for.
- **Existing invoices and drafts are untouched.** No backfill, no invented
  times. Their four fields stay null.
- **The Xero bill is unchanged in wording.** A job card with an entry is one
  bill line per day rather than one per job, with the same rate.

## Times saved on the job view (`log_my_job_hours`)

A trade who logs a job card's hours on the job view may send the same four
fields. Body: `{ job_id, work_date, start_time, finish_time, break_minutes?,
hours?, assignment_id? }`.

- Which job card the log goes on. Two days on one job are two job cards, and
  logging one day never replaces another day's hours.
  - `assignment_id`, when sent, names the card and wins. It must be one of the
    trade's own live cards on that job, else HTTP 404 and nothing is written.
  - Else, with times: the card for that `work_date`. That is the card already
    holding that day's saved times (so logging the day again corrects it),
    else the trade's card scheduled that day.
  - Else the usual pick (in progress, then the newest scheduled, then the
    newest by date). If the card it lands on already holds hours for another
    day, the log is refused HTTP 409 and nothing is written: the trade enters
    those times on the Weekly Invoice, or the office adds them to the job for
    that day.
  - Hours logged without times and without `assignment_id` use the usual pick,
    as before.

- All three of `work_date`, `start_time`, `finish_time`, or none. With them the
  hours are the server's (finish minus start minus break, 2 decimal places, not
  rounded to the quarter hour); a sent `hours` more than 0.01 away is refused.
  The same refusal codes as an invoice line apply, HTTP 422, nothing written.
- The times are stored with that hours record: table
  `job_assignment_logged_times`, one row per job card, replaced on a re-log. It
  is its own table because every `job_assignments` column is inside the
  make-safe fact hash.
- Hours logged without times work exactly as before (0.25 to 24, quarter hour)
  and clear any saved times.
- This door never requires times, whatever the flag says: the flag is about
  invoice lines.
- Response adds `time_entry`: the saved entry, or `null`.
- `my_hours` returns it per card as `logged_time_entry`, only while it still
  describes the card's hours: if the office or the clock changes
  `hours_worked` afterwards, the saved times are stale and read `null`.
- Saved times are used only while they make the hours they are read against
  (the card's hours, or the hours an invoice line bills for it) and only for
  the trade who saved them. That one rule (`loggedTimeEntryForCard`) serves
  all three readers: `my_hours`, the auto-collected invoice lanes and the
  job's list.
- On a job card the trade ticks on the Weekly Invoice, the server does not
  copy saved times onto the line: the card opens on them and the trade submits
  them as the line's entry. On a job card the server collects itself, with the
  flag on, the saved times are the line's entry (see "Decisions worth
  knowing").
- They are listed against the job straight away: see "Stamped against the
  job".

## Stamped against the job

Two sources make a job's list, and each entry says which it is in `source`:

- `invoice`: view `public.job_trade_time_entries`, one row per submitted time
  line that says when it was worked.
- `job_view`: the times a trade saved on the job view
  (`job_assignment_logged_times`), while they still describe the card's hours.
  These carry who, which day, start, finish, break and hours, and **no invoice
  fields**: `trade_invoice_line_id`, `line_type`, `trade_invoice_id`,
  `invoice_number`, `invoice_status` and `submitted_at` are all null. Once the
  same trade has a submitted time line on the job for that day, the `invoice`
  entry stands in its place and the `job_view` entry is no longer listed.

| Column | Meaning |
| --- | --- |
| `source` | `invoice` or `job_view` |
| `job_id`, `job_number` | the job |
| `user_id`, `user_name` | who |
| `work_date`, `start_time`, `finish_time`, `break_minutes` | which day, from when to when (Perth) |
| `started_at`, `finished_at` | the same two instants as `timestamptz` |
| `hours` | the hours the line billed; for `job_view`, the hours the saved times make |
| `trade_invoice_id`, `invoice_number`, `invoice_status`, `submitted_at` | which invoice |
| `trade_invoice_line_id`, `line_type` | the line |

Drafts are left out. A rejected invoice (`ops-reject`) stays in, with its
status, because it is still what the trade claimed.

Ops reads it through the job detail read it already uses:
`ops-api?action=job_detail` now returns `trade_time_entries` (the list, both
sources, by day then start) and `trade_time_entries_error`. A failed read of
either source answers `trade_time_entries: null` with the reason, never a
short or empty list.

### Hand-off for the CIO desk (context system)

Nothing in the context system's functions was changed. The job record can pick
the entries up from `public.job_trade_time_entries` by `job_id`: it is a plain
view, `security_invoker`, readable by the service role only. `started_at` and
`finished_at` are ready-made instants for a timeline; `invoice_status` tells a
live claim from a rejected one. Rows exist only for invoices submitted after
this change with the fields sent. The view holds the `invoice` source only;
times saved on the job view and not billed yet are in
`public.job_assignment_logged_times` (service role only, one row per job card).

## Rollout order

1. Merge this change. The migration applies before the edge deploy.
2. The trade app screens go live (paired change in `secureworks-ux`).
3. On the owner's word, firstmate sets the flag on.

Rollback keeps the recorded times: see
`supabase/rollbacks/20261012180000_trade_invoice_time_entries_down.sql`.

## Work orders back end

Merged first (PR 1022, migration `20261012130000`). It patches
`persist_weekly_trade_invoice_v1` in place to carry work order variations
across a draft replacement; `persist_weekly_trade_invoice_v2` here calls v1,
so both hold. This migration is `20261012180000`, after it.
