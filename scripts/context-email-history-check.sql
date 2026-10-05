-- Read-only check of the Outlook history load (W7, 20261006030000).
--
-- Run each numbered query on its own (the Supabase SQL connector returns one
-- result set per call). Every query is wrapped in BEGIN READ ONLY ... ROLLBACK
-- and is a plain SELECT: codes, times and counts only, never mail text or
-- addresses. It works before and after the migration (plan rows are read
-- whole as JSON, so the new columns appear once they exist).
--
-- What healthy looks like after deploy:
--   query 1: 20261006030000 is in the ledger.
--   query 2: fencing is loading (or succeeded), posts_since_progress is 0 to
--            2, and last_progress_at moves forward every few minutes. No source
--            is stalled; one that is shows its stall_reason.
--   query 3: each finished fencing run has counts.progressed > 0 and a
--            window_to (the conversation it reached); conversations_read
--            adds up across runs instead of repeating the same 400.
--   query 4: runs_since_progress (the newest finished runs in a row with no
--            move) is 0 or 1, never climbing.
-- What the bug looked like (5 Oct 2026): every run 'partial', inserted 0,
-- window_to null, posts climbing towards 288, and the eight other mailboxes
-- 'pending'.

-- 1. The migration and the flags.
BEGIN READ ONLY;
SELECT
 (SELECT string_agg(version||' '||coalesce(name,''),', ' ORDER BY version COLLATE "C")
    FROM supabase_migrations.schema_migrations WHERE version IN ('20261005180000','20261006030000')) AS ledger,
 (SELECT jsonb_object_agg(flag_name,enabled ORDER BY flag_name COLLATE "C") FROM public.feature_flags
   WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2','email_reader_history_v1')) AS flags,
 (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.trigger_context_email_history()')) AS tick_md5,
 now() AS read_at;
ROLLBACK;

-- 2. The plan, one row per source (tick md5 5bf1f3cb7390cd299c08488315d2a97e
-- is W7's body; a71be49e6ccde7ffbb4a6fc96d27bfdd is B-1's).
BEGIN READ ONLY;
SELECT p.source_key, p.state, p.posts, p.window_from, p.window_to, p.last_run_status, p.last_posted_at,
 to_jsonb(p)->'posts_since_progress' AS posts_since_progress,
 to_jsonb(p)->'last_progress_at' AS last_progress_at,
 to_jsonb(p)->'stall_reason' AS stall_reason,
 to_jsonb(p)->'stalls' AS stalls,
 p.gave_up_reason, p.succeeded_at
FROM public.context_email_history_plan p
ORDER BY p.source_key COLLATE "C";
ROLLBACK;

-- 3. The fencing group mailbox's newest history runs.
BEGIN READ ONLY;
SELECT c.started_at, c.finished_at, c.status, c.error_code, c.window_from, c.window_to,
 c.counts->'progressed' AS progressed, c.counts->'inserted' AS inserted, c.counts->'duplicates' AS duplicates,
 c.counts->'conversations_read' AS conversations_read, c.counts->'conversations_skipped' AS conversations_skipped,
 c.counts->'pages' AS pages, c.cursor->'group'->>'before' AS walk_before, c.cursor->'group'->>'floor' AS walk_floor,
 c.cursor->'group'->'passes' AS walk_passes, c.cursor->>'history_to' AS history_to
FROM public.context_capture_runs c
WHERE c.source='outlook_history_fencing'
ORDER BY c.started_at DESC
LIMIT 12;
ROLLBACK;

-- 4. Fencing in one row: runs of the current window, rows saved, and how many
-- of the newest finished runs in a row moved nothing.
BEGIN READ ONLY;
WITH p AS (SELECT * FROM public.context_email_history_plan WHERE source_key='fencing'),
r AS (
 SELECT c.*, row_number() OVER (ORDER BY c.started_at DESC) AS n,
  (c.status='succeeded' OR coalesce(
   CASE WHEN jsonb_typeof(c.counts->'progressed')='number' THEN (c.counts->>'progressed')::numeric END,
   CASE WHEN jsonb_typeof(c.counts->'inserted')='number' THEN (c.counts->>'inserted')::numeric END,0)>0) AS moved
 FROM public.context_capture_runs c, p
 WHERE c.source='outlook_history_fencing' AND c.status<>'running'
  AND c.cursor->>'history_to'=to_char(p.window_to AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
SELECT (SELECT state FROM p) AS state, (SELECT posts FROM p) AS posts,
 count(*) AS runs_this_window,
 count(*) FILTER (WHERE window_to IS NOT NULL) AS runs_with_cursor,
 coalesce(sum(CASE WHEN jsonb_typeof(counts->'inserted')='number' THEN (counts->>'inserted')::int END),0) AS inserted_total,
 coalesce(min(n) FILTER (WHERE moved),count(*)+1)-1 AS runs_since_progress,
 max(started_at) AS newest_run
FROM r;
ROLLBACK;
