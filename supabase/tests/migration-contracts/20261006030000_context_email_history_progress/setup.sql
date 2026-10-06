-- W7 setup. Earlier registered fixtures supply feature_flags, monitored_mailboxes
-- (EM1, 11 selected sources), context_capture_runs (F1b), the email reader
-- (EM2/EM3) and gap plan B-1 (20261005180000: the plan table, the tick and the
-- status read). Prove the starting point is production's: the two B-1 bodies
-- read live on 6 Oct 2026, and none of this migration's columns.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.trigger_context_email_history()')) IS DISTINCT FROM 'a71be49e6ccde7ffbb4a6fc96d27bfdd'
 THEN RAISE EXCEPTION 'w7 setup: the history tick is not B-1''s live body'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_email_history_status()')) IS DISTINCT FROM 'bd6e46c2ba40da0bcf7f714fd67b63a8'
 THEN RAISE EXCEPTION 'w7 setup: the history status is not B-1''s live body'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.context_email_history_plan'::regclass AND attname='posts_since_progress' AND NOT attisdropped)
 THEN RAISE EXCEPTION 'w7 setup: the progress columns already exist'; END IF;
END $$;
