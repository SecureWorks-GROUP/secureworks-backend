# Trades' app open access (v1)

Marnin, 13 Nov 2026, three rulings for the trades' app:

1. Any trade may find and open any job in the company, read only: the address,
   the scope of works, the notes, the photos and who is on it. Prices stay
   hidden. The customer's phone number shows only once the trade is on the job.
2. A trade may add themselves to any job for today or a future day from the job
   page. It shows on the office calendar and nobody is texted. They can then
   clock on and invoice it.
3. A trade may change their hourly rate on a job line of their invoice, and the
   office sees the changed rate flagged.

These reverse part of the 24 Sep 2026 visibility ruling
(`docs/trade-all-means-all-v1.md`) and widen the 11 Nov 2026 self-allocation
rule (`docs/trade-self-allocation-v1.md`). Each ships behind its own switch.

## The three switches

Rows in `feature_flags`, seeded OFF by
`20261113090000_trade_open_access_flags.sql`. A missing or unreadable row is
off. With a switch off, ops-api answers exactly as it did before this change.
Code: `supabase/functions/ops-api/trade_open_access.ts`.

| Switch | Turns on |
| --- | --- |
| `trade_company_job_view_v1` | the read-only company view (section 1) |
| `trade_self_booking_v1` | `self_book_job` and `self_unbook_job` (section 2) |
| `trade_rate_editable_v1` | a typed rate on a job card (section 3) |

## 1. Company view: `trade_company_job_view_v1`

### The tier

`resolveTradeJobAccessTier` gains one tier, `company_view`
(`quoteVisible: false`, reason `company_view`). A trade gets it when all of
these hold:

- the switch is on;
- the door asked for it (`allowCompanyView: true`);
- they would otherwise be refused as not on the job;
- the job is in their own company (another company's job stays
  `tenant_mismatch`);
- the job passes the self-allocation job rule (`selfAllocationJobRefusal`): not
  a lead, new, draft, quoted, lost, cancelled, deleted, duplicate or void job,
  and not a holding job. A finished job can be opened.

Being on the job, managing its division or seeing everything still wins.

### Which doors

Only three reads ask for the tier: `trade_job_detail`, `my_job_work_order` and
`trade_quote_extract`. No other door passes `allowCompanyView`, so every other
door (notes, photos, reports, alerts, variations, hours, completing the job,
the labour budget, the service report read) still refuses a trade who is not on
the job with the same answer as before, and never reads the switch.

### What `trade_job_detail` returns for `company_view`

`access_tier` is `company_view` and `quote_visible` is false. Everything the
allocated tier's redaction removes is removed (prices, quote and invoice PDFs,
priced work order lines, make-safe billing notes). In addition:

- No customer contact. Every key that names a phone, an email or the CRM
  contact is removed at every depth (`job.client_phone`, `job.client_email`,
  `job.ghl_contact_id`, the customer on quote packs, the site contact on
  make-safe details, the client block in `scope_json`). The customer's name
  and the site address stay.
- A phone number or email typed into free text is replaced with
  `[phone hidden]` or `[email hidden]`. This is best effort: it matches
  Australian mobile and area-code numbers and email addresses. A bare
  eight-digit landline is not matched. Ids, references, dates, links, file
  paths and inline files are never rewritten.
- `crew[]` is `{ id, user_id, name, scheduled_date, status, is_lead }` only: no
  phone, no hours, no clock stamps, and no watcher (ghost) rows.
- `serviceReport` is null and `serviceReports` is empty.

Notes, photos, documents (allocated rule), purchase orders, the work order
(allocated redaction), quote packs (allocated redaction) and the scope summary
stay. The read still does its two housekeeping writes (scope media promotion
and the late quote freeze), as it does for every tier.

`my_job_work_order` answers the approved work order without prices, with
`can_report_variation: false`. `trade_quote_extract` answers the price-free
extract with the customer's phone and email null.

