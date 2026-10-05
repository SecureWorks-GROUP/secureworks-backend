-- Undo scripts/context-email-history-fencing-reset.sql: put the fencing plan
-- row back exactly as the reset printed it under 'before'.
--
-- DRY RUN: ends in ROLLBACK. A real undo is a live-data write and needs the
-- owner's go; then change the final ROLLBACK to COMMIT and nothing else.
--
-- Paste the 'before' fencing_row JSON from the reset's output in place of
-- PASTE_BEFORE_ROW_JSON_HERE below (keep the quotes). The guard refuses while
-- the placeholder is there, when the JSON is not the fencing row, or when the
-- update does not touch exactly one row. Undoing only makes sense before the
-- reader has loaded much under the new window: the rows it saved stay saved
-- (ordinary evidence), the plan row alone goes back.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TEMP TABLE fencing_before ON COMMIT DROP AS
SELECT 'PASTE_BEFORE_ROW_JSON_HERE'::text AS raw;

DO $$
DECLARE raw text; b public.context_email_history_plan; n integer;
BEGIN
 SELECT f.raw INTO raw FROM fencing_before f;
 IF raw='PASTE_BEFORE_ROW_JSON_HERE' THEN RAISE EXCEPTION 'fencing_undo_refused: paste the before row first'; END IF;
 b:=jsonb_populate_record(NULL::public.context_email_history_plan, raw::jsonb);
 IF b.source_key IS DISTINCT FROM 'fencing' THEN RAISE EXCEPTION 'fencing_undo_refused: the pasted row is not fencing''s'; END IF;
 UPDATE public.context_email_history_plan p SET
  state=b.state, posts=b.posts, posts_since_progress=b.posts_since_progress, window_from=b.window_from, window_to=b.window_to,
  replans=b.replans, started_at=b.started_at, last_posted_at=b.last_posted_at, last_run_status=b.last_run_status,
  last_run_id=b.last_run_id, last_progress_at=b.last_progress_at, succeeded_at=b.succeeded_at, gave_up_reason=b.gave_up_reason,
  listed=b.listed, stalled_at=b.stalled_at, stall_reason=b.stall_reason, stalls=b.stalls, updated_at=now()
 WHERE p.source_key='fencing';
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'fencing_undo_refused: expected exactly 1 row, updated %',n; END IF;
END $$;

SELECT 'after undo' AS which, to_jsonb(p) AS fencing_row FROM public.context_email_history_plan p WHERE source_key='fencing';

ROLLBACK;
