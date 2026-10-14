# Daily placement re-check

Migration `20261014034549_context_recheck_messages_first` changes two function
bodies. It runs no re-check and updates no evidence, flags, budgets or settings.

## Live definition and queue evidence

On 14 October 2026, SELECT-only Supabase `execute_sql` reads returned the live
`pg_get_functiondef` definitions. These are the source of the replacements. Their
`prosrc` is byte-identical to the latest repository definitions:

| Function | Latest migration | Live body MD5 |
| --- | --- | --- |
| `rerun_context_attribution(integer,text)` | `20260924140000` | `c80fea38727a0302b57a1111e6099c1c` |
| `context_core_status()` | `20261013100000` | `07c51159715c91663a1038f01bf6e09c` |

The migration refuses any other pre-image (and accepts its own body on reapply).
Its version was absent from the live migration ledger and the repository when
created with `supabase migration new`.

A fresh census of the existing eligibility predicate found 14,049 rows: 8,487
message/call rows and 5,562 other events. Two SELECT-only 250-row queue projections
using the same snapshot returned **zero messages under the old order and 250
messages under the new order**. This proves selection, not successful placement
or deployed behavior. No production re-check was run.

The priority list is explicit: `client.reply`, `client.sms_in`, `client.sms_out`,
`client.email_in`, `client.email_out`, `client.email_forwarded`,
`supplier.email_in`, `staff.email_internal`, `staff.email_unknown_audience`,
`client.call_logged`, `client.call_complete`, `client.call_initiated`, and
`call.transcript_completed`. These are the message/call event types present in
that eligible census, including legacy call and text types with a null channel.
Current capture producers include `_shared/evidence/ghl_message.ts`,
`ghl-webhook-receiver/handler.ts`, and the email/transcript capture lanes.

Priority uses event type, not channel: the census included 393
`makesafe.reconcile.job_no_email` and 317 `makesafe.reconcile.email_no_job` rows
whose channel was `email`. Other large machine populations included 2,064
`makesafe.intake_cancellation_detected` and 1,485 `makesafe.reconcile.ambiguous`
rows. They must not get message priority just because they describe mail.

No event type is excluded, and no claim is made that every non-message can never
place. Non-message rows remain eligible after messages; a persistent message
backlog can defer them. Inside each priority the existing order is unchanged:
`attribution_checked_at NULLS FIRST, occurred_at, id`. The no-job filter, bucket
or null status filter, contact-scoped form, lane switch, default 250, ceiling
1,000, `FOR UPDATE SKIP LOCKED`, and return count are unchanged. Resting
`unplaced` rows and existing `pending_luna` rows remain excluded.

## Delayed placement must not cancel current follow-ups

The safety check found that **the old function can make an old customer reply
look fresh**. It stores the ladder's new `attributed_at` and leaves capture mode
unchanged. Jarvis main at `1763292d20aac5a0d9d5c19cad48ecbfc3dc9553`,
`src/automation/event-listener.ts`:

- `readLandedWindow` (lines 157–173) reads newly attributed rows as well as newly
  captured ones. `landedPhase` (119–131) recognizes delayed placement.
- `importantEvents` (588–595) admits a placed `client.reply` unless `isHistoryRow`
  (134–137) sees capture mode `backfill` or `relink`.
- The reply cancellation path then cancels pending proposals and nudges on the
  resolved job. An old row with absent mode is not automatically historical.

The new re-check marks a result `capture_mode: relink` when it binds a job OR
queues its first Luna ask. It records the prior mode in `capture_mode_before`
(JSON null if absent) and keeps all other metadata. Existing `backfill`/`relink`
markers are preserved. The live Luna writers preserve metadata, so a later AI
placement keeps this protection.

Stamping happens **after** calling the ladder. Its rules use capture mode to
choose `pending_luna` versus resting `unplaced` for ambiguous candidates; moving
the stamp before that call would silently suppress first asks. A still-bucket
result keeps its original mode so a future first ask remains possible. No new
ask of an undecided row is introduced. This is established from source and live
function definitions and exercised against the real ladder/Luna writer in local
PostgreSQL; no production write was needed or made. The running Jarvis artifact
was not independently observed.

## Status and rollback

`context_core_status().today_pass` returns the same row minus
`attribution_done_at`. The composer publishes that block unchanged.
`context_cadence_status()` does not publish that field and is untouched. The
historical database column remains; nothing starts writing it again. A day with
no pass row still returns JSON null. `bucket_done_at` remains visible.

The down migration restores both exact pre-images and refuses unrelated drift.
It does not undo placements or their historical markers. Merging this backend PR
applies the function changes through the normal deploy lane; the next existing
scheduled re-check uses the new ordering. A hand drain is a separate decision.
