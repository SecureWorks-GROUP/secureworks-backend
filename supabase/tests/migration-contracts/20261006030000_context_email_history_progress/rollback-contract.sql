-- After the rollback: B-1's tick and status byte for byte, B-1's state check,
-- no progress column, and B-1's poll caller untouched.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trigger_context_email_history()'::regprocedure)<>'a71be49e6ccde7ffbb4a6fc96d27bfdd'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.context_email_history_status()'::regprocedure)<>'bd6e46c2ba40da0bcf7f714fd67b63a8'
 THEN RAISE EXCEPTION 'w7 rollback bodies'; END IF;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.context_email_history_plan'::regclass AND NOT attisdropped
   AND attname IN ('posts_since_progress','last_run_id','last_progress_at','stalled_at','stall_reason','stalls'))
 THEN RAISE EXCEPTION 'w7 rollback left a column'; END IF;
 IF pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname='context_email_history_plan_state_check'
   AND conrelid='public.context_email_history_plan'::regclass)) LIKE '%stalled%'
 THEN RAISE EXCEPTION 'w7 rollback left the stalled state'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.trigger_context_email_poll()'::regprocedure)<>'1430e54e4443b839865d3b4874793e15'
 THEN RAISE EXCEPTION 'w7 rollback touched the poll caller'; END IF;
 IF has_function_privilege('anon','public.trigger_context_email_history()','EXECUTE')
  OR has_function_privilege('service_role','public.trigger_context_email_history()','EXECUTE')
  OR NOT has_function_privilege('service_role','public.context_email_history_status()','EXECUTE')
 THEN RAISE EXCEPTION 'w7 rollback grants'; END IF;
END $$;
