-- Roll back C1d (20260924133000_context_ghl_message_reconcile).
--
-- Unschedules the ghl-message-reconcile cron job, restores the F1 stub of
-- context_ghl_capture_status() (with its comment, which F1's own rollback
-- checks) and the two-row automation_switch_cron_lanes(), and drops the three
-- functions C1d added. Byte-for-byte restores are checked by md5 afterwards:
--   context_ghl_capture_status()    155104bfb08b8b3c2f98bdec089d4ee4
--   automation_switch_cron_lanes()  e67b1b27f41133154915f3666421f475
-- No data is touched: context_capture_runs rows and business_events rows the
-- reconciler saved stay. Refuses if a later slice has already replaced the
-- ghl_capture block (roll that slice back first). Redeploying the edge
-- function is not needed: it is idle while the flag is off, and without the
-- cron job nothing calls it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_ghl_capture_status()')) NOT IN ('c2a1df7fe3cbc405f552c0bf2268f5ed','155104bfb08b8b3c2f98bdec089d4ee4')
 THEN RAISE EXCEPTION 'c1d_rollback_refused: context_ghl_capture_status is no longer the C1d body; roll back its later owner first'; END IF;
 IF to_regclass('cron.job') IS NOT NULL THEN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname='ghl-message-reconcile';
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.context_ghl_capture_status() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT NULL::jsonb $$;
COMMENT ON FUNCTION public.context_ghl_capture_status() IS
 'F1 stub. Status block ghl_capture, owned by sms slice C1d, which replaces this body. Null means not built yet.';
REVOKE ALL ON FUNCTION public.context_ghl_capture_status() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.context_ghl_capture_status() TO service_role;

CREATE OR REPLACE FUNCTION public.automation_switch_cron_lanes()
RETURNS TABLE (cron_jobname text, lane text)
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT * FROM (VALUES
    -- capture: pollers that write evidence rows into business_events
    ('monitor-inbox-poll', 'capture'),
    -- attribution: the contact match the ladder resolves a job through
    ('contact-matching',   'attribution')
  ) AS t(cron_jobname, lane);
$fn$;

DROP FUNCTION IF EXISTS public.trigger_ghl_message_reconcile();
DROP FUNCTION IF EXISTS public.context_ghl_item_flag();
DROP FUNCTION IF EXISTS public.context_ghl_capture_policy();

DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_ghl_capture_status()')) IS DISTINCT FROM '155104bfb08b8b3c2f98bdec089d4ee4'
  OR (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.automation_switch_cron_lanes()')) IS DISTINCT FROM 'e67b1b27f41133154915f3666421f475'
 THEN RAISE EXCEPTION 'c1d_rollback_check_failed: restored bodies differ from the production pre-image'; END IF;
END $$;
