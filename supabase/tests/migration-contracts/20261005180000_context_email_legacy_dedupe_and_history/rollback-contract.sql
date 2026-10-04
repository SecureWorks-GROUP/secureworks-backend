-- After the rollback: EM3's poll caller byte for byte, no B-1 object, no
-- history flag, the reader's own flags and objects untouched.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trigger_context_email_poll()'::regprocedure)<>'7681b900e3be69c8df1d935f85fbde0a'
 THEN RAISE EXCEPTION 'b1 rollback poll body'; END IF;
 IF to_regclass('public.context_email_history_plan') IS NOT NULL THEN RAISE EXCEPTION 'b1 rollback left the plan'; END IF;
 IF to_regprocedure('public.context_email_legacy_copy(text,timestamptz,text)') IS NOT NULL
  OR to_regprocedure('public.context_catchup_list_backfill(text,timestamptz,boolean,integer,integer)') IS NOT NULL
  OR to_regprocedure('public.trigger_context_email_history()') IS NOT NULL
  OR to_regprocedure('public.context_email_history_status()') IS NOT NULL
 THEN RAISE EXCEPTION 'b1 rollback left a function'; END IF;
 IF EXISTS(SELECT 1 FROM public.feature_flags WHERE flag_name='email_reader_history_v1') THEN RAISE EXCEPTION 'b1 rollback left the flag'; END IF;
 IF (SELECT count(*) FROM public.feature_flags WHERE flag_name IN ('email_reader_v1','email_reader_schedule_v1','email_capture_v2'))<>3
  OR to_regclass('public.context_email_attachments') IS NULL OR to_regprocedure('public.context_email_reader_flags()') IS NULL
 THEN RAISE EXCEPTION 'b1 rollback touched the reader'; END IF;
END $$;
