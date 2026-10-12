# Job work orders v1

Captain, 6 Oct 2026: every fencing and patio job has one work order, draft then
approved by Shaun. Approved is sealed like an invoice. Trade labour billed on the
job shows against it live, and a trade can report a variation on their invoice,
which emails finance and, separately, admin.

Code: `supabase/functions/ops-api/job_work_orders.ts`. Schema, seal, triggers,
backfill: `supabase/migrations/20261012090000_job_work_orders.sql` (contract
`supabase/tests/migration-contracts/20261012090000_job_work_orders/`).

## Model

- A job work order is a `work_orders` row with `kind = 'job'`. Every older row
  is `kind = 'crew'` (the per-trade crew-pay work order) and behaves as before.
  Crew-pay invoicing (`my_work_orders`, `submit_work_order_invoice`, weekly
  blocks) only ever reads `kind = 'crew'`.
- Status `draft` (editable, counts for nothing) or `approved` (sealed). There
  is no cancelled state. One work order per job: a draft, then that same row
  approved, enforced by unique index `uq_work_orders_job_current`.
- The `job_events` rows this module writes (draft opened or updated, approved,
  variation reported) carry ids only: never the agreed labour, a variation
  amount or the sealed hash. `job_events` is readable by any signed-in user of
  the org, trades included, and the hash could be used to guess the agreed
  figure. The figures live on the work order row, which trades cannot read.
- The staff crew work order readers (`job_detail.work_orders`, the old
  `list_work_orders`, the dossier, the invoice context, `reporting-api`) leave
  the job work order out; it is read through `job_work_order`, `list_work_orders`
  with `kind=job`, and `job_detail.job_work_order`. Known
  follow-up: the context job record SQL (`20261011130000`) still lists it as a
  work order line in the job story.
- `jobs.work_order_id` points at the job's work order (the draft, then the
  approved one).
- Approved rows are sealed by trigger `trg_work_orders_job_kind_guard`: no
  field can change and the row cannot be deleted. There is no revision: later
  change is recorded as a variation.
- `agreed_labour_ex` is the labour we allowed and agreed (ex GST). Approving
  needs it set and some scope (scope items or special instructions). The
  trigger stamps `sealed_content_hash` (sha256 of the sealed content).

## Who approves (Shaun only)

`work_order_settings.approver_user_ids`, seeded with Shaun's `users.id`
(`9913309f-35ae-4a71-8e1f-f704ecc526ea`, shaun@secureworkswa.com.au), the same
pattern as `debt_desk_settings`. Never a role: six users hold `ops_manager`.
Checked in `approveJobWorkOrder` and again in the database trigger.

The approver is identified as:

- `session`: a signed-in staff JWT (Ops dashboard). Works on merge.
- `terminal`: a server-secret call (SecureSuite) carrying the header
  `x-sw-actor: user:<users.id>`. The shared browser key never counts.

Terminal approval is OFF: feature flag `work_order_terminal_approval_v1` is
seeded false. The `x-sw-actor` header is self-declared by whoever holds a server
secret, so it does not prove the caller is Shaun. Whether that is enough for
"approved and signed off by Shaun" is the owner's ruling, not decided here.
While the flag is off, a terminal approval is refused 403
`terminal_approval_switched_off` and Shaun approves from his signed-in session.

## Labour billed against it

Trigger `trg_trade_invoice_lines_link_job_work_order` stamps
`trade_invoice_lines.job_work_order_id` with the job's approved work order
when the line's invoice is submitted (any status except `draft` and
`ops-reject`); `trg_trade_invoices_link_job_work_orders` does the same when a
draft invoice is submitted later. Every submit path is covered because the
database does it. Every line billed on the job is stamped, whatever its type.

Only labour counts against the agreed labour. Which lines are labour is the
repo's one definition, `v_trade_charge_resolved.cost_lane` (`20260831021701`):
this module reads the lane per line and never restates it. Billed to date,
remaining, the over agreed and near agreed rules, and each invoice's amount
count labour lines only. Materials, travel, equipment, commission and
other lines stay in the work order's `lines[]` with their `cost_lane` and
`counted: false`. Example: agreed 2,000, billed 1,900 labour and 400 materials
reads billed 1,900, remaining 100, not over.

