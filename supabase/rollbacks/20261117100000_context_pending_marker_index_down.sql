-- Undo 20261117100000_context_pending_marker_index: drop the pending marker index. Nothing else was changed.
-- Note: the context worker's quiet-tick read (secureworks-jarvis readPendingMarker) still answers correctly after
-- this, but scans every no-job row of business_events each minute again.
SET LOCAL lock_timeout = '5s';
DROP INDEX IF EXISTS public.business_events_pending_luna_marker;
