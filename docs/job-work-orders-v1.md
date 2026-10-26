# Job work orders v1

Captain, 6 Oct 2026: every fencing and patio job has one work order, draft then
approved by Shaun. Approved is sealed like an invoice. Captain, 14 Oct 2026: the
work order fills itself from the accepted quote and goes straight to the trades
on the job with no approval; only a customer variation waits for approval (see
"Automatic issue", behind a switch that is off until the captain says make it
live). Trade labour billed on the
job shows against it live, and a trade can report a variation on their invoice,
which emails finance and, separately, admin.

Code: `supabase/functions/ops-api/job_work_orders.ts`. Schema, seal, triggers,
backfill: `supabase/migrations/20261012130000_job_work_orders.sql` (contract
`supabase/tests/migration-contracts/20261012130000_job_work_orders/`).

## Model

- A job work order is a `work_orders` row with `kind = 'job'`. Every older row
  is `kind = 'crew'` (the per-trade crew-pay work order) and behaves as before.
  Crew-pay invoicing (`my_work_orders`, `submit_work_order_invoice`, weekly
  blocks) only ever reads `kind = 'crew'`.
- Status `draft` (editable, counts for nothing) or `approved` (sealed). There
  is no cancelled state. One work order per job: a draft, then that same row
  approved, enforced by unique index `uq_work_orders_job_current`.
- The `job_events` rows this module writes (draft opened or updated, approved,
  variation reported or corrected) carry ids only: never the agreed labour, a variation
  amount or the sealed hash. `job_events` is readable by any signed-in user of
  the org, trades included, and the hash could be used to guess the agreed
  figure. The figures live on the work order row, which trades cannot read.
- The crew work order readers (`job_detail.work_orders`, the old
  `list_work_orders`, `ops_summary`, the dossier, the invoice context,
  `reporting-api`, the trade's `trade_job_detail.work_orders`, and
  `pipeline`'s `wo_count`, the "Work order exists" readiness check) leave the
  job work order out, draft or approved; it is read through `job_work_order`,
  `list_work_orders` with `kind=job`, and `job_detail.job_work_order`. Known
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
- Approval seals only what the approver read. `approve_work_order` must carry
  `expected_updated_at`, the `updated_at` of the draft as it was read. Every
  save of a draft moves `updated_at` (the same trigger), and
  `approve_job_work_order` compares the stamp under its row lock, so a save
  that lands after the read, even between the press and the seal, is refused
  409 `stale_review` and nothing is sealed. Read the draft again, then approve.

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

## Automatic issue (switch `job_work_order_auto_issue_v1`, OFF)

Captain, 14 Oct 2026: "those work orders should be able to be seen every single
job. The only time where it needs approval is when there's a variation
involved." While feature flag `job_work_order_auto_issue_v1` is on, the system
issues the base work order itself: filled from the accepted quote, then
approved and sealed with `approved_via: 'auto'` and no approver
(`approved_by` null), exactly as an approval seals it (content hash, labour and
trade variations already on the job linked). Allocated trades then read it
through `my_job_work_order` with no human step. Code:
`autoIssueJobWorkOrderForJob` and `autoIssueJobWorkOrders` in
`job_work_orders.ts`; schema, door and sweep:
`supabase/migrations/20261016120000_job_work_order_auto_issue.sql` (contract
`supabase/tests/migration-contracts/20261016120000_job_work_order_auto_issue/`).

What is issued, and what waits for the approver:

- Only the draft the quote fill wrote that nobody has edited since. The fill
  stamps `work_orders.quote_filled_at` in the same write that fills an
  untouched draft; any other change to a draft's content (scope, special
  instructions, agreed labour, date, address) stamps `hand_edited_at`. Both are
  set by the database trigger only: a caller can neither write nor clear them.
  A draft edited by hand is never issued automatically; it waits for Shaun's
  approval as before. Drafts written into before the migration are stamped
  once by it: a draft with no fill stamp that carries special instructions, a
  date, or an address other than the job's (the open path,
  `ensure_job_work_order_draft`, writes none of those but the job's address)
  gets `hand_edited_at`, so the fill leaves it unstamped and it waits for the
  approver. An untouched opened draft and a draft only the earlier fill wrote
  are not stamped.
- Only an open fencing or patio job (`job_work_order_open_statuses()`, mirrored
  as `JOB_WORK_ORDER_OPEN_STATUSES`). An approved work order is never touched.
- Lines the fill flags for review (`needs_review`, for example an old extra
  saved with no hours, `labour_or_material_unknown`) do NOT hold the work
  order: it goes out as it is, and the flags stay on the sealed lines for the
  office as the "needs checking" note below. Trades never see a flag.
