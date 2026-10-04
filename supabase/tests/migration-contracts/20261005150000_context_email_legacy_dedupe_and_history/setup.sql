-- Gap plan B-1 setup. Earlier registered fixtures supply business_events,
-- jobs, feature_flags, monitored_mailboxes (EM1, 11 selected sources),
-- context_capture_runs (F1b), the email reader (EM2/EM3, 20261002150000) and
-- the catch-up list with mode and scope (20261004100000). Prove the starting
-- point is production's: EM3's poll caller and no history flag.
DO $$
DECLARE live text;
BEGIN
 SELECT md5(prosrc) INTO live FROM pg_proc WHERE oid=to_regprocedure('public.trigger_context_email_poll()');
 IF live IS DISTINCT FROM '7681b900e3be69c8df1d935f85fbde0a' THEN RAISE EXCEPTION 'b1 setup: poll caller is not EM3''s (%)',live; END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_reader_history_v1') THEN RAISE EXCEPTION 'b1 setup: history flag exists'; END IF;
 IF to_regclass('public.context_email_history_plan') IS NOT NULL OR to_regprocedure('public.context_email_legacy_copy(text,timestamptz,text)') IS NOT NULL
 THEN RAISE EXCEPTION 'b1 setup: a new object already exists'; END IF;
END $$;