Temporary exception, in one place (`workOrderLineIsLabour` in
`job_work_orders.ts`): the trade app's "Work Order" pay line (`line_type`
`work order` or `work_order`) is labour and counts, although the shared view
does not classify it yet and gives it `cost_lane: unclassified`. A job billed
as one 2,000 Work Order line against an agreed 2,000 reads billed 2,000,
remaining 0. The shared view is left alone in this change because it also
feeds the job costing reports; that is the finance desk's change. When the
view puts those two types in its labour lane, remove the line-type test.

Lines invoiced before the work order is approved (a backfilled job already mid
install, or a trade who invoices before Shaun approves) are linked by
`approve_job_work_order` in the same transaction as the approval, along with any
variation already reported on the job. So billed to date, remaining and the
over agreed rule count all labour on the job. Until then labour is unlinked
and shown as `labour_before_approval`.

## Running figures and rules

`figures` on every read of an approved work order:

| field | meaning |
| --- | --- |
| `agreed_ex` | sealed agreed labour |
| `billed_to_date_ex` | labour lines (labour lane, plus Work Order pay lines for now) on billed invoices, stamped against this job's approved work order (variation work included) |
| `variations_ex` | the part of billed the trades marked as variations. A variation counts only while its trade invoice is billed (not draft, not `ops-reject`), the same rule as labour lines |
| `billed_within_agreed_scope_ex` | billed minus variations |
| `remaining_ex` | agreed minus billed |
| `used_ratio` | billed / agreed |
| `over_agreed` | true when billed (within scope plus variations) is over agreed |

Rules (`figures.rules[]`, each `{key, level, message}`):

- `over_agreed` (flag): billed is over the agreed labour.
- `near_agreed` (warn): billed is 90% or more of agreed, and not over.
- `has_variations` (info): one or more variations reported.
- `no_approved_work_order` (info): nothing counts until a work order is approved.

## Variations and emails

`report_work_order_variation` records one `work_order_variations` row per
trade invoice per job, against the approved work order (or none: kept, and
linked when the work order is approved). It writes two rows in `work_order_variation_emails`: one to
finance@secureworkswa.com.au and a separate one to admin@secureworkswa.com.au,
sent from admin@ through `send-outlook-email`. Addresses: secureworks-wiki
`harness/ops/sops/make-safe-ops-agent-sop.md` lines 134 and 137.

A trade usually raises the variation while the invoice is still a draft, and
saving or submitting an invoice deletes the draft row and inserts a new one.
The variation is not lost with it: `carry_work_order_variations(prior,
replacement)` moves it to the replacing invoice row inside the same
transaction, in all three draft-replacing functions
(`replace_trade_invoice_draft_v1`, `persist_weekly_trade_invoice_v1`,
`persist_trade_work_order_invoice_v1`; this migration inserts the one call into
their deployed bodies and its rollback removes it). The variation keeps its id,
its work order and its email rows, so nothing is emailed twice. It moves only
when the replacing invoice still bills that job; otherwise, and when an invoice
is deleted outright, it goes with the invoice. A later migration that replaces
one of those three bodies must keep the call.

Sending is OFF: feature flag `work_order_variation_emails_v1` is seeded false.
While off, rows stay `recorded` and nothing below sends. Turning it on needs the
captain's word. The transport is built but has never sent a live email.

Each email is sent at most once per claim: a row is claimed (`sending`, with
`sending_started_at`) by a compare-and-set before the send, then marked `sent`
or `failed`. Recovery, with no scheduler:

- A retry of the same report (`duplicate: true`) records any missing row and
  sends what that variation still owes (`recorded`, `failed`, or `sending` for
  more than 10 minutes). Rows already `sent` or in flight are left alone.
- `resend_work_order_variation_emails` (staff, POST, no input) re-sends up to
  100 rows left `failed`, or stuck in `sending` for more than 10 minutes. It
  never sends a `recorded` row, so variations reported while the flag was off
  are not sent as a backlog. Safe to call again.

## Backfill (OFF)

`backfill_job_work_orders` (ops server key only) calls
`backfill_job_work_order_drafts(p_apply)`. It is a dry run unless `apply: true`
AND feature flag `job_work_order_backfill_v1` is on (seeded false). It opens a
draft for every fencing or patio job in an open approved status
(`job_work_order_open_statuses()`) with no job work order. Closed jobs are left
alone. Future jobs get their draft from trigger `trg_jobs_open_job_work_order`
when they enter an open approved status.

