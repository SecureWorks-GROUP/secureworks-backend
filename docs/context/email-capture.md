# Email capture: sources, reader, run rows and health (slices EM1, EM2, EM3)

Design: `email.md` (context build plan, rank 4), slice EM1 of INTEGRATION.md
Wave 3E. Migration `supabase/migrations/20260924213000_context_email_capture_config.sql`,
rollback in `supabase/rollbacks/`, contract in
`supabase/tests/migration-contracts/20260924213000_context_email_capture_config/`.

EM1 built configuration and health. EM2 is the reader (edge function
`outlook-mail-capture`) and EM3 its schedule, migration
`supabase/migrations/20261002150000_context_email_reader.sql` (rollback in
`supabase/rollbacks/`, contract in
`supabase/tests/migration-contracts/20261002150000_context_email_reader/`).
See "The reader" below.

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
actor, INTEGRATION X31) and a `monitored_mailbox_changes` receipt. Setting
`status: "pending_review"` without `enabled` also disables the source. An
unchanged request returns `outcome: "unchanged"` without a new receipt or
actor stamp. Adding or
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
keeps nulls in these three new columns. The existing `mailbox` column identifies
which mailbox copy was seen; EM1 reuses it rather than adding another column.

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
those stay in the service-role table. `healthy` means selected with no active
alarms, not proof of a successful poll: while alarms are disabled, even a
never-seen selected source counts as healthy. `never_seen` remains separate;
`oldest_last_seen_at` ignores null sightings.

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

## The reader (EM2) and its schedule (EM3)

Edge function `supabase/functions/outlook-mail-capture` (`capture.ts` the
run, `graph.ts` the Graph reads, `attachments.ts` the attachment store,
`handler.ts` the door). The one row builder is
`supabase/functions/_shared/evidence/outlook_mail.ts`; rows are saved only
through `capture_business_event` and placed by the database ladder. The reader
only reads mail: every Graph call is a GET (`graph_test.ts` pins it); it never
sends, replies, moves, deletes or marks mail read. No model call.

| Flag | Default | Effect |
|---|---|---|
| `email_capture_v2` (EM1) | created off | the program switch; the reader needs it on |
| `email_reader_v1` | off | the reader reads mail only while on (with `email_capture_v2` and the capture lane) |
| `email_reader_schedule_v1` | off | pg_cron `outlook-mail-poll` (every 5 minutes) and `monitor-inbox-sweep` (02:00 Perth) call the reader; the old monitor-inbox path stops writing its own email evidence rows and its group reader (it keeps writing `inbox_events`) |
| `email_reader_history_v1` (B-1, `20261005180000`) | off | the 60-day history load below runs from the `outlook-mail-poll` tick; needs the three flags above |

Modes (body `{"mode", "source", "from", "to", "wait"}`; callers: the service
role, or the server key in `x-api-key`):

| Mode | Reads | Run rows |
|---|---|---|
| `poll` | each selected source since its pair cursor (first run: 30 minutes back; caught up: 10 minutes overlap; backlog: exactly from the cursor) | `outlook_<key>` |
| `sweep` | the last 48 hours of one or all sources; inserts count as `sweep_misses` | `outlook_sweep_<key>` |
| `history` | one source, `[from, to)`, at most 60 days back, `capture_mode: backfill`, only mail that names a live job's number or involves a live job's client email (captain ruling 24 Sep 2026, via `context_email_history_scope()`); a run cut by its time budget resumes on the next call with the same window end (`to`), a group by its conversation walk (W7) | `outlook_history_<key>` |

User mailboxes are read whole (every folder, read or unread, Sent Items
included; Junk, Drafts and Outbox skipped). Groups are read through
conversations, threads and posts; a post's key comes from its internet message
id property, so it and a member's copy are one row. One email is one row keyed
`email:<internet message id>` however many mailboxes saw it.

Attachments: file attachments up to 15 MB each, 10 files and 30 MB per email,
go to the PRIVATE bucket `context-email-attachments`, one row each in
`context_email_attachments` (service role only; `stored` or a `skipped_*`
reason). Inline images, attached emails and links are recorded skipped. ses@
attachments are not stored here (the make-safe intake stores them). No public
URL and no `job_documents` row is made.

Old-path copies (gap plan B-1, `20261005180000`): the old path's rows
(sources `monitor-inbox`, `monitor_inbox`, `monitor-inbox-group`, keys
`graph:<id>` / `graph-group:<id>`) never collide with the reader's key. Before
saving an inbound email the reader calls `context_email_legacy_copy(from,
received_at, subject)`: same sender (`payload.from`, lower case) and the same
Graph received time, or within 2 minutes with the same non-empty subject
(another mailbox's copy). A match is not saved again (`counts.skipped_legacy_copy`);
its attachments still go to the private store, pointed at the old row. Our own
outbound and internal mail is never skipped. An unreadable lookup fails the run
and holds the cursor.

History load (B-1): every 5 minutes, while `email_reader_history_v1` and the
reader's flags are on, `trigger_context_email_poll()` runs one
`trigger_context_email_history()` tick in its own subtransaction. The tick keeps
one `context_email_history_plan` row per selected source with a window fixed at
its first call (that minute less 59 days, to that minute), posts one `history`
call for the first source not yet finished (none while its run is running),
marks a source succeeded when the reader records a `succeeded` run for exactly
that window, and posts nothing once every source is done. On each success it
lists the loaded jobs for reading with
`context_catchup_list_backfill('outlook-mail-capture', since, false, ...)`, the
one re-list for history loads (backfill rows never wake a read). Status:
`context_email_history_status()`.

Progress (W7, `20261006030000`): the tick judges each finished run once; a run
moved when it succeeded or `counts.progressed > 0`. A source with 3 calls since
its last move is `stalled` (reason: the last run's error code, `no_progress`,
or `no_run`), with a database WARNING, and the next source is called at once;
a stalled source is tried again 6 hours later, after pending and loading
sources. There is no call limit (B-1's 288-call give-up is gone). A source
whose window ended more than 59 days ago (left loading or stalled that long) is
given up as `window_expired` with a WARNING rather than called: nothing in its
window is within the reader's 60-day limit any more, and a reset starts a fresh
window. The status
read lists every stalled or given-up source under `attention`, and `finished`
is false while any source is stalled. A group mailbox's history is walked
conversation by conversation, newest first, and every run records where it
stopped in `cursor.group`, so the next run continues there (see the header of
`outlook-mail-capture/capture.ts`). Why: on 5 Oct 2026 the fencing group
re-read its newest 400 conversations every 5 minutes for a day, saved nothing
and held the eight mailboxes behind it. Read-only check:
`scripts/context-email-history-check.sql`; after deploy, a fencing row that B-1
gave up needs `scripts/context-email-history-fencing-reset.sql` (dry run;
running it for real needs the owner's go), undo
`scripts/context-email-history-fencing-reset-undo.sql`.

Not yet built: `inbox_events` sighting rows (the old path still owns that table
until the reader-move slice EM-R1), the tool-send row (EM-TOOL), the legacy
upgrade pass of EM-M3 (b).