- A job moved past quoted with no recorded acceptance but with a frozen
  fence-tool or patio-tool quote counts as accepted at its latest frozen quote,
  the newest revision still in status `frozen`, whenever it was frozen; a
  superseded revision never counts (captain, 16 Oct 2026;
  `latest_frozen_revision`, docs/quote-work-order-lines-v1.md "Which quote"),
  so its work order fills and goes out like any other: 29 of the 81 open jobs
  on 16 Oct 2026 (5 fencing, 24 patio), most of them patio jobs moved straight
  to an open status other than accepted by an Ops status change.
- Held for the office to fill by hand, with the reason on the note, as the
  captain accepted on 16 Oct 2026: a quote with no labour figure
  (`agreed_labour_missing`: lines are filled, the agreed labour is the
  approver's to set), a job with nothing to fill from (`not_filled`: older
  quotes from before the tools froze quotes, or no quote in the system; 26 of
  the 81 open jobs on 16 Oct 2026), and a draft filled before this switch that
  cannot be shown untouched since (`filled_before_auto_issue`).
- A frozen quote with nothing to copy (no labour and no work lines, so the
  fill answers `no_quote_lines`) shows as `quote_has_no_lines` on the staff
  read instead of `not_filled`, and the fill writes one ids-only job event
  `job_work_order_quote_has_no_lines` per draft and quote revision (19 Oct
  2026; three patio jobs had such quotes and the office got no
  signal). An unreadable check of earlier events writes
  nothing, so the 2-minute sweep cannot flood the job's events.
- Customer variations still need the work order approver, exactly as before
  ("Customer variations" below). They join an automatically issued work order
  the same way.

The one door is `auto_issue_job_work_order(work_order_id, expected_updated_at)`
(service role only). It refuses 42501 while the flag is off, WO409 when the
draft moved since the system read it (a save always wins), and WO423 for a draft
the fill did not write or someone edited. The seal trigger accepts
`approved_via 'auto'` only from inside that door, only while the flag is on and
only with no approver; a human approval still needs an approver from
`work_order_settings`. Drafts the fill wrote before the migration (it shipped
13 Oct 2026) are stamped by the migration only when no write landed after the
fill's own `job_work_order_draft_filled_from_quote` event and they hold quote
lines only.

When it runs:

1. pg_cron `job-work-order-auto-issue`, every 2 minutes, posts ops-api
   `auto_issue_job_work_orders` while the flag is on (a no-op otherwise; ops-api
   checks the flag again). This is the catch-all: a job becomes approved through
   send-quote's acceptance page, an ops status change, or a CRM stage move, and
   the draft itself is opened by a database trigger (20261012130000), which
   cannot call the TypeScript fill. A sweep picks up every way in, at most 2
   minutes later. Candidates: every filled, unedited draft with an agreed labour
   figure on an open job, then untouched drafts opened in the last 3 days,
   newest first (a job with no accepted quote is not retried forever ahead of
   new ones), at most 25 per call (`limit`, at most 100).
2. ops-api `update_job_status`: a fencing or patio job moving into an open
   status is filled and issued in the same call, so the ops screen's own status
   change does not wait for the sweep. It never fails the status change.
3. `backfill_job_work_orders` with `apply: true` (still behind
   `job_work_order_backfill_v1`): each draft it fills is issued straight away
   while this switch is on; its dry run reports `auto_issue.switched_on`.

Every automatic issue writes one `job_work_order_auto_issued` job event (ids and
counts only, no user).

### The "needs checking" note (office only)

`job_work_order` and `job_detail.job_work_order` carry `needs_checking`:

`{needs_checking, lines:[{line_key, description, flags[]}], issued_automatically, held:{reason, message} | null, message}`

