# Recon dispute marker (20261021160000)

CTX-18 is not written down in this repo, in `docs/context`, or on an open issue. The dispute
already in the framework is the ledger item status `disputed`, set by `context_ledger_person_edit`:
an open item is wrong. That is a different question. This marker does not change a ledger item.

A dispute here is a person's statement that a captured message's reconciliation is wrong. A
reconciliation decision stays append-only attribution. The marker is a separate row so it can be
cleared without a new decision action and without putting the message back on the queue.

## Form

`context_recon_disputes` holds one row per `business_events` id.

- `reason`, `disputed_by` and `disputed_at` are all null, or all set.
- `context_recon_set_dispute(event, user id, reason)` is the only writer. The user must be
  `admin`, `owner` or `ops_manager` (42501 `recon_not_staff` otherwise). An unknown message is
  P0002 `recon_subject_not_found`. A reason longer than 600 characters is 22023.
- A null or blank reason clears the three fields. The newest mark replaces the previous one.
  There is no history.
- `disputed_by` is `person:<user id>`, built by the writer.
- No feature flag. The migration writes no row.

The writer locks the message and does not update it, so the hold trigger and the party-roles
trigger do not run. It writes no decision, no ledger item and no invoice. The evidence hash
does not include the marker, so a dispute does not reopen a decision or change who is queued.

## What a reader sees

- `context_recon_dispute(event)` returns the three fields. They are null when there is no row
  or the marker was cleared.
- `context_job_view` adds `dispute_reason`, `dispute_by` and `dispute_at` on each message it
  already shows, and `disputed_messages` counts messages with a current marker.
- `context_recon_health` adds `disputed_open`.

`context_recon_queue` is unchanged. The daily list is not on main (it is the unmerged
`context_recon_daily_list` work). That list selects the queue by column name, and the unmerged
backlog lane adds `lane`. Replacing the queue in this migration would drop `lane` if that lane
lands first. A later change can join `context_recon_disputes` on `event_id`.

Service role only. Rollback is `supabase/rollbacks/20261021160000_context_recon_dispute_down.sql`.
It refuses while any marker is still open.
