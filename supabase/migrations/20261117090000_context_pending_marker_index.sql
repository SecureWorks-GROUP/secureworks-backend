-- Pending marker index (ticket P0-03, 17 Nov 2026). Paired with secureworks-jarvis PR 312, the context worker's
-- quiet tick: before it claims the pass, each minute the worker reads the one pending_luna row with no job checked
-- last, to see whether anything entered the attribution backlog since its last full scan:
--   SELECT id, attribution_checked_at FROM public.business_events
--    WHERE attribution_status = 'pending_luna' AND job_id IS NULL AND attribution_checked_at IS NOT NULL
--    ORDER BY attribution_checked_at DESC NULLS FIRST LIMIT 1
-- business_events_context_bucket holds every row with no job and does not carry attribution_status, so that read
-- scanned every unplaced row each minute (review of PR 312: 200,000 synthetic no-job rows filtered, empty backlog
-- or one old pending row). This partial index holds only the pending rows, in the read's order, with the id the read
-- returns, so it is answered by an index-only scan that stops at the first row (or finds none) whatever the size of
-- the no-job set. Nothing reads or writes differently: no function, view, grant or data changes.
-- Release order: this migration first, then the worker. Before it, the worker's read is correct but scans.
-- Building it takes a SHARE lock on business_events (writes wait) for one pass over the table; lock_timeout keeps it
-- from queueing behind a long writer.
-- Rollback: supabase/rollbacks/20261117090000_context_pending_marker_index_down.sql.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE INDEX IF NOT EXISTS business_events_pending_luna_marker
  ON public.business_events (attribution_checked_at DESC) INCLUDE (id)
  WHERE job_id IS NULL AND attribution_status = 'pending_luna' AND attribution_checked_at IS NOT NULL;

COMMENT ON INDEX public.business_events_pending_luna_marker IS
  'Pending marker (20261117090000, P0-03): the context worker''s one-row read of the pending_luna row with no job checked last, before it pages the attribution backlog. Index-only, stops at the first row. Read by secureworks-jarvis readPendingMarker.';
