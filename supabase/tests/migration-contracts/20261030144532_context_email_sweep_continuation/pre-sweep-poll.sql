-- Historical fixture only: exact B-1 poll body for its pinned assertion.
CREATE OR REPLACE FUNCTION public.trigger_context_email_poll() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f jsonb:=public.context_email_reader_flags();
BEGIN
 IF NOT ((f->>'reader')::boolean AND (f->>'schedule')::boolean AND (f->>'program')::boolean) THEN RETURN; END IF;
 PERFORM net.http_post(
  url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/outlook-mail-capture',
  body := jsonb_build_object('mode','poll','actor','cron:outlook-mail-poll'),
  headers := jsonb_build_object('Authorization','Bearer '||public.sw_service_key(),'Content-Type','application/json'),
  timeout_milliseconds := 5000
 );
 BEGIN
  PERFORM public.trigger_context_email_history();
 EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'email_history_tick_failed: %',SQLSTATE;
 END;
END $$;
