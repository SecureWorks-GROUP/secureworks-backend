# Crew invoices on the job work order

Owner, 21 Oct 2026. A crew invoice sits on the job's work order. Every
behaviour change is a feature flag seeded off. Applying the migration opens
no work order and retires no row. Screens live in secureworks-ux; this
document is the server contract those screens call.

Schema: `supabase/migrations/20261021143000_job_work_order_crew_invoices.sql`.
Rules: `supabase/functions/ops-api/crew_invoice_job_work_order.ts`.
Office door: `supabase/functions/ops-api/job_work_order_office.ts`.

## Switches

All seven are `feature_flags` rows, missing or unreadable meaning off.

| Flag | Default | What it does |
| --- | --- | --- |
| `job_work_order_all_types_v1` | off | A job of any non-blank type gets a blank job work order when it enters an open status. Fencing and patio are unchanged either way. |
| `job_work_order_active_backfill_v1` | off | Lets `apply_active_job_work_orders(uuid[])` open the reviewed ids. The dry-run preview does not need it. Apply also needs the all-types flag. Preview is open jobs with real activity in 30 days, not `jobs.updated_at`. |
| `job_work_order_office_fill_v1` | off | Office queue, fill and approve. Also lets the backup approver list seal a work order. Off: Shaun only, through the existing `approve_work_order` door, and the new writes refuse everyone including Shaun. |
| `crew_invoice_on_job_work_order_v1` | off | The line trigger stamps `trade_invoice_lines.job_work_order_id` from a draft or an approved job work order. Off: only an approved one is stamped, as today. |
| `crew_invoice_line_office_review_v1` | off | A new crew invoice line starts `office_review_status = awaiting`. Awaiting, queried and rejected hold the whole invoice out of Xero. A historical NULL still syncs. While on, `submit_trade_invoice` is 410. Lines already awaiting stay held if the switch is later turned off. |
| `crew_invoice_requires_job_work_order_v1` | off | Separate hard rule. DEFAULT, owner to confirm: an open job's non-travel line with no job work order is refused before the invoice is saved. Closed jobs and Travel are exempt. A line with no job is not. |
| `retire_crew_work_orders_v1` | off | `create_work_order` refuses any call that is not `kind: 'job'`, except a per-metre assignee's crew work order. Lists hide legacy `kind = 'crew'` rows that have no `quote_builder_version_id`, except that per-metre weekly row. `my_work_orders` returns approved job work orders with the money stripped and drafts left out. Off: today's crew insert and today's lists. |

Turn the review flag on before, or in the same step as, the stamp flag. A
blank work order with the stamp on and review off would sync straight away.

## One work order per job

`jobs_open_job_work_order` still opens a draft when a job enters an open
status. With the all-types flag off, a type other than fencing or patio
still raises and the trigger still swallows that raise. With it on, any
non-blank type opens a blank draft (`origin = 'job_approved'` from the
trigger, `origin = 'manual'` from `create_work_order`, `origin = 'backfill'`
from the script). A null or blank type never opens one.

Quote fill and automatic issue stay fencing and patio only. A blank draft
has no `quote_filled_at`, and filling its allowance stamps `hand_edited_at`,
so the auto-issue cron does not seal it. `agreed_labour_ex` is the labour
allowance. `0` is an explicit none. Null is not a fill.

`create_work_order` with `kind: 'job'` opens that job's work order (the
blank door when the all-types flag is on and the job is not fencing or
patio; otherwise the existing fencing/patio door). Any other kind, and a
missing kind, is a crew work order. While `retire_crew_work_orders_v1` is
on that call returns 409 `crew_work_order_retired`, except when the
assignee's `users.invoice_type` is `per_metre`: that weekly crew work
order is still written, including when `kind` is omitted. A missing
invoice type is still refused:

> Crew work orders are retired. Send kind: 'job' to open the job's work order.

Nothing is written. That covers Secure Suite `sw_create_work_order` and a
cached old page, both of which omit `kind`. While the flag is off the old
insert still runs.

