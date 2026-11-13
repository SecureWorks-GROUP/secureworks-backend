# Scheduled-job reminder texts (v1)

Captain, 13 Nov 2026: a job in Scheduled gets an automatic text every 7 days
while its first work day is still ahead, and one the day before. The wording is
fixed and the same for every fencing, patio and repair job, except that a
repair's text says "your repair" where the others say "your install".

Code: `supabase/functions/ops-api/job_schedule_reminders.ts` (rules, reads,
writes) and its test. Migration: `20261113120000_job_schedule_reminders.sql`;
apply it before the matching ops-api.

## When a text goes

At 12:00 Perth every day, weekends included (pg_cron `job-schedule-reminders`,
`0 4 * * *` UTC), ops-api `job_schedule_reminder_sweep` reads every job in
Scheduled:

- fencing and patio at `jobs.status = 'scheduled'`; a repair (the Repairs board
  family) at board stage `scheduled`. Make-safe and restoration cards are never
  texted. The lane rule is `job_auto_start.ts` `autoStartLane`.
- The first work day is the job's earliest crew work booking on or after today
  (`job_auto_start.ts` `isWorkBooking`: install bookings, no ghost watcher rows,
  no cancelled rows). A job still in Scheduled has not started, so a booking
  before today is a stale one left on the calendar and is ignored.
- `d` = calendar days from today to that day. `d = 1` sends the day-before text.
  `d = 7, 14, 21 ...` sends the weekly text. Any other day sends nothing, and a
  job with no work booking from today on gets nothing (`no_work_booking`).

A job starting 27 Nov is texted on 13, 20 and 26 Nov; one starting 23 Nov on
16 and 22 Nov; one starting 18 Nov on 17 Nov.

## When it is held

Each held text is recorded with its reason (`skipped_<reason>`):

- `booking_changed_today`: a crew booking on the job was made, changed,
  cancelled or removed today (Perth). The booked-in or reschedule text covers
  the day. A ghost watcher mirror's booking event (`source`
  `ghost_auto_mirror`) is not a booking change.
- `reschedule_text_today`: an `install_rescheduled` text went today.
- `similar_prior`: an outbound text to that contact (`business_events`
  `client.sms_out` / `sms_sent`, hand-sent or tool-sent) or a text on the job
  (`job_events` `sms_sent`) went since the previous reminder slot. The weekly
  text looks back 6 days and the day-before text looks at today. A text counts
  as similar when it names the work day's date or weekday, or uses booking or
  reminder words: on track, reminder, remind, booked, booking, coming in,
  tomorrow, scheduled. A reminder this sweep sent the same contact for another
  job (a `sent` or `unconfirmed` `job_schedule_reminders` row of that job,
  matched by GHL message id or by the same words) is not a repeat and does not
  count.
- `contact_shared` (repairs only, flagged on the job event): the job's contact
  sits on other clients' jobs (a builder's or agent's number), by the job
  story's `contact_shared` test (`context_job_story_meta`).
- `*_unreadable`: a check could not be read, so nothing was risked.

A recipient with no GHL contact is `no_contact`.

## Who gets it

Every paying party (a shared fence's neighbour too), once per GHL contact; a
party with no GHL contact is recorded `no_contact`. With no paying party rows it
goes to the job's client.
`job_closeout.ts` `reviewRecipients` decides this. It is sent through ghl-proxy
`send_sms` with `jobId`, so the shared sender and contact guard apply.

## Once, and what it records

`job_schedule_reminders` holds one row per job, recipient and Perth day. The row
is claimed by insert before the send. Outcomes:

- `sent`;
- `refused`: a 4xx, so nothing went;
- `unconfirmed`: it may have reached GHL, and it is never retried;
- `no_contact`;
- `skipped_<reason>`.

A row left at `claimed` means the run stopped before it wrote the outcome. It is
never retried.

Each outcome writes one `schedule_reminder` job event. A sent or failed text also
writes an `email_events` row under comms trigger `schedule_reminder`.
`job_schedule_reminder_runs` keeps one row per run.

## The switch

`job_closeout_settings.schedule_reminder_mode` is `off` or `live`. It ships
`off`, and missing or unreadable reads as off. The cron caller and ops-api both
read it. Turn it on:

```sql
UPDATE public.job_closeout_settings SET schedule_reminder_mode = 'live', updated_by = '<who>', updated_at = now() WHERE id = 1;
```

Turn it off the same way with `'off'`. A POST to the action without
`dry_run: false` sends and writes nothing, and answers what it would send. That
lets someone check one day's list by hand; it is not a mode.