`lines` are the work order's lines the fill flagged (`needs_review`).
`held` is set only on a draft: `hand_edited`, `not_filled`,
`agreed_labour_missing`, `filled_before_auto_issue`,
`quote_has_no_lines` (each needs the office:
`needs_checking` true), or `auto_issue_switched_off` / `awaiting_auto_issue`
(nothing to do). Computed at read time from the work order and the fill that
read made (`quote_has_no_lines` comes from the fill's answer), stored nowhere.
The trade read is an allowlist and never carries it.

### Turning it on (the captain's "make it live")

In this order, each on the captain's word:

1. Deploy (migration first, then ops-api, by the usual lane). Nothing changes:
   the flag is seeded off and the sweep is a no-op.
2. Turn on `job_work_order_auto_issue_v1`. From then on newly approved fencing
   and patio jobs get their work order issued within 2 minutes (at once on an
   ops status change), and already filled, unedited drafts go out on the next
   sweep.
3. Run `backfill_job_work_orders` as a dry run, then turn on
   `job_work_order_backfill_v1` and run it with `apply: true` to open, fill and
   issue the work orders of the jobs that were already open.
4. Make the trade screens live (secureworks-ux, behind their preview): only
   then do trades see the issued work orders.

To stop: turn the flag off. Work orders already issued stay sealed (a change
is a variation); drafts wait for the approver again.

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

The trade app's "Work Order" pay line (`line_type` `work order` or
`work_order`) is labour. The shared view puts both types in its labour lane
since `20261015093000_trade_charge_work_order_labour.sql` (owner call JP-04).
`workOrderLineIsLabour` in `job_work_orders.ts` still carries a redundant
line-type test from before that migration; it agrees with the view and is to
be removed separately. A job billed as one 2,000 Work Order line against an
agreed 2,000 reads billed 2,000, remaining 0.

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
| `customer_variations_ex` | the trade allocation of the approved customer variations (the addenda, see "Customer variations") |
| `customer_variations_price_ex` | what those approved customer variations charge the customer, ex GST |
| `customer_variation_count` | how many approved customer variations are counted |
| `agreed_total_ex` | `agreed_ex` plus `customer_variations_ex`: what billed is measured against |
| `billed_to_date_ex` | labour-lane lines on billed invoices, stamped against this job's approved work order (variation work included) |
| `variations_ex` | the part of billed the trades marked as variations. A variation counts only while its trade invoice is billed (not draft, not `ops-reject`), the same rule as labour lines |
| `variation_count` | how many variations are counted in `variations_ex` |
| `billed_within_agreed_scope_ex` | billed minus variations |
| `remaining_ex` | agreed total minus billed |
| `used_ratio` | billed / agreed total |
| `over_agreed` | true when billed (within scope plus trade variations) is over the agreed total |

Rules (`figures.rules[]`, each `{key, level, message}`):

- `over_agreed` (flag): billed is over the agreed total (agreed labour plus
  approved customer variations).
- `near_agreed` (warn): billed is 90% or more of the agreed total, and not over.
- `has_variations` (info): one or more trade variations reported.
- `has_customer_variations` (info): one or more approved customer variations
  added to the agreed labour.
- `no_approved_work_order` (info): nothing counts until a work order is approved.

## Variations and emails

This section is the trade's variation: an overrun the trade reports on their
own invoice (`work_order_variations`). The office's customer variation, which
joins the work order as an addendum, is a separate record: see "Customer
variations" below.

`report_work_order_variation` records one `work_order_variations` row per
trade invoice per job, against the approved work order (or none: kept, and
linked when the work order is approved). A variation is part of the labour its
invoice bills, so `amount_ex` may not be more than the labour that invoice
bills on that job, ex GST, by the same labour rule the work order totals use
(the labour lane; materials, travel and other
lines never count). A larger amount is refused 422 `variation_over_invoice`:
300 labour plus 400 materials refuses 650. It writes two rows in `work_order_variation_emails`: one to
finance@secureworkswa.com.au and a separate one to admin@secureworkswa.com.au,
sent from admin@ through `send-outlook-email`. Addresses: secureworks-wiki
`harness/ops/sops/make-safe-ops-agent-sop.md` lines 134 and 137.

The email body carries the agreed labour, billed to date and remaining, so the
send request names no job (`job_id` is never passed). With a job id,
`send-outlook-email` copies the whole body into `po_communications`, which any
signed-in user of the org can read, and files it in the job's client email
thread. The `work_order_variation_emails` ledger, which trades cannot read, is
the record of each email. The subject carries the job number and suburb only.

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

A variation already recorded is never changed or blocked by a later invoice
save. When a draft is replaced by one that bills less labour on the job than
its carried variation, the save goes through and the variation keeps its
amount; the staff read shows it instead: that `variations[]` row carries
`over_invoice_labour: true` (its amount is larger than the labour its invoice
now bills on the job, the same test as the refusal above). Staff then use the
correction below. The flag is computed at read time and stored nowhere.

### Correcting a variation (office staff only)

The trade cannot change a variation once it is recorded. When one is wrong,
office staff call `correct_work_order_variation` with the corrected
`description`, `amount_ex`, or both (the same invoice labour limit applies). The row
keeps what the trade first reported in `original_description` and
`original_amount_ex` (written by the first correction, never again) and who
corrected it and when in `corrected_by` (the caller: `user:<users.id>` for a
signed-in session, the `x-sw-actor` value for a server key call; a call that
names nobody is refused) and `corrected_at`. The work order figures read the
row, so they follow the correction. There is no withdraw and no history beyond
the original values.

