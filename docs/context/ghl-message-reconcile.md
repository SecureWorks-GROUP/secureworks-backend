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
  completes the scan. If those ids would push the saved cursor past
  `record_capture_run`'s 4096-byte limit, the walk steps strictly past that
  millisecond (`boundary_tie_fallbacks`). A scan too big for one run (150
  conversations or 100 s) is continued by the next run. The `watermark` moves
  only when a scan completes. First run: 2 hours back. Longest look-back after
  a pause: 72 hours (`window_capped`); older history is the M4 history load.
- Run rows: `context_capture_runs` via `record_capture_run`, source
  `ghl_message_reconcile`; counts and codes only. `succeeded` = scan complete,
  no issue; `partial` = budget reached or a conversation unreadable or a write
  refused (named in `error_code`); `failed` = stopped (GHL rate limit,
  transport, capture switched off), position and watermark held. A `running`
  row not updated for 10 minutes is closed `run_abandoned` by the next run.
- Idle (no read, no run row) while the flag or the capture lane is off.
- Manual run for a trace: `POST /functions/v1/ghl-message-reconcile` with the
  service key and `{"wait": true}` returns the run summary.
- Status and alarms: `ghl_capture` block of `context_pipeline_status()`
  ([pipeline-status.md](pipeline-status.md)).
