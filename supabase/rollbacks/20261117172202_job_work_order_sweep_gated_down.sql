-- Restore the original timer helper without changing its schedule.
CREATE OR REPLACE FUNCTION public.trigger_job_work_order_auto_issue()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                   WHERE f.flag_name = 'job_work_order_auto_issue_v1' LIMIT 1), false) THEN
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=auto_issue_job_work_orders',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || public.sw_service_key(),
      'Content-Type', 'application/json',
      'x-sw-actor', 'job-work-order-auto-issue-cron'
    ),
    body := jsonb_build_object('actor', 'job-work-order-auto-issue-cron'),
    timeout_milliseconds := 30000
  );
END $$;
COMMENT ON FUNCTION public.trigger_job_work_order_auto_issue() IS
  'pg_cron job-work-order-auto-issue (every 2 minutes): posts ops-api auto_issue_job_work_orders with the service key while feature flag job_work_order_auto_issue_v1 is on. Otherwise a no-op.';
REVOKE ALL ON FUNCTION public.trigger_job_work_order_auto_issue() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_job_work_order_auto_issue() TO service_role, postgres;