The two ledger emails for the variation are replaced by corrected ones (subject
`Correction: work order variation on ...`, with what the variation was), so an
earlier email with the wrong amount can never be sent later. They are sent, one
to finance and one to admin, only while `work_order_variation_emails_v1` is on;
while it is off they stay `recorded`.

## Customer variations

Captain, 12 and 13 Oct 2026: a variation joins the existing work order as a
marked addendum; no trade sees a dollar amount, the lead trade included; the
customer invoice line comes from the same record instead of being typed into
Xero by hand.

Code: `supabase/functions/ops-api/work_order_customer_variations.ts` (actions)
and `job_work_orders.ts` (the addenda in every work order read). Schema, seal
and approval: `supabase/migrations/20261013140000_work_order_customer_variations.sql`
(contract `supabase/tests/migration-contracts/20261013140000_work_order_customer_variations/`).

### Why a new record

Neither existing table that says "variation" can hold it:

- `work_order_variations` is the trade's overrun flag: one row per trade invoice
  per job, its amount the part of that invoice the trade says is extra. It is
  unchanged.
- `job_variations` gives every row a `share_token` at insert, and send-quote's
  public page accepts or declines any row by that token whatever its status, so
  an office draft would be acceptable by the customer before anyone approved it.
  Its approve door (`approve_variation`) has no stale-read guard, it has no draft
  or cancelled state, and the job story lists every row as an open matter.

So customer variations live in `work_order_customer_variations`. Known
follow-up: the invoice context (`promised.variations`), the dossier and the job
story read `job_variations` only, so they do not yet list customer variations.

### The record

- `description`, and `tasks`: `[{description, hours, qty?, unit?}]`. Every task
  carries the hours it takes (more than 0). A task may also carry a quantity with
  its unit (6 m); a quantity needs its unit. Text with a `$` is refused
  (`money_in_text`): trades read it, and the trade filter withholds a line that
  carries a price.
- `trade_allocation_ex`: the labour allowed to the trades for the variation, ex
  GST. `customer_price_ex`: what the customer is charged, ex GST. Both office
  only; both required to approve. A customer price of 0 is allowed (a variation
  we fund) and has no invoice line.
- Status `draft`, `approved` or `cancelled`. Only staff write a draft, and every
  edit, approval and cancellation names the `updated_at` it read
  (`expected_updated_at`); a draft that moved since is refused 409
  `stale_review` and nothing changes.
- Approving needs a work order approver (the `work_order_settings` list that
  approves the work order, Shaun), from a signed-in session (the terminal only
  while `work_order_terminal_approval_v1` is on), and the job's work order
  already approved (409 `work_order_not_approved` otherwise). In one transaction
  `approve_work_order_customer_variation` locks the work order, gives the
  variation the next number on it (1, 2, 3, never reused) and seals it. The work
  order's own sealed lines are never touched.
- Approved is sealed by trigger: no edit, no cancel, no delete. A mistake is
  corrected by a further variation. Only a draft can be cancelled.
- `job_events` rows (`customer_variation_recorded`, `_updated`, `_approved`,
  `_cancelled`, `_invoice_line_prepared`, `_xero_draft_created`) carry ids only.

### On the work order

Every staff read of the job work order (`job_work_order`, `list_work_orders`
with `kind=job`, `job_detail.job_work_order`) counts the approved customer
variations in the figures: `agreed_total_ex` = agreed labour + their trade
allocation, and `remaining_ex`, `used_ratio`, `over_agreed` and `near_agreed`
are measured against it. Trade labour billed for variation work is stamped
against the same work order, as before.

`addenda[]` lists the approved ones in number order:

`{id, variation_number, label, approved_at, approved_by, description, lines[], hours_total, trade_allocation_ex, customer_price_ex}`

`label` reads `Variation 1 - approved 13 Oct 2026` (the approval day in Perth).
Each line is in the work order's `scope_items` shape:

`{line_key:"variation:<n>:<i>", source:"variation", is_variation:true, variation_number, description, qty, unit, hours}`

A task with no quantity of its own carries its hours as `qty` with unit `hrs`,
as the quote's hour-priced lines do.

### What a trade sees