`makeQuoteBuilderWorkOrder` creates `kind = 'crew'` with
`quote_builder_version_id`. That is the same kind decision 10 retires, not a
separate object. While `retire_crew_work_orders_v1` is on, a new one is
refused 409 `crew_work_order_retired` and nothing is written. A version that
already has a work order is still returned. Purchase orders are not refused.
While the flag is off the insert is unchanged. Existing quote-builder rows
stay visible and are not in the retirement script.

## Office queue

Staff only (the ops-api staff set, including the server key for the read).
Fill and approve also need a named approver and the office-fill flag. Shaun
(`approver_user_ids`) is primary either way.
`work_order_settings.backup_approver_user_ids` ships empty. A user in that
list counts only while the office-fill flag is on. There is one `users` row
on `marnin@secureworkswa.com.au`: `706c5258-70dd-483a-b36c-af6864b24498`
(admin). The migration does not write it. Go-live sets
`backup_approver_user_ids` to that id. Shaun still approves from
`approver_user_ids` while the list is empty. That list does not change
`approver_user_ids`, and `work_order_customer_variations` is not widened.
A server key with no user id cannot fill, approve or review. Office approve
calls `approve_job_work_order` with `p_via: 'session'`.

| Action | Method | Body |
| --- | --- | --- |
| `list_office_job_work_orders` | GET | none. Flag off returns `{ enabled: false, work_orders: [] }` and does not query. Flag on returns up to 200 drafts, oldest `updated_at` first, each with `needs_allowance` when `agreed_labour_ex` is null. |
| `fill_job_work_order_allowance` | POST | `work_order_id`, `expected_updated_at`, `agreed_labour_ex` (0 allowed, null refused `allowance_required`). |
| `approve_office_job_work_order` | POST | `work_order_id`, `expected_updated_at`. A non-fencing/patio draft may be approved with an allowance and empty scope while the office flag is on. |
| `review_crew_invoice_line` | POST | `line_id`, `decision` (`approve` / `query` / `reject`), optional `note` (cut at 2000). DEFAULT, owner to confirm: any office role (admin, owner, ops_manager) with a user id. The review flag must be on, unless the line is already awaiting, queried or rejected. The office module does not call Xero. The action pushes when the last line is approved, and returns the invoice to the trade (`ops-reject`) when any line is rejected. |

The queue is the office list of blank and draft job work orders. The job
overview reads `job_detail.job_work_order`, then `job_work_order`. While
`job_work_order_all_types_v1` is off those reads stay fencing and patio, and
`list_work_orders` with a type other than those two is 400 `invalid_type`.
While it is on, every job type is included and a type filter is accepted.
Quote fill stays fencing and patio. A trade JWT on `job_detail` receives the
work order with `agreed_labour_ex` removed and `figures` null. Staff, the
ops key and the routine key keep the figures. The trade's own read remains
`my_job_work_order`, which already omits the allowance. The group-work-order
participant share is not this payload. This repo does not paint the screen.

## Crew invoice lines

The database stamps `trade_invoice_lines.job_work_order_id`. Callers do not
set it, and it is not added to `toTradeInvoiceLineRow`. The stamp is the
job's approved work order, or, while the stamp flag is on, its draft. A
line with no job is not stamped.

`source_work_order_id` and `trade_invoices.work_order_id` stay the
one-invoice-per-crew-work-order fence (`_findBlockingWorkOrderInvoice`,
`can_invoice`, `WEEK_ALREADY_INVOICED`, the assignment lock). A job work
order is never written into either. Travel (`line_type` Travel, no
`source_work_order_id`) stays off that fence. Its `job_work_order_id` is
display and costing only. `isWorkOrderLockLine` still keys on
`source_work_order_id`.

`submit_work_order_invoice` and the weekly block still refuse a job work
order (409 `job_work_order_not_crew_invoice`, or the weekly resolver's
existing 422). Hours are invoiced on the job. `can_invoice` stays false for
a draft or approved job work order, because those statuses are not
`complete` / `sent` / `accepted`.