### `search_all_jobs`

With the switch on, a plain trade (no see-everything, no managed division)
gets the whole company:

- the same allocated-safe row as before (no notes, no metadata, no money);
- paged as the company lens pages; `lens` is `company` (or `search` when `q`
  is typed);
- every row carries `assigned_to_me` (true when the trade holds a live,
  non-ghost booking on the job);
- the customer's phone and email are removed from rows where `assigned_to_me`
  is false.

The statuses left out are the same as before (deleted, duplicate, void,
draft). So a quoted, lost or cancelled job can be found but not opened. A
manager's or a see-everything viewer's search is unchanged and carries no
`assigned_to_me`.

## 2. Booking yourself: `trade_self_booking_v1`

Code: `trade_self_allocation.ts`. Both actions are POST, trade sign-in, and
answer 409 `self_booking_disabled` while the switch is off.
`self_allocate_for_invoice` (a day already worked) is unchanged.

### `self_book_job`

```json
{ "job_id": "<uuid>", "dates": ["YYYY-MM-DD", "..."] }
```

A single `work_date` is accepted in place of `dates`. Answers:

```json
{ "ok": true, "bookings": [ { "work_date": "YYYY-MM-DD", "mode": "created", "assignment": {} } ] }
```

`mode` is `created`, `existing` (the trade already holds that day) or
`revived` (a cancelled, unused booking of theirs for that day was brought
back). Refusals are `{ ok: false, code, error }`; a refusal after some days
were booked also lists them in `bookings`.

| Code | Status | When |
| --- | --- | --- |
| `self_booking_disabled` | 409 | the switch is off |
| `self_book_job_required` | 400 | no job |
| `self_book_dates_required` | 400 | no day |
| `self_book_too_many_dates` | 400 | more than 14 different days |
| `self_book_date_invalid` | 400 | not a real date |
| `self_book_past_date` | 400 | before today (Perth); the invoice door is for those |
| `self_book_date_too_far` | 400 | more than 60 days ahead |
| `self_book_job_not_found` | 404 | not in the trade's company |
| `self_book_job_not_open` | 409 | see the job rule |
| `self_book_conflict` | 409 | a record of theirs already holds that day and cannot be reused |

Rules:

- Books only the signed-in trade. A user id in the body is never read.
- Job rule: everything the invoice door refuses, and also a finished or closed
  job: the statuses `allocate_job` refuses (cancelled, archived, lost,
  deleted, complete, completed, invoiced, paid, closed, duplicate, void) plus
  `final_payment` and `get_review`.
- Every day is checked before the first write.
- One row per job, person and day is the database's key, cancelled rows
  included. A cancelled row of the trade's that was never started, worked or
  invoiced is brought back in place. One that was is refused
  (`self_book_conflict`). A watcher's own ghost row on the key is released
  first, as for any allocation.
- The row is written by `createAssignment`, exactly as the invoice door writes
  one: an ordinary `install` booking, confirmed, no text to anyone, the note
  "Added themselves in the app", then a `trade_self_allocated` job event with
  `reason: "planned"`.

### `self_unbook_job`

```json
{ "assignment_id": "<uuid>" }
```

Answers `{ ok: true, assignment_id, job_id, work_date }`. The booking is
removed through the office's own removal (`deleteAssignment`), so the watcher
rows follow, and a `trade_self_unbooked` job event is written.

| Code | Status | When |
| --- | --- | --- |
| `self_booking_disabled` | 409 | the switch is off |
| `self_unbook_assignment_required` | 400 | no booking named |
| `self_unbook_not_found` | 404 | not the trade's own booking |
| `self_unbook_not_self_made` | 403 | no `trade_self_allocated` event of theirs names it: the office made it |
| `self_unbook_started` | 409 | clocked on, started, or not `scheduled` / `confirmed` |
| `self_unbook_invoiced` | 409 | it is on an invoice |
| `self_unbook_past` | 409 | dated before today |

