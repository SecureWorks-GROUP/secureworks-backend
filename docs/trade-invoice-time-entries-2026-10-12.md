# Trade invoice time entries (12 Oct 2026)

Owner's ask, 12 Oct 2026: a trade invoicing SecureWorks Group for hours must
enter the date worked and a start and finish time, and that is stamped against
the job, so inconsistencies show and a job's story can be pieced together.

This is the back end. The trade app screens are a paired change in
`secureworks-ux`.

- Rule owner: `supabase/functions/ops-api/trade_invoice_time_entry.ts`
- Migration: `supabase/migrations/20261012110000_trade_invoice_time_entries.sql`
- Tests: `supabase/functions/ops-api/trade_invoice_time_entry_test.ts`,
  `supabase/tests/migration-contracts/20261012110000_trade_invoice_time_entries/`

## The contract

Every invoice line that bills a trade's time carries:

| Field | Form | Notes |
| --- | --- | --- |
| `work_date` | `YYYY-MM-DD` | The Perth calendar day worked |
| `start_time` | `HH:MM`, 24-hour | Perth local time |
| `finish_time` | `HH:MM`, 24-hour | After `start_time` on the same `work_date` |
| `break_minutes` | whole minutes | Optional, default 0 |

- Hours are `(finish_time - start_time) - break_minutes`, rounded to 2 decimal
  places. The server computes and stores them. A client hours figure more than
  0.01 away is refused.
- One line is one job on one day. Two days on a job is two lines. A shift
  across midnight is two lines.
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
| `time_entry_required` | a time line has some but not all three | refused | refused |
| `time_entry_finish_before_start` | finish is not after start | refused | refused |
| `time_entry_hours_mismatch` | client hours differ from the computed hours by more than 0.01 | refused | refused |
| `time_entry_invalid` | a malformed date, time or break, or a break as long as the shift | refused | refused |
| `time_entry_overlap` | two lines for the same job card overlap on one day | refused | refused |

### What every read returns

Each invoice line carries `work_date`, `start_time`, `finish_time` and
`break_minutes` (all null when the line has no entry): `get_trade_invoice`,
`my_invoices`, `generate_trade_invoice`'s returned invoice,
`list_trade_invoice_lines`, `list_trade_invoices` and
`crew_charges_on_my_jobs`. `start_time` and `finish_time` are stored as text
`HH:MM`, so every read answers the contract form as it stands.

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
| 3 | `generate_trade_invoice` | auto-collected clock lane (no job cards sent) | direct insert | the clock's own on and off stamps |
| 4 | `save_trade_invoice_draft` | no week | direct insert | the request, stored as sent |
| 5 | `save_trade_invoice_draft` | dated week | `persist_weekly_trade_invoice_v2` | the request, stored as sent |
| 6 | `submit_trade_invoice` | legacy hourly lane | direct insert | the assignment's started and completed stamps |

Not time lines, unchanged: the weekly work-order invoice (`work_order_blocks`:
priced scope lines, crew deductions and `labour_deduction` lines),
`submit_work_order_invoice`, the per-metre lane of `submit_trade_invoice`, and
work order, commission, materials, travel, equipment and other extras
(including the named crew `wo_labour_lines` inside a work order line).
`review_crew_charge` and `acknowledge_invoice_line` change a saved line's
review fields only. `log_my_job_hours` writes hours on the job card, not an
invoice line, and is unchanged.

### Decisions worth knowing

- **Drafts are never refused.** A draft is a working copy: each field is kept
  when well formed and dropped when not, a half-filled entry is kept, and a
  complete entry sets the line's hours. Submit is where an entry is required
  and checked. Drafts are also not in a job's list.
- **Auto-collected lanes (3 and 6) take the system's own record.** Nobody types
  on those lanes, so the entry is the clock's stamps (lane 3) or the
  assignment's started and completed stamps (lane 6), read in Perth time. The
  billed hours do not move. While the flag is off the lines group per job as
  before, and a line that is one card says when it was worked. When the flag is
  on, each card is its own line; a card whose stamps are not one same-day shift
  is refused `time_entry_required`, and the trade enters it on the job card
  instead.
- **Existing invoices and drafts are untouched.** No backfill, no invented
  times. Their four fields stay null.
- **The Xero bill is unchanged in wording.** A job card with an entry is one
  bill line per day rather than one per job, with the same rate.

## Stamped against the job

View `public.job_trade_time_entries` is the list: one row per submitted time
line that says when it was worked.

| Column | Meaning |
| --- | --- |
| `job_id`, `job_number` | the job |
| `user_id`, `user_name` | who |
| `work_date`, `start_time`, `finish_time`, `break_minutes` | which day, from when to when (Perth) |
| `started_at`, `finished_at` | the same two instants as `timestamptz` |
| `hours` | the hours the line billed |
| `trade_invoice_id`, `invoice_number`, `invoice_status`, `submitted_at` | which invoice |
| `trade_invoice_line_id`, `line_type` | the line |

Drafts are left out. A rejected invoice (`ops-reject`) stays in, with its
status, because it is still what the trade claimed.

Ops reads it through the job detail read it already uses:
`ops-api?action=job_detail` now returns `trade_time_entries` (the list, by day
then start) and `trade_time_entries_error`. A failed read answers
`trade_time_entries: null` with the reason, never an empty list.

### Hand-off for the CIO desk (context system)

Nothing in the context system's functions was changed. The job record can pick
the entries up from `public.job_trade_time_entries` by `job_id`: it is a plain
view, `security_invoker`, readable by the service role only. `started_at` and
`finished_at` are ready-made instants for a timeline; `invoice_status` tells a
live claim from a rejected one. Rows exist only for invoices submitted after
this change with the fields sent.

## Rollout order

1. Merge this change. The migration applies before the edge deploy.
2. The trade app screens go live (paired change in `secureworks-ux`).
3. On the owner's word, firstmate sets the flag on.

Rollback keeps the recorded times: see
`supabase/rollbacks/20261012110000_trade_invoice_time_entries_down.sql`.

## Work orders back end (branch `fm/work-orders-backend-20261006`)

That branch is not merged and edits the same file. It does not touch the
invoice persist functions; expect textual conflicts only where both append:
the end of `scripts/edge-function-schema-requirements.txt`, the version list
in `scripts/test/test-edge-schema-preflight.sh`, and the `jobDetail` return in
`ops-api/index.ts`. Keep both sides. Its migration is `20261012090000`; this
one is `20261012110000`.
