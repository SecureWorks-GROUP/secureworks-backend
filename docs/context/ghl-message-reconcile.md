# GHL message reconciler (context slice C1d)

The safety net behind the GHL webhook (design `sms.md` §7 step 9). Every 15
minutes pg_cron job `ghl-message-reconcile` (capture lane) calls
`trigger_ghl_message_reconcile()`, which posts to edge function
`ghl-message-reconcile` with the service key, only while feature flag
`ghl_message_capture_v2` is on. The function reads GHL itself and saves any
text the webhook missed through `_shared/evidence/ghl_message.ts` and
`capture_business_event` (source `ghl-message-reconcile`, `capture_mode:
live`). It never places a row; the ladder does on insert.

- Reads: `ghl-proxy` provider reads `list_recent_ghl_conversations`
  (location-wide, newest first by last message, `start_after_date` epoch ms)
  and `list_ghl_messages`. Read only.
- Window: one scan at a time, kept in the run row's `cursor`: `scan_top`,
  `list_floor` (previous complete scan's top minus 30 minutes),
  `message_floor` (previous scan's list floor, so a conversation that jumped
  above a running scan is read back far enough), `position`
  (`last_message_ms` plus every conversation id fully read at that
  millisecond). A row with no parseable lastMessageDate is counted
  (`conversations_no_date`) and is never fresh; `list_recent_ghl_conversations`
  still returns it. A page with no dated conversation left in the window
  completes the scan. Cursor size is the CHECK
  `octet_length(cursor::text) <= 4096` on jsonb (Postgres prints `: ` and
  `, `, not compact JSON). If the in-timestamp id list would fail that
  CHECK, the walk steps strictly past that millisecond
  (`boundary_tie_fallbacks`) before `record_capture_run`, with a safety
  margin so the write cannot be refused. A scan too big for one run (150
  conversations or 100 s) is continued by the next run. The `watermark` moves
  only when a scan completes. A failed save (writer `error`, e.g. `57014`)
  records its message time in the cursor's `retry_from` (earliest wins), and
  the completed scan moves the watermark only up to that time. The next scan
  extends both floors below the pending retry, even when that is older than 72
  hours (`retry_window_extended`). The retry coordinate clears only after the
  retry window is read fully. A conversation without a usable date, an unreadable
  conversation, a capped or incomplete message read, a missing message identity,
  a precheck or write error, a remaining backlog, or a boundary-tie fallback
  keeps the retry pending. While it remains pending, the run is partial
  (`retry_pending` unless a more specific error applies), even when the scan
  itself reached its top. An unfinished scan carries its incomplete-read marker
  across budget continuations; after that scan finishes, a new clean scan is
  required before clearing the retry. The status projection exposes the latest
  `reconciler.retry_from`. The watermark moves only when the scan completes and
  can step back; it reads as lag until the message is saved.
  First run: 2 hours back. Ordinary look-back after a pause is capped at 72 hours
  (`window_capped`); older history is the M4 history load.
- Run rows: `context_capture_runs` via `record_capture_run`, source
  `ghl_message_reconcile`; counts and codes only. `succeeded` = scan complete,
  no issue and no pending retry; `partial` = budget reached, incomplete retry
  history, a conversation unreadable, a write refused, or a pending retry
  (named in `error_code`); a retained retry is `partial` even when a more
  specific stop code applies. `failed` = stopped with no retained retry (GHL
  rate limit, transport, capture switched off), position and watermark held. A `running`
  row not updated for 10 minutes is closed `run_abandoned` by the next run.
- Idle (no read, no run row) while the flag or the capture lane is off.
- Manual run for a trace: `POST /functions/v1/ghl-message-reconcile` with the
  service key and `{"wait": true}` returns the run summary.
- Status and alarms: `ghl_capture` block of `context_pipeline_status()`
  ([pipeline-status.md](pipeline-status.md)).