A plain trade still cannot use `update_assignment` or `delete_assignment`.

### What a self-booking sets off

A self-booking is a real crew booking, so everything a booking sets off
happens. The owner should know each of these before the switch goes on.

- The job shows on the office calendar as real crew, and Shaun (every job) and
  Nithin (patio) get their watcher rows for that day.
- A job at `accepted` moves to `processing`.
- The CRM opportunity's schedule fields are set to that day
  (`scheduled_date`, `schedule_status: scheduled`).
- On a Scope Engine job the database records an `install_scheduled` payment
  signal. Payment stages that start at install are drafted, held
  (`work_or_material_evidence_required`), with their due date counted from the
  moment of the booking. The first install booking on a job sets that; a later
  one does not move it.
- At 6am on the booked day, a job at `scheduled` moves to `in_progress`
  (`job_auto_start_v1`). On a repair, the Repairs stage moves to on site.
- The trade gets the allocated tier on the job: the customer's phone, notes,
  photos, reports, the labour budget (which shows every crew member's rate),
  and the right to mark the job complete.
- On a make-safe the trade is bound to the current attendance and may file
  the final report, which cancels the other trades' bookings on that
  attendance.
- Clocking on is still held by the deposit gate on fencing and patio jobs.
- The booking is a card on that week's invoice. It does not make a patio or
  group job billable by hours.

Taking the booking off removes the row and the watcher rows. It does not move
the job back from `processing`, clear the CRM date or undo the payment signal.

## 3. A typed rate: `trade_rate_editable_v1`

The trade app (`secureworks-ux` `trade-app.md`, "Rate and description") posts
`rate` on every job card in `manual_assignments` and says in `rate_source`
whether the trade changed it.

- `my_hours` answers `trade_rate_editable: true` while the switch is on. The
  key is absent while it is off.
- `generate_trade_invoice`, switch on: a card with `rate_source:
  "client_entered"` and a positive `rate` that differs from the trade's office
  rate is priced at that rate. The line's note reads "Client-entered rate: $X/hr.
  Ops must verify before approval." and the invoice counts it as a
  client-priced line, as a typed rate on an extras line does.
- Held or not (`jobCardTypedRateHold`):
  - at or below the trade's own office rate: never held;
  - above it: the extras limit decides (the office's `labour` row in
    `trade_invoice_extra_rate_rules`, else its `*` row, else the trade's own
    rate). Over the limit the line is `office_review_status = 'awaiting'`, the
    invoice is saved and kept out of Xero (`office_review: "held"`), and an
    `extra_rate_held` invoice event is written;
  - the limits could not be read: held;
  - the trade has no office rate: always held.
- A card posted `server_resolved`, or with a missing, zero or invalid rate, is
  billed at the office rate as before.
- No office rate on file: the invoice is still refused `RATE_NOT_CONFIGURED`
  unless every card carries a typed rate; then it is accepted and every line
  is held.
- Two cards on one job at different rates are two lines.
- The saved weekly draft keeps the card's `rate` and `typed_rate` as posted.
- Switch off: the rate on a card is ignored. The switch is read only when a
  card carries a typed rate.

## Turning them on

1. Apply the migration (it applies itself on merge) and deploy ops-api. Nothing
   changes.
2. `trade_rate_editable_v1` first. It changes money only through the office's
   own review, and the trade app's rate box is already built for it.
3. `trade_company_job_view_v1` next. It is read only.
4. `trade_self_booking_v1` last, once the owner has read "What a self-booking
   sets off". Without the company view a trade cannot find a job they are not
   on, so this one is of little use alone.

To switch one off, set `enabled = false`. Bookings already made stay.

## Tests

`trade_company_view_test.ts`, `trade_self_booking_test.ts`,
`trade_rate_editable_test.ts`, and one case in
`trade_invoice_running_draft_test.ts`.
