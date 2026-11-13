# A trade adds themselves to a job so they can invoice it (v1)

Marnin, 11 Nov 2026: "If they are allocated to a job then they can invoice for
that job. So in the trade app invoicing side if they try invoice for a job they
aren't allocated to they can self allocate there. And then invoice."

## Action

`POST ops-api?action=self_allocate_for_invoice` (trade JWT)

```json
{ "job_id": "<uuid>", "work_date": "YYYY-MM-DD" }
```

Answers `{ ok: true, mode: "created" | "existing", assignment }`, or
`{ ok: false, code, error }` with the status below. Code:
`supabase/functions/ops-api/trade_self_allocation.ts`; tests:
`trade_self_allocation_test.ts`.

## Rules

- Books only the signed-in trade. A `user_id` in the body is never read.
- One day, `work_date`: a real date, not after today (Perth), not more than a
  year back (`self_allocate_date_*`, 400).
- The job must be in the caller's company (`self_allocate_job_not_found`, 404)
  and live work: not a lead, draft, quote, lost, cancelled, deleted, duplicate
  or void job, and not a holding job (`metadata.do_not_schedule`)
  (`self_allocate_job_not_open`, 409). A complete, invoiced or archived job is
  allowed: trades invoice after the job closes.
- An existing live (not cancelled, not ghost) row for that job, trade and day
  is returned as is (`mode: "existing"`); a unique-key race returns the winner.
- The row is written by `createAssignment` (so make-safe cycle binding and the
  ghost watcher mirror run as for any allocation), with
  `suppress_notifications`, the caller as allocator, `confirmation_status`
  confirmed and the note "Added themselves from their invoice". It is then
  moved from `scheduled` to `confirmed` with `acknowledged_at` (best effort).
- A `trade_self_allocated` job event records the assignment, day and trade.

## What it unlocks, and what it does not

Being booked on the job is the invoice's `booked_on_job` rule
(`trade_invoice_extra_job_authority.ts`), so the refused invoice goes through
on the next send. It never allows a commission line: commission is only for a
job the trade created, manages, or holds the invoice-any-job grant for
(`commission_not_allowed`, `docs/trade-invoice-mode-v1.md`).

The action is on `OPS_API_PROFILE_SCOPED_JWT_ACTIONS` (11 Nov 2026): without
it the front door refused every plain trade with `operator_access_required`
before the route ran. The office still reviews every invoice as before; rates and
time entry rules are unchanged.

It also gives the trade the allocated tier on that job in the Trade App
(everything except the quote), as any allocation does. That is the accepted
cost of the owner's rule; the job event and the assignment note are how the
office sees who added themselves. To narrow it, change the job rule here.

## The app

The trade app asks only after `generate_trade_invoice` refuses with
`extra_job_not_allowed` (403, nothing saved), once per refused job and day
worked, then sends again (`secureworks-ux` `trade.html`,
`// <invoice-self-allocate>`).

## Clock off times (same change, no new action)

The trade app now asks about a break at clock off and saves the confirmed
start, finish and break with `log_my_job_hours` (`source: "clock_off"`), into
`job_assignment_logged_times`. `my_hours` already returns them as
`logged_time_entry`, and the Weekly Invoice card opens on them for the trade to
check (see `docs/trade-invoice-time-entries-2026-10-12.md`, "Times saved on the
job view"). The server never copies them onto a line itself.

## Addendum (2026-11-13): booking ahead is a separate door

Owner's word (Marnin, 13 Nov 2026): a trade may add themselves to a job for
today or a future day, and take that booking off again. That is `self_book_job`
and `self_unbook_job`, behind `feature_flags.trade_self_booking_v1` (seeded
off). `self_allocate_for_invoice` above is unchanged: it stays the door for a
day already worked and still refuses a day after today. Contract, and what a
booking ahead sets off: `docs/trade-open-access-v1.md`.
