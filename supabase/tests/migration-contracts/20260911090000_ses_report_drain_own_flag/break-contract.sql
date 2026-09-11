-- Put back the borrowed make-safe email-polling gate (the 11 Sep incident).
-- contract.sql must then fail: a pending run is not posted while that gate is off.
CREATE OR REPLACE FUNCTION public.trigger_ses_report_trigger_drain() RETURNS void AS $$
DECLARE
  v_run_id uuid;
BEGIN
  IF NOT public.makesafe_cron_enabled() THEN
    RAISE NOTICE 'trigger_ses_report_trigger_drain: cron gate disabled; skipping';
    RETURN;
  END IF;
  v_run_id := public.next_ses_report_trigger_run();
  IF v_run_id IS NULL THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=run_ses_report_trigger',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.sw_service_key(),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('run_id', v_run_id, 'actor', 'ses-report-trigger-drain')
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
   SET search_path = public, pg_temp;