`my_job_work_order` adds `work_order.addenda[]`:
`{variation_number, label, approved_at, description, scope_items[]}`, built
field by field, with the same trade filter as the work order's lines. The trade
read selects only `id, job_id, work_order_id, variation_number, status,
description, tasks, approved_at`: it never asks for a money column. The trade
line allowlist (`TRADE_WO_SCOPE_ITEM_ALLOWLIST`) now also keeps `hours`,
`is_variation` and `variation_number`, so every trade sees each line's hours
(per-metre lines read `hours: null`) and which lines are variations. No trade,
the lead trade included, ever sees a dollar amount, price, rate or allocation.
Drafts and cancelled variations are never shown.

### The customer invoice line

`prepare_customer_variation_invoice_line` builds the customer's line from the
approved variation and keeps it in `work_order_customer_variation_invoices`
(one per variation). It writes nothing to Xero. The line is
create_invoice_draft's shape:

`{description:"Variation 1 - approved 13 Oct 2026: <description>\n- <task>...", quantity:1, unit_price:<customer_price_ex>, account_code:<the job type's sales account>}`

Hours, the trade allocation and any rate stay off it. The response carries
`create_invoice_draft: {job_id, line_items:[line], reference:"<job number> Variation <n>"}`,
ready for `create_invoice_draft` once the office picks the Xero contact.

`create_customer_variation_xero_draft` creates one Xero DRAFT (ACCREC, never
sent) holding that line, through `create_invoice_draft`'s own path and gates
with the caller's credentials. It is OFF: feature flag
`customer_variation_xero_draft_v1` is seeded false and while it is off the
action is refused 403 `xero_draft_switched_off` before anything is called.
Turning it on needs the captain's word. One draft per variation: the record is
claimed (`prepared` -> `creating`) before the call. A refusal create_invoice_draft
gives before Xero is called releases it back to `prepared` (422
`xero_draft_refused`): a refusal it returns (other than
`INVOICE_DRAFT_OUTCOME_UNCONFIRMED`), missing line items or contact, the
synthetic live-fire refusal, the preflight refusal and a Xero token it could not
get (`customerVariationDraftRefusedBeforeXero`). Any other outcome Xero did not
confirm is kept as `unknown` (502 `xero_outcome_unknown`) and every later call is
refused 409 `xero_outcome_unknown`, because the draft may exist. When Xero
confirms the draft but its outcome cannot be saved, the call fails 502
`xero_draft_outcome_not_saved` naming the Xero invoice id and number, and the
line stays `creating` (later calls 409 `xero_draft_in_progress`). A
variation split across several payers (one owner each, as on SWF-26904) is out
of this slice: one line, one contact.

### A stuck Xero draft record

Nothing retries an `unknown` record or a stuck `creating` one by itself. A work
order approver (the same people, and the same session or terminal rule, as
`approve_customer_variation`) checks Xero by hand and then answers with
`reconcile_customer_variation_xero_draft`, which never calls Xero:

- `outcome: "draft_exists"` with the `xero_invoice_id` they found (and its
  `invoice_number` when they have it): the record becomes `xero_draft_created`
  holding that invoice and is sealed like any other created draft. Its
  `xero_created_at` is when it was recorded here, not when Xero made it. A Xero
  invoice already recorded for another variation is refused 409
  `xero_invoice_already_recorded`.
- `outcome: "no_draft"`: they found none, and the record goes back to
  `prepared` so `create_customer_variation_xero_draft` can send the line again.
  The earlier `failure` text is kept.

A `creating` record is answered for only once its claim (`xero_requested_at`)
is 15 minutes old (`CUSTOMER_VARIATION_CREATING_STALE_AFTER_MS`); before that a
request may still be making the draft, and the answer is refused 409
`xero_draft_in_progress`. An ops-api request cannot run that long, so an older
claim has nothing left that could finish it. The answer names the record's
`updated_at` as read (`expected_updated_at`, `invoice.updated_at` on the reads)
and is written in one compare-and-set on that, the status read and, for
`creating`, the same claim instant: a record that changed or was claimed again
since the read is refused 409 `stale_review`.

The record of an answer is its `customer_variation_xero_draft_reconciled` job
event, which carries ids only: the variation, the `outcome`, the status it came
from, the Xero invoice id recorded (null for `no_draft`), who answered
(`reconciled_by`, a user id) and how (`via`, `session` or `terminal`); when is
the event's own time. The invoice record keeps no copy of the answer.

## Backfill (OFF)

