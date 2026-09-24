# Email capture: sources, run rows and health (slice EM1)

Design: `email.md` (context build plan, rank 4), slice EM1 of INTEGRATION.md
Wave 3E. Migration `supabase/migrations/20260924213000_context_email_capture_config.sql`,
rollback in `supabase/rollbacks/`, contract in
`supabase/tests/migration-contracts/20260924213000_context_email_capture_config/`.

EM1 builds configuration and health only. Flag `email_capture_v2` is off and
no code reads mail differently. The new poller (`pollV2`, sweep and history
modes) is EM2.

## Sources: `monitored_mailboxes`

The table already existed in production as the empty 2 May T7 draft
(ledger `20260503063735`); EM1 builds on it. One row per Outlook source,
unique by `email`.

| Column | Meaning |
|---|---|
| `source_key` | names the source's run rows (below) |
| `kind` | `user`, `group`, or `unknown` (not yet located) |
| `enabled`, `status` | selected only when `enabled` and `status = 'active'`; enabling needs `active`; `unknown` stays `pending_review`; `enabled` defaults to false |
| `scope_label` | owner, admin, finance, sales, patios, fencing, ops, other, and (EM1) approvals, ses |
| `owner_privacy` | human-sent outbound mail is captured only with job evidence (D-EM3). marnin@, jan@ |
| `files_supplier_pdfs` | supplier PDF filing allowed (email.md §7 step 8). The five mailboxes the old path already files for |

Seed (captain, 24 Sep 2026): user mailboxes marnin@, jan@, nithin@, shaun@,
admin@, khairo@; groups patios@, fencing@, finance@, approvals@ (Plans and
Approvals), ses@; all enabled. info@, sales@, plans@ are `unknown`,
disabled and `pending_review` until located (email.md P1, gate
G-EM-MAILBOX). All `@secureworkswa.com.au`.

Writers: the migration seed, then only `set_monitored_mailbox()`, reached
through ops-api `POST ?action=set_monitored_mailbox`
`{email, enabled?, status?, reason}` (server key or a company admin or
owner). It changes `enabled` and `status` only, records `updated_by` (the
actor, INTEGRATION X31) and a `monitored_mailbox_changes` receipt. Adding or
removing a source is a migration. Both tables: RLS on, every grant revoked
from PUBLIC, anon and authenticated (the draft's `authenticated_select`
policy dropped); service_role reads. The draft's other columns
(`poll_interval_seconds`, `graph_*`, `last_message_at`, `last_error*`,
`privacy_classification`) are kept and not read by EM code.

## The old path

The old monitor-inbox path polls its pinned list only
(`supabase/functions/monitor-inbox/legacy_mailboxes.ts`: the five user
mailboxes and patios@, fencing@) and never reads `monitored_mailboxes`. Before
EM1 it switched to that table whenever it had enabled rows; EM1 drops the
draft's `last_polled_at` (the cursor lives in `context_capture_runs`), so that
old query is refused even by the previously deployed code. The contract runs the query and requires the
refusal (named row E22).

## Sightings: `inbox_events`

EM1 adds `business_event_id` (the one evidence row this mailbox copy is, FK
`ON DELETE SET NULL`), `provider_message_id` (`email:<internet id>` or
`graph:<mailbox>:<immutable id>`) and `folder_kind` (`inbox`, `sent`,
`deleted`, `other`, `group`). Only EM2's poller writes them; every existing row
keeps nulls.

## Run rows (contract for EM2 and EM3)

Written only through `record_capture_run()` into `context_capture_runs`.

| Run | `source` |
|---|---|
| 5-minute poll | `outlook_<source_key>` |
| 02:00 Perth sweep, one per source | `outlook_sweep_<source_key>` |
| history run | `outlook_history_<source_key>` |

- `succeeded`: the source finished. `partial`: cut short (time budget,
  throttling); the run did not finish. `failed`: an error, with `error_code`.
- A poll with pages left sets `cursor.backlog = true`.
- A sweep puts the messages the poll missed in `counts.sweep_misses`.
- The pair cursor is `(window_to, window_end_id)` (F1b).
- Counts and codes only, never message text.

## Health: `email_capture` status block

`context_email_capture_status()` (and `context_email_capture_status_at(p_now)`
for a fixed clock) is read by the staff-wide pipeline status, so it never
names a mailbox. It reports `lines`: one per shared `scope_label` (admin,
approvals, fencing, finance, patios, ses) and one combined `personal` line for
the owner, sales, ops and other labels. Each line has counts (`sources`,
`selected`, `pending_review`, `healthy`, `erroring`, `never_seen`) and
`oldest_last_seen_at` (the oldest last successful poll among its selected
sources). No address, source key, run-row name or privacy setting appears;
those stay in the service-role table.

Alarms are raised only while the flag and the capture lane are on, for
selected sources (enabled and `active`), and are reported per line and key
with the number of sources raising them, never which one:

| Alarm | When |
|---|---|
| `email_source_error` | a source's last 2 finished polls failed (the line's distinct `error_codes` are listed) |
| `email_backlog` | a source's last 3 finished polls all left pages behind |
| `email_poll_missed` | a source's latest sweep that finished in the last 26 hours has `sweep_misses > 0` (summed per line) |
| `sweep_incomplete` | from 03:00 Perth, a source has no sweep started at or after 02:00 Perth that succeeded (not expected on the night the flag or the source was switched on) |

Thresholds and the personal labels are published in the block's `policy`
(`context_email_capture_policy()`, changed only by migration).
