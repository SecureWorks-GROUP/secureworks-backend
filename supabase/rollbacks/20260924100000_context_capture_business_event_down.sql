-- Rollback of 20260924100000_context_capture_business_event (slice C1a).
-- Redeploy the previous ghl-proxy FIRST: the C1a ghl-proxy send_sms saves its
-- text through this function, and without it that evidence write reports an
-- error (the text itself still sends). Rows already written stay.
-- Refuses unless the function is exactly the C1a body, so a later change to it
-- is never dropped unread.
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE live_md5 text;
BEGIN
 SELECT md5(p.prosrc) INTO live_md5 FROM pg_proc p WHERE p.oid=to_regprocedure('public.capture_business_event(jsonb)');
 IF live_md5 IS NOT NULL AND live_md5<>'4819869e6dcc40d5cd19a7eba295392c' THEN
  RAISE EXCEPTION 'capture_business_event_rollback_mismatch: md5 % is not the C1a body; read it before dropping',live_md5;
 END IF;
END $guard$;
DROP FUNCTION IF EXISTS public.capture_business_event(jsonb);
