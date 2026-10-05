-- Reset the fencing row of the Outlook history plan, for use AFTER W7
-- (20261006030000) and its outlook-mail-capture are deployed.
--
-- DRY RUN: this file ends in ROLLBACK and changes nothing. Running it for real
-- is a live-data write and needs the owner's go; then change the final
-- ROLLBACK to COMMIT and nothing else. Run scripts/context-email-history-check.sql
-- first and keep its output.
--
-- Why: under B-1 the fencing group mailbox re-read the same newest 400
-- conversations every 5 minutes from 5 Oct 01:32Z and saved nothing, and
-- B-1's 288-call limit marks it gave_up (call_limit) at about 01:30Z on
-- 6 Oct, after which it is never loaded. Its window also starts 2026-08-07
-- 01:32Z, past the reader's 60-day limit. The reset puts it back to pending
-- with no window, so the next tick fixes a fresh 59-day window and the W7
-- reader walks it from the newest conversation down, saving where it stopped
-- after every run. If the row is still 'loading' when W7 deploys, W7 picks it
-- up without a reset (the tick moves the window and the reader starts a
-- fresh walk); the reset is then optional and only clears B-1's call count.
--
-- What it changes, on exactly one row (source_key 'fencing'): state pending,
-- posts 0, posts_since_progress 0, window_from and window_to null, and the
-- last run, give-up and stall fields cleared. It keeps started_at (the
-- re-list of loaded jobs reads from it), replans and stalls (history), and
-- listed. No run row, evidence row or other plan row is touched.
--
-- Guards (each refuses, writing nothing): W7 is not applied; the fencing row
-- is missing or succeeded; a fencing history run is running now; the update
-- does not touch exactly one row.
--
-- Undo: scripts/context-email-history-fencing-reset-undo.sql, with the
-- "before" row this script prints pasted into it.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE st text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.context_email_history_plan'::regclass
   AND attname='posts_since_progress' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'fencing_reset_refused: W7 (20261006030000) is not applied'; END IF;
 SELECT state INTO st FROM public.context_email_history_plan WHERE source_key='fencing' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'fencing_reset_refused: no fencing plan row'; END IF;
 IF st NOT IN ('loading','gave_up','stalled','pending') THEN
  RAISE EXCEPTION 'fencing_reset_refused: fencing is %; nothing to reset',st;
 END IF;
 IF EXISTS(SELECT 1 FROM public.context_capture_runs WHERE source='outlook_history_fencing'
   AND status='running' AND updated_at>now()-interval '10 minutes')
 THEN RAISE EXCEPTION 'fencing_reset_refused: a fencing history run is running; try after it ends'; END IF;
END $$;

-- The row before (keep this output: the undo needs it).
SELECT 'before' AS which, to_jsonb(p) AS fencing_row FROM public.context_email_history_plan p WHERE source_key='fencing';

DO $$
DECLARE n integer;
BEGIN
 UPDATE public.context_email_history_plan SET
  state='pending', posts=0, posts_since_progress=0, window_from=NULL, window_to=NULL,
  last_run_status=NULL, last_run_id=NULL, last_progress_at=NULL, succeeded_at=NULL,
  gave_up_reason=NULL, stalled_at=NULL, stall_reason=NULL, updated_at=now()
 WHERE source_key='fencing' AND state IN ('loading','gave_up','stalled','pending');
 GET DIAGNOSTICS n = ROW_COUNT;
 IF n<>1 THEN RAISE EXCEPTION 'fencing_reset_refused: expected exactly 1 row, updated %',n; END IF;
END $$;

-- The row after.
SELECT 'after' AS which, to_jsonb(p) AS fencing_row FROM public.context_email_history_plan p WHERE source_key='fencing';

ROLLBACK;