While the hard-rule flag is on, `generate_trade_invoice` and
`submit_trade_invoice` refuse before they save when a non-travel line names
an open job with no job work order (409 `job_work_order_required`). A closed
job is exempt. Travel is exempt. An unreadable job on a non-travel line is
503 `job_work_order_unreadable`. While the flag is off, every line works
with no work order. DEFAULT, owner to confirm: the open-job and Travel
exemptions.

## Office review before Xero

While the review flag is on, a new line is inserted as `awaiting`, including
travel and a deduction. The status-change linker does not stamp review onto
old lines.

`awaiting` and `queried` hold the whole invoice: 409
`lines_awaiting_office_review`. `rejected` is reported first: 409
`lines_rejected`. NULL does not hold. The hold leaves the invoice at
`pending_acknowledgment`, writes no Xero bill, and returns
`office_review: 'held'` with `success: true` after the finance-review email.
One held or rejected line blocks the invoice; lines are not dropped from the
total.

`push_trade_invoice_to_xero`, `generate_trade_invoice`,
`submit_work_order_invoice` and `submit_trade_invoice` read the saved line
statuses before they ask Xero, whether or not the review flag can be read.
NULL does not hold. A failed flag read does not treat the lines as clear.
When the line read itself fails after the invoice is already saved,
`generate_trade_invoice`, `submit_work_order_invoice` and
`submit_trade_invoice` call `markTradeInvoiceRetryable` and return the
existing `XERO_PUSH_FAILED` shape (`ok: false`, `success: true`, status
`approved`, query note "The office review on this invoice could not be
read. It was saved and was not sent to Xero."). They do not throw 503.
`push_trade_invoice_to_xero` still answers 503 `office_review_unreadable`
on that read, because that invoice is already past save and the push door
is the retry. `submit_work_order_invoice` still throws 503
`office_review_unreadable` only when a held invoice cannot be moved from
`draft` to `pending_acknowledgment`.

While the review flag is on, `submit_trade_invoice` is 410
`submit_trade_invoice_retired` before it writes. A failed flag read does
not 410; the saved-status check still holds a line the trigger stamped
awaiting. `submit_work_order_invoice` saves the local invoice, then moves
it from `draft` to `pending_acknowledgment` and returns
`office_review: 'held'` without calling Xero.

DEFAULT, owner to confirm. When the last held line is approved and none
are rejected, `review_crew_invoice_line` releases the invoice
(`pending_acknowledgment` becomes `approved`; an invoice already
`approved` or `acknowledged` is left on that status) and the action then
pushes it to Xero. The office module itself does not call Xero. A failed
push leaves the invoice approved and retryable. Rejecting any line sets
the invoice to `ops-reject` and does not push. An invoice already in Xero
is 409 `invoice_already_in_xero`. Turning the review flag off later does
not clear a line that is already awaiting, queried or rejected, and does
not release it.

DEFAULT, pending Marnin: the person who submitted the invoice
(`trade_invoices.user_id`) cannot approve, query or reject its crew lines.
That includes a line already held after the review switch is turned off.
The refusal is 403 `self_approval_forbidden`. A null submitter does not
block. Another office reviewer still can.

## What the trade list returns

The trade app does not filter by kind. The server is the list.

While `retire_crew_work_orders_v1` is off, `my_work_orders` still excludes
`kind = 'job'` and the select string is unchanged. While it is on:

- a legacy `kind = 'crew'` row with no `quote_builder_version_id` is left
  out, including one not yet cancelled;
- a quote-builder crew row stays;
- a job work order is returned only when it is not a draft. Rates, totals,
  `quote_cost_ex`, `agreed_labour_ex`, figures and addendum prices are
  removed. `can_invoice` and `can_add_to_weekly_invoice` are false.
  `mode=all` sees an approved job work order by dropping the kind
  exclusion. `mode=mine` also reads non-draft job work orders on jobs where
  the viewer has a genuine, non-ghost, non-cancelled assignment, because a
  job work order has no `assigned_user_id`.

`list_work_orders` (the ops crew list) keeps excluding `kind = 'job'`. With
the flag on it also drops retired crew rows. `submit_work_order_invoice`,
the weekly resolver and `complete_my_job`'s work-order completion skip or
refuse a retired crew row and do not complete a job work order.
`complete_my_job` does not list the job work order in
`invoice_queue.work_orders`.

DEFAULT, pending Marnin: a per-metre trade's weekly crew work order stays
on that path while the retire switch is on. The row is `kind = 'crew'`,
has no `quote_builder_version_id`, and its assignee's `users.invoice_type`
is `per_metre`. It stays on `my_work_orders` and `list_work_orders`, the
weekly resolver still invoices it, `submit_work_order_invoice` still
accepts it, and `complete_my_job` still completes it onto the weekly
queue. `create_work_order` still writes one for that assignee, including
when `kind` is omitted. Quote-builder create does not pass an invoice
type, so it stays refused. An unreadable assignee read is 503
`assignee_invoice_type_unreadable` and does not treat the row as retired.
A missing invoice type is still retired.

`list_trade_invoice_lines` adds `review_state` beside
`office_review_status`: awaiting is `held`, and approved, queried and
rejected keep those words. Null stays null. `job_detail` lists the same
pair on `trade_invoice_lines` (id, line type, description, the two review
fields) and does not put prices on that list. A failed line read leaves
the detail up and sets `trade_invoice_lines_error`.

## Backfill

`scripts/backfill-job-work-orders-active.ts`. Dry-run by default. It is not
imported by a migration.

```
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  deno run --allow-env --allow-net --allow-read \
  scripts/backfill-job-work-orders-active.ts
```

Dry-run prints JSON `{ job_ids, rows, by_type, by_status }`. It writes
nothing. A job qualifies when it is open, has no draft or approved job
work order, and has real activity inside 30 days: an assignment
(`created_at` or `scheduled_date`), a time entry (`work_date` or
`logged_at`), an invoice line (`created_at` or `line_date`), or a status
change (`job_events` `status_changed`, `status_change` or
`job.status_changed`). A recent `jobs.updated_at` with none of those does
not qualify. A processing make-safe with that activity is in the preview.

`--apply` needs `--file`, the reviewed dry-run JSON. It does not select
again. It exits 2 without that file, or when the file has no valid ids,
or unless both `job_work_order_all_types_v1` and
`job_work_order_active_backfill_v1` are on. It then posts those ids to
`apply_active_job_work_orders(uuid[])`. Apply re-checks every id and
opens a draft only when the job is still open, still has activity inside
30 days, has a non-blank type, and still has no draft or approved job
work order. Anything else is skipped and named in `skipped_jobs`:
`not_found`, `blank_type`, `not_open`, `already_has_work_order`,
`no_recent_activity`.

## Retiring the old crew work orders

`scripts/retire-crew-work-orders.ts`. Dry-run by default. Not a migration
and not a cron. It goes on Marnin's go-live checklist. It cancels; it does
not delete. Quote-builder crew rows are not selected.

```
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
  deno run --allow-env --allow-net --allow-read \
  scripts/retire-crew-work-orders.ts
```

Dry-run prints eligible, already cancelled, to retire, sent, with `sent_at`,
open jobs, closed jobs, `kept_per_metre`, and whether
`retire_crew_work_orders_v1` is on. A per-metre assignee's weekly crew
row is counted in `kept_per_metre` and is not cancelled. A failed read of
`users.invoice_type` exits 1 and writes nothing. Audit expectation,
printed and not checked: 34 eligible, 9 sent, 4 open jobs.

`--apply` exits 2 unless that flag is on, then sets `status = 'cancelled'`
in chunks of 25 and re-reads the same ids. The ids it patches are the
plan's `ids` only, so a kept per-metre row is not in that write.

## Rollback

`supabase/rollbacks/20261021143000_job_work_order_crew_invoices_down.sql`
calls `job_work_order_crew_invoice_rollback_guard()` before it restores
anything. The guard raises SQLSTATE `55000`
(`object_not_in_prerequisite_state`) and changes nothing when
`crew_invoice_line_office_review_v1` is on, or when any
`trade_invoice_lines.office_review_status` is `awaiting`, `queried` or
`rejected`. Turn the switch off and move those lines off the hold before
rolling this migration back.

## Go-live

Marnin okays each of these. None of them is this pull request.

1. `scripts/apply-pending-migrations.sh --dry-run` against the live ledger,
   then the migration, before the edge deploy. A version already on the live
   ledger under another name is a collision; renumber, do not alias it.
2. Deploy `ops-api` from `main` after the migration.
3. Turn `crew_invoice_line_office_review_v1` on before or with
   `crew_invoice_on_job_work_order_v1`. Once review is on,
   `submit_trade_invoice` is 410, and `submit_work_order_invoice` and
   `generate_trade_invoice` hold lines until every line is approved. The
   last approval pushes. A rejected line returns the invoice as
   `ops-reject`. Any office staff can review lines. DEFAULT, owner to
   confirm: the reviewer is any office role, the last approval pushes, and
   a rejection returns the invoice. DEFAULT, pending Marnin: the person
   who submitted the invoice cannot review its crew lines (403
   `self_approval_forbidden`). The trade-app toast that says a held
   invoice was submitted to Xero needs a UX change before this switch is
   turned on.
4. Turn `job_work_order_all_types_v1` and
   `job_work_order_office_fill_v1` on. Then
   `job_work_order_active_backfill_v1`. Dry-run the backfill (activity in
   30 days, not `jobs.updated_at`), review the printed ids, then
   `--apply --file` with that file only. Set
   `backup_approver_user_ids` to
   `[706c5258-70dd-483a-b36c-af6864b24498]`, the only `users` row on
   `marnin@secureworkswa.com.au`. The list ships empty. Shaun still
   approves work orders from `approver_user_ids` until that write.
   Once `job_work_order_all_types_v1` is on, readiness "Work order exists"
   passes only for an approved job work order whose `agreed_labour_ex` is
   set, including 0. A blank draft does not pass. While the flag is off the
   check stays `wo_count > 0`.
5. Leave `crew_invoice_requires_job_work_order_v1` off until the backfill
   has been read. DEFAULT, owner to confirm: it refuses only an open job,
   and Travel is exempt.
6. Turn `retire_crew_work_orders_v1` on, dry-run
   `scripts/retire-crew-work-orders.ts`, then `--apply`. That also stops
   quote-builder creating `kind = 'crew'`. `my_work_orders` then returns
   approved job work orders with the money stripped, and leaves drafts out.
   DEFAULT, pending Marnin: a per-metre trade's weekly crew work order
   stays. The dry-run prints `kept_per_metre` and `--apply` does not
   cancel those rows.

## Left open

- Job profit (`v_job_profit`) does not read `agreed_labour_ex`. Supplier
  bills stay unlinked. Patio quotes stay invisible to profit.
- The office queue and the job-overview work order are not drawn in this
  repo. `job_detail.job_work_order` is the overview read. `pipeline`
  `wo_count` still excludes `kind = 'job'`, so a job-only card stays 0 there.
- `trade_job_detail` does not carry the staff job-work-order object.
- Customer variations are not widened to the backup approver.
- The auto-issue cron is on. It does not select a blank make-safe draft.
- An in-flight group-work-order agent (`bc-e920fe91`) also edits ops-api,
  keyed on `(job_id, work_order_id)` with the pot as `agreed_labour_ex` and
  a client sign-off. This change does not build groups. A blank unfilled
  draft has no pot, so a group cannot open on it.
- `my_work_orders` adds `kind` on the card. It is null while the retire flag
  is off, because the column is not selected. The mine-mode assignment read
  filters `is_ghost`, which is live drift and not in a repo migration; that
  read runs only while the retire flag is on.