`backfill_job_work_orders` (ops server key only) calls
`backfill_job_work_order_drafts(p_apply)`. It is a dry run unless `apply: true`
AND feature flag `job_work_order_backfill_v1` is on (seeded false). It opens a
draft for every fencing or patio job in an open approved status
(`job_work_order_open_statuses()`) with no job work order. Closed jobs are left
alone. Future jobs get their draft from trigger `trg_jobs_open_job_work_order`
when they enter an open approved status.

## Filled from the accepted quote

An untouched draft (no `scope_items`, no `agreed_labour_ex`) is filled from the
job's accepted quote: its task lines, with hours where the quote has hours, and
the quote's own labour figure as the agreed labour. This happens when staff open
it (`create_work_order`), when staff (or the ops server key) read it
(`job_work_order`, `job_detail`; never on a routine-key read), and in the
backfill's apply.
A draft anyone has written into, and every approved work order, is left alone.
Rules, line shape and flags: `docs/quote-work-order-lines-v1.md`.

The fill also stores the frozen scope revision the lines came from on the row,
`work_orders.quote_filled_scope_revision_id` (`20261020120000`, Dispatch S6,
R7), in the same write. A trigger allows it only while a draft, only to a
frozen or superseded revision of the same job, never clears it, and changes it
only when a cleared draft (no lines, no agreed labour) is refilled, possibly
from a newer revision. It is never a hand edit or part of the sealed content
hash. It is null
on crew work orders and on job work orders filled before that migration (no
backfill: it would move a draft's `updated_at`, and approved rows are sealed).
The staff read's `filled_from` answers from the column first, else the newest
`job_work_order_draft_filled_from_quote` event for that work order; a draft
stamped `quote_filled_at` with neither reads as unknown (`unreadable: true`),
since a fill stands even when its event could not be written.

## API for the screens

All on `ops-api`. Staff = ops server key, or a signed-in admin/owner/ops_manager.
Errors are `{error, code}`.

| action | method | who | input | output |
| --- | --- | --- | --- | --- |
| `job_work_order` | GET | staff | `job_id` or `work_order_id` | `{schema:"job-work-order.v1", job, eligible, work_order, live_work_order, draft_work_order, figures, invoices[], lines[] (each with `cost_lane` and `counted`), labour_before_approval, variations[], quote_fill, filled_from, needs_checking}`; `filled_from` is `{scope_revision_id, source: "work_order" \| "fill_event" \| null, unreadable}` for the work order shown (`unreadable: true` when the fill event read failed, which is unknown, never "not filled"); `needs_checking` is the office note (see "Automatic issue"); `quote_fill` is `{filled, reason, scope_revision_id, needs_review, code?}` (`code` only when the fill failed) when this read tried to fill an untouched draft from the quote, else null |
| `list_work_orders` | GET | staff | `kind=job`, optional `status` (draft, approved), `type` (fencing, patio), `job_id` | `{schema:"job-work-orders.v1", kind:"job", work_orders[] (row + job_number, client_name, job_type, job_status, site_suburb, figures for approved ones), total}`. Without `kind=job` the old list, crew work orders only: a job work order is never in it. |
| `create_work_order` | POST | staff | `{kind:"job", job_id, ...draft fields}` | `{created, work_order, quote_fill}`: the open draft, else a new draft, filled from the quote unless the call sent `scope_items` or `agreed_labour_ex`; 409 `work_order_sealed` once the job's work order is approved |
| `update_work_order` | POST | staff | `{id, scope_items?, special_instructions?, agreed_labour_ex?, scheduled_date?, site_address?}` | `{work_order}`; approved returns 409 `work_order_sealed`; a `status` other than `draft` returns 400 `invalid_status` |
| `approve_work_order` | POST | Shaun (session; terminal only while its flag is on) | `{work_order_id, expected_updated_at}`: both required; `expected_updated_at` is the draft's `updated_at` exactly as it was read | `{work_order}`; 400 `expected_updated_at_required` (missing: read the draft again), 409 `stale_review` (the draft changed after it was read: read it again), 403 `approver_required` / `approver_identity_missing` / `terminal_approval_switched_off`, 422 `work_order_not_ready`, 409 `not_a_draft` |
| `backfill_job_work_orders` | POST | ops server key | `{apply?: true, fill_limit?}` | `{dry_run, candidates, by_type_status, job_ids, opened, quote_fill, auto_issue}`; `quote_fill` counts untouched drafts, and on apply fills up to `fill_limit` (default 100, at most 200) and says how many remain; `auto_issue` is `{dry_run:true, switched_on}` on a dry run, else `{switched_on, issued, not_issued:{reason:n}}` for the drafts this run filled |
| `auto_issue_job_work_orders` | POST | ops server key (the pg_cron sweep) | `{limit?}` | `{schema:"job-work-order-auto-issue.v1", switched_on, candidates, issued, not_issued:{reason:n}, results:[{job_id, work_order_id, issued, reason, quote_fill, needs_checking_lines, code?}]}`; writes nothing while `job_work_order_auto_issue_v1` is off |
| `quote_work_order_lines` | GET | staff | `job_id` (a job id; anything else is 400 `job_id_required`) | the lines the accepted quote gives the job, writing nothing (`docs/quote-work-order-lines-v1.md`) |
| `resend_work_order_variation_emails` | POST | staff | none | `{sending_on, emails:[{id, variation_id, recipient_role, status}]}`; `sending_on:false` and no sends while the email flag is off |
| `correct_work_order_variation` | POST | staff only, never a trade session | `{variation_id, description?, amount_ex?}` (at least one, and different from what is recorded; `amount_ex: null` clears the amount) | `{variation, emails:[{recipient_role, status}]}`; 422 `variation_over_invoice`, 400 `nothing_to_correct`, 404 `variation_not_found`, 403 `corrector_identity_missing` |
| `send_work_order` | POST | staff | job work order id | 409 `job_work_order_not_sendable` |
| `job_detail` | GET | unchanged | | adds `job_work_order: {work_order, live_work_order_id, draft_work_order_id, figures, addenda, invoice_count, variation_count, customer_variations_open_count, quote_fill, needs_checking}` on fencing and patio jobs (null on other types); `customer_variations_open_count` counts drafts and approved ones, not cancelled (`figures.customer_variation_count` counts only the approved addenda on the work order); `{unreadable: true}` when that read fails, which never fails the job detail |
| `my_job_work_order` | GET | trade with access to the job | `job_id` | `{schema:"trade-job-work-order.v1", job_id, work_order: {id, wo_number, status, approved_at, job_id, job_number, job_type, site_address, scheduled_date, scope_items, special_instructions, addenda[]} or null, reason, can_report_variation, my_variations[]}`. Each scope item is `{description, qty, unit, hours}` (plus `is_variation`, `variation_number` on an addendum line); each addendum `{variation_number, label, approved_at, description, scope_items}`. No price, allowance, agreed amount or figure, ever, for any trade, the lead trade included. |
| `customer_variations` | GET | staff | `job_id` (a job id) | `{schema:"customer-variations.v1", job:{id, job_number, type}, customer_variations[]}`; each is the customer variation row below plus `invoice` (the invoice record, or null: `status, line, prepared_by, prepared_at, xero_contact_id, job_contact_id, xero_requested_by, xero_requested_at, xero_invoice_id, invoice_number, xero_created_at, failure, updated_at`) |
| `create_customer_variation` | POST | staff, a named caller | `{job_id, description, tasks?, trade_allocation_ex?, customer_price_ex?}` | `{customer_variation}` (a draft); 422 `job_type_not_eligible`, 400 `invalid_tasks` / `money_in_text` / `invalid_description`, 403 `actor_identity_missing` |
| `update_customer_variation` | POST | staff, a named caller | `{variation_id, expected_updated_at, description?, tasks?, trade_allocation_ex?, customer_price_ex?}` (amounts may be null to clear) | `{customer_variation}`; 409 `stale_review` (read it again), 409 `variation_sealed`, 400 `nothing_to_update` / `expected_updated_at_required` |
| `approve_customer_variation` | POST | work order approver (session; terminal only while its flag is on) | `{variation_id, expected_updated_at}` | `{customer_variation}` now `approved`, with `work_order_id`, `variation_number` and `label`; 409 `work_order_not_approved`, 409 `stale_review`, 409 `not_a_draft`, 422 `variation_not_ready` (a task without hours, or no allocation or price), 403 `approver_required` / `approver_identity_missing` / `approver_not_set` / `terminal_approval_switched_off` |
| `cancel_customer_variation` | POST | staff, a named caller | `{variation_id, expected_updated_at, reason?}` | `{customer_variation}` now `cancelled`; 409 `variation_sealed` for an approved one, 409 `stale_review` |
| `prepare_customer_variation_invoice_line` | POST | staff, a named caller | `{variation_id}` | `{customer_variation_id, line, invoice, create_invoice_draft:{job_id, line_items, reference}, xero_draft_switched_on}`; 409 `variation_not_approved`, 422 `no_customer_charge`. No Xero write |
| `create_customer_variation_xero_draft` | POST | staff, a named caller | `{variation_id, xero_contact_id, job_contact_id?}` | the prepare response plus `duplicate`, with `invoice.status` `xero_draft_created` and `invoice.xero_invoice_id` / `invoice_number`; 403 `xero_draft_switched_off` while the flag is off; 422 `xero_draft_refused`; 502 then 409 `xero_outcome_unknown`; 502 `xero_draft_outcome_not_saved`; 409 `xero_draft_in_progress` |
| `reconcile_customer_variation_xero_draft` | POST | work order approver (session; terminal only while its flag is on) | `{variation_id, expected_updated_at, outcome: "draft_exists" \| "no_draft", xero_invoice_id?, invoice_number?}`: `xero_invoice_id` (the Xero InvoiceID) is required for `draft_exists` and refused for `no_draft` | `{customer_variation_id, invoice, duplicate}`; `duplicate` is true when the same draft was already recorded. 409 `nothing_to_reconcile` (`prepared`), 409 `xero_draft_already_recorded`, 409 `xero_draft_in_progress` (a `creating` claim under 15 minutes old), 409 `xero_invoice_already_recorded`, 409 `stale_review`, 404 `invoice_line_not_found`, 400 `invalid_outcome` / `invalid_request` / `invalid_invoice_number` / `expected_updated_at_required` (send the record's `invoice.updated_at`), 403 `approver_required` / `approver_identity_missing` / `approver_not_set` / `terminal_approval_switched_off`. Never calls Xero |
| `report_work_order_variation` | POST | trade, own invoice, access to the job | `{trade_invoice_id, job_id, description, amount_ex?}` | `{variation, duplicate, emails:[{recipient_role, status}]}`; 422 `variation_over_invoice` when `amount_ex` is more than the labour the invoice bills on the job |

Each `variations[]` row on the staff read: `id, work_order_id,
trade_invoice_id, reported_by, reported_by_name, description, amount_ex,
counted, over_invoice_labour, created_at, corrected_at, corrected_by,
original_description, original_amount_ex` (the last four null until a
correction; `over_invoice_labour` is true when the amount is larger than the
labour its invoice bills on the job).

Work order row fields: `id, job_id, wo_number, kind, status, scope_items,
special_instructions, scheduled_date, site_address, agreed_labour_ex,
approved_at, approved_by, approved_via, sealed_content_hash, origin,
quote_filled_at, quote_filled_scope_revision_id, hand_edited_at, created_at,
updated_at`. `approved_via` is
`session`, `terminal` or `auto` (issued by the system, `approved_by` null).

Each customer variation row (the `customer_variation` of a write,
`customer_variations[]` on the reads): `id, job_id, status, work_order_id,
variation_number, label, description, tasks, hours_total, trade_allocation_ex,
customer_price_ex, created_by, created_at, updated_at, approved_at, approved_by,
approved_via, cancelled_at, cancelled_by, cancel_reason` (`label` only once
approved). Send `updated_at` back as `expected_updated_at`. The staff
`job_work_order` read adds `addenda[]` (see "Customer variations") and
`customer_variations[]` (every status) to its output.

Inputs are the snake_case names in this table only. There are no camelCase or
alternate id spellings on these doors.

What the trade reads in `scope_items`, `special_instructions` and each
addendum's `description` and `scope_items` goes through
the shared trade money filter, which drops decimals and 3+ digit numbers as
possible amounts. Heights and lengths are the work order, so this view alone
keeps three shapes (`projectTradeJobWorkOrder`): a number then a length unit
(`2.1 m`, `1800mm`, `24.5 m2`; units mm, cm, m, lm, m2, sqm, metres), a
dimension run ending in a unit (`6.5 x 4.2 m`), and a number then high, long,
wide, deep, height, length or width (`1800 high`). A number after a currency
sign or before a GST mark is never kept, and every other number stays with the
money filter: `30 m at 45 per m` reads `30 m` without the 45. The filter itself
and the trade quote views are unchanged. Cases:
`job_work_order_trade_measurements_test.ts`.

The filter withholds a whole field when it reads a money word in it (`fee`,
`price`, a rate such as `85/hr`), amount or not. In this view alone a scope
line's text or a special instruction withheld that way reads
`Line withheld. Ask the office for this detail.`
(`TRADE_WORK_ORDER_LINE_WITHHELD`), so the trade sees that a line exists and
can ask; none of the original text or any amount is returned. A field that was
empty, and a price key on a scope item, still return nothing. Follow-up, not
built: office staff are not yet told which lines a trade cannot see, so a line
such as `Tip fee included. Dog on site.` reaches the trade as the placeholder
with no warning on the Ops side. Until then, keep site instructions and money
wording in separate lines.

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
