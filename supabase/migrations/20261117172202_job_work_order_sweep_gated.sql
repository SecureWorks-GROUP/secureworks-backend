-- P0-06.2: preserve the existing switch, headers and two-minute schedule.
-- Dependencies, including nested SQL readers and group release state:
-- jobs, work_orders, job_assignments, group_work_orders,
-- group_work_order_participants, group_work_order_events, group_work_order_releases,
-- trade_invoices, feature_flags, users, scope_owner_approvals, scope_revisions,
-- scope_job_draft_sets, work_order_variations, group_work_order_shares,
-- trade_invoice_lines, job_client_signoffs, client_signoff_settings,
-- group_client_signoff_policy, group_work_order_time_entries, scope_tool_defaults,
-- job_events (quote-fill retry evidence).
-- autoIssueJobWorkOrders has a three-day lookback, no minimum-age delay.
-- Keep the requested 30-minute heartbeat. sweep_gate_v1 is seeded off.
CREATE OR REPLACE FUNCTION public.trigger_job_work_order_auto_issue()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE tok text; BEGIN
  IF NOT COALESCE((SELECT f.enabled FROM public.feature_flags f
                   WHERE f.flag_name = 'job_work_order_auto_issue_v1' LIMIT 1), false) THEN
    RETURN;
  END IF;
  tok := public.sweep_gate_tables_token(ARRAY[
    'jobs', 'work_orders', 'job_assignments', 'group_work_orders',
    'group_work_order_participants', 'group_work_order_events', 'group_work_order_releases', 'trade_invoices',
    'feature_flags', 'users', 'scope_owner_approvals', 'scope_revisions',
    'scope_job_draft_sets', 'work_order_variations', 'group_work_order_shares', 'trade_invoice_lines',
    'job_client_signoffs', 'client_signoff_settings', 'group_client_signoff_policy', 'group_work_order_time_entries',
    'scope_tool_defaults', 'job_events'
  ]);
  IF NOT public.sweep_gate_should_post('job-work-order-auto-issue', tok, interval '30 minutes') THEN RETURN; END IF;
  PERFORM net.http_post(
    url := 'https://kevgrhcjxspbxgovpmfl.supabase.co/functions/v1/ops-api?action=auto_issue_job_work_orders&gate=job-work-order-auto-issue&gate_token=' || tok,
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