## API for the screens

All on `ops-api`. Staff = ops server key, or a signed-in admin/owner/ops_manager.
Errors are `{error, code}`.

| action | method | who | input | output |
| --- | --- | --- | --- | --- |
| `job_work_order` | GET | staff | `job_id` or `work_order_id` | `{schema:"job-work-order.v1", job, eligible, work_order, live_work_order, draft_work_order, figures, invoices[], lines[] (each with `cost_lane` and `counted`), labour_before_approval, variations[]}` |
| `list_work_orders` | GET | staff | `kind=job`, optional `status` (draft, approved), `type` (fencing, patio), `job_id` | `{schema:"job-work-orders.v1", work_orders[] (row + job_number, client_name, job_type, job_status, site_suburb, figures for approved ones), total}`. Without `kind=job` the old list, crew work orders only: a job work order is never in it. |
| `create_work_order` | POST | staff | `{kind:"job", job_id, ...draft fields}` | `{created, work_order}`: the open draft, else a new draft; 409 `work_order_sealed` once the job's work order is approved |
| `update_work_order` | POST | staff | `{id, scope_items?, special_instructions?, agreed_labour_ex?, scheduled_date?, site_address?}` | `{work_order}`; approved returns 409 `work_order_sealed`; a `status` other than `draft` returns 400 `invalid_status` |
| `approve_work_order` | POST | Shaun (session; terminal only while its flag is on) | `{work_order_id, expected_updated_at?}` | `{work_order}`; 403 `approver_required` / `approver_identity_missing` / `terminal_approval_switched_off`, 422 `work_order_not_ready`, 409 `not_a_draft` / `stale_review` |
| `backfill_job_work_orders` | POST | ops server key | `{apply?: true}` | `{dry_run, candidates, by_type_status, job_ids, opened}` |
| `resend_work_order_variation_emails` | POST | staff | none | `{sending_on, emails:[{id, variation_id, recipient_role, status}]}`; `sending_on:false` and no sends while the email flag is off |
| `send_work_order` | POST | staff | job work order id | 409 `job_work_order_not_sendable` |
| `job_detail` | GET | unchanged | | adds `job_work_order: {work_order, live_work_order_id, draft_work_order_id, figures, invoice_count, variation_count}` on fencing and patio jobs |
| `my_job_work_order` | GET | trade with access to the job | `job_id` | `{schema:"trade-job-work-order.v1", work_order: {id, wo_number, status, approved_at, job_id, job_number, job_type, site_address, scheduled_date, scope_items, special_instructions} or null, reason, can_report_variation, my_variations[]}`. No price, allowance, agreed amount or figure, ever. |
| `report_work_order_variation` | POST | trade, own invoice, access to the job | `{trade_invoice_id, job_id, description, amount_ex?}` | `{variation, duplicate, emails:[{recipient_role, status}]}` |

Work order row fields: `id, job_id, wo_number, kind, status, scope_items,
special_instructions, scheduled_date, site_address, agreed_labour_ex,
approved_at, approved_by, approved_via, sealed_content_hash, origin,
created_at, updated_at`.

Inputs are the snake_case names in this table only. There are no camelCase or
alternate id spellings on these doors.

Trade invoice flow: the trade allocates and invoices as before. After the
invoice is created, show `my_job_work_order` for each job on it, then a "Any
variations to the work order?" choice; on yes, call
`report_work_order_variation` with that invoice id.

## Terminal (SecureSuite)

The MCP tools live in `secureworks-jarvis` (`src/mcp-server.ts`), not here.
Mapping: `sw_list_work_orders` -> `list_work_orders?kind=job`,
`sw_create_work_order` -> `create_work_order {kind:"job"}`,
`sw_update_work_order` -> `update_work_order`, a view tool -> `job_work_order`,
and a new approve tool -> `approve_work_order`. Drafting and editing work from
the terminal on merge. Approving from the terminal needs two things: the owner's
ruling that turns on `work_order_terminal_approval_v1` (see "Who approves"), and
the MCP server sending `x-sw-actor: user:<his users.id>` with its server secret.
Until both, Shaun approves from his signed-in session.
