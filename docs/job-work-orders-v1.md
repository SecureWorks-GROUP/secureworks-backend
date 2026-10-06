# Job work orders v1

Captain, 6 Oct 2026: every fencing and patio job has one work order, draft then
approved by Shaun. Approved is sealed like an invoice. Trade labour billed on the
job shows against it live, and a trade can report a variation on their invoice,
which emails finance and, separately, admin.

Code: `supabase/functions/ops-api/job_work_orders.ts`. Schema, seal, triggers,
backfill: `supabase/migrations/20261006120000_job_work_orders.sql` (contract
`supabase/tests/migration-contracts/20261006120000_job_work_orders/`).

## Model

- A job work order is a `work_orders` row with `kind = 'job'`. Every older row
  is `kind = 'crew'` (the per-trade crew-pay work order) and behaves as before.
  Crew-pay invoicing (`my_work_orders`, `submit_work_order_invoice`, weekly
  blocks) only ever reads `kind = 'crew'`.
- Status `draft` (editable, counts for nothing), `approved` (sealed), or
  `cancelled` (a draft that was dropped). One open draft and one live approved
  work order per job, enforced by unique indexes.
- `jobs.work_order_id` points at the job's live approved work order, or at the
  draft while none is approved.
- Approved rows are sealed by trigger `trg_work_orders_job_kind_guard`: no
  field can change and the row cannot be deleted. Change comes through a
  variation, or a revision: a new draft with `supersedes_work_order_id`; when
  Shaun approves it, the old one gets `superseded_at` in the same transaction.
- `agreed_labour_ex` is the labour we allowed and agreed (ex GST). Approving
  needs it set and some scope (scope items or special instructions). The
  trigger stamps `sealed_content_hash` (sha256 of the sealed content).

## Who approves (Shaun only)

`work_order_settings.approver_user_ids`, seeded with Shaun's `users.id`
(`9913309f-35ae-4a71-8e1f-f704ecc526ea`, shaun@secureworkswa.com.au), the same
pattern as `debt_desk_settings`. Never a role: six users hold `ops_manager`.
Checked in `approveJobWorkOrder` and again in the database trigger.

The approver is identified as:

- `session`: a signed-in staff JWT (Ops dashboard).
- `terminal`: a server-secret call (SecureSuite) carrying the trusted header
  `x-sw-actor: user:<users.id>`. The shared browser key never counts.

## Labour billed against it

Trigger `trg_trade_invoice_lines_link_job_work_order` stamps
`trade_invoice_lines.job_work_order_id` with the job's live approved work order
when the line's invoice is submitted (any status except `draft` and
`ops-reject`); `trg_trade_invoices_link_job_work_orders` does the same when a
draft invoice is submitted later. Every submit path is covered because the
database does it. Commission and final payout deduction lines are never labour.
Labour billed before approval stays unlinked and is shown separately as
`labour_before_approval` (not counted).

View `job_work_order_labour_lines` is the per-line shape for later job costing
(work order, job, invoice, trade, line type, hours, amount ex GST, counted).

## Running figures and rules

`figures` on every read of an approved work order:

| field | meaning |
| --- | --- |
| `agreed_ex` | sealed agreed labour |
| `billed_to_date_ex` | counted labour lines stamped against this job's approved work order (variation work included) |
| `variations_ex` | the part of billed the trades marked as variations |
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
trade invoice per job, against the live approved work order (or none, kept but
not counted). It writes two rows in `work_order_variation_emails`: one to
finance@secureworkswa.com.au and a separate one to admin@secureworkswa.com.au,
sent from admin@ through `send-outlook-email`. Addresses: secureworks-wiki
`harness/ops/sops/make-safe-ops-agent-sop.md` lines 134 and 137.

Sending is OFF: feature flag `work_order_variation_emails_v1` is seeded false.
While off, rows stay `recorded`. Turning it on needs the captain's word; only
variations reported while it is on are sent (no backlog). The transport is
built but has never sent a live email.

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
| `job_work_order` | GET | staff | `job_id` or `work_order_id` | `{schema:"job-work-order.v1", job, eligible, work_order, live_work_order, draft_work_order, history[], figures, invoices[], labour_lines[], labour_before_approval, variations[]}` |
| `list_work_orders` | GET | staff | `kind=job`, optional `status` (draft, approved, superseded, cancelled), `type` (fencing, patio), `job_id` | `{schema:"job-work-orders.v1", work_orders[] (row + job_number, client_name, job_type, job_status, site_suburb, figures for live ones), total}`. Without `kind=job` the old list (every kind, rows carry `kind`). |
| `create_work_order` | POST | staff | `{kind:"job", job_id, ...draft fields}` | `{created, work_order}`: the open draft, else a revision draft of the live one, else a new draft |
| `update_work_order` | POST | staff | `{id, scope_items?, special_instructions?, agreed_labour_ex?, scheduled_date?, site_address?}` or `{id, status:"cancelled"}` | `{work_order}`; approved returns 409 `work_order_sealed` |
| `approve_work_order` | POST | Shaun (session or terminal) | `{work_order_id, expected_updated_at?}` | `{work_order}`; 403 `approver_required` / `approver_identity_missing`, 422 `work_order_not_ready`, 409 `live_work_order_exists` / `revision_stale` / `stale_review` |
| `backfill_job_work_orders` | POST | ops server key | `{apply?: true}` | `{dry_run, candidates, by_type_status, job_ids, opened}` |
| `send_work_order` | POST | staff | job work order id | 409 `job_work_order_not_sendable` |
| `job_detail` | GET | unchanged | | adds `job_work_order: {work_order, live_work_order_id, draft_work_order_id, figures, invoice_count, variation_count}` on fencing and patio jobs |
| `my_job_work_order` | GET | trade with access to the job | `job_id` | `{schema:"trade-job-work-order.v1", work_order: {id, wo_number, status, approved_at, job_id, job_number, job_type, site_address, scheduled_date, scope_items, special_instructions} or null, reason, can_report_variation, my_variations[]}`. No price, allowance, agreed amount or figure, ever. |
| `report_work_order_variation` | POST | trade, own invoice, access to the job | `{trade_invoice_id, job_id, description, amount_ex?}` | `{variation, duplicate, emails:[{recipient_role, status}]}` |

Work order row fields: `id, job_id, wo_number, kind, status, scope_items,
special_instructions, scheduled_date, site_address, agreed_labour_ex,
approved_at, approved_by, approved_via, sealed_content_hash,
supersedes_work_order_id, superseded_at, superseded_by_work_order_id, origin,
created_at, updated_at`.

Trade invoice flow: the trade allocates and invoices as before. After the
invoice is created, show `my_job_work_order` for each job on it, then a "Any
variations to the work order?" choice; on yes, call
`report_work_order_variation` with that invoice id.

## Terminal (SecureSuite)

The MCP tools live in `secureworks-jarvis` (`src/mcp-server.ts`), not here.
Mapping: `sw_list_work_orders` -> `list_work_orders?kind=job`,
`sw_create_work_order` -> `create_work_order {kind:"job"}`,
`sw_update_work_order` -> `update_work_order`, a view tool -> `job_work_order`,
and a new approve tool -> `approve_work_order`. For approve to work from Shaun's
terminal, the MCP server must send `x-sw-actor: user:<his users.id>` with its
server secret; until it does, terminal approval refuses
`approver_identity_missing` and Shaun approves from his signed-in session.
