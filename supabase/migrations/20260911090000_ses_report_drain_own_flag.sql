-- Give the SES report drain its own enable flag (CIO, 2026-09-11).
--
-- Live incident 11 Sep: 20260911060000_ses_report_trigger_runs gated the
-- per-minute drain on public.makesafe_cron_enabled(). That gate exists to stop
-- make-safe EMAIL POLLING and Graph traversal starting on a plain db push, and
-- defaults to false. The report drain is not email polling. Borrowing the gate
-- left a real submitted report (SWMS-261399, run f495b5d2) pending with zero
-- attempts for over an hour, and nobody on the ops seat could read the gate.
--
-- This migration:
--   1. adds a single-row public.ses_report_trigger_settings switch (default on)
--      and a public.ses_report_drain_enabled() helper (false if the row is gone);
--   2. replaces the drain so it checks that helper instead of the make-safe
--      gate, with the claim, URL, service-key header and body unchanged;
--   3. adds public.ses_report_drain_cron_runs(), a service-role reader for the
--      drain's recent pg_cron run details, so ops-api can report whether the
--      drain is actually firing without anyone opening the database.

CREATE TABLE IF NOT EXISTS public.ses_report_trigger_settings (
  id            boolean PRIMARY KEY DEFAULT true CHECK (id),  -- single-row guard
  drain_enabled boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text
);

-- DO NOTHING so a re-apply never flips an operator's explicit off back on.
INSERT INTO public.ses_report_trigger_settings (id, drain_enabled, updated_by)
VALUES (true, true, 'migration:20260911090000_ses_report_drain_own_flag')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.ses_report_trigger_settings IS
  'Single-row enable switch for the SES report-submitted drain (ses-report-trigger-drain cron). Independent of makesafe_cron_settings, which gates make-safe email polling only.';

ALTER TABLE public.ses_report_trigger_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ses_report_trigger_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.ses_report_trigger_settings TO service_role, postgres;

CREATE OR REPLACE FUNCTION public.ses_report_drain_enabled() RETURNS boolean AS $$
  SELECT COALESCE(
    (SELECT drain_enabled FROM public.ses_report_trigger_settings WHERE id = true),
    false
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp;

-- Drain: post one runnable row to the ops-api action. Gated on the drain's own
-- flag; the service key door is the same as the make-safe PDF extraction belt.
CREATE OR REPLACE FUNCTION public.trigger_ses_report_trigger_drain() RETURNS void AS $$
DECLARE
  v_run_id uuid;
BEGIN
  IF NOT public.ses_report_drain_enabled() THEN
    RAISE NOTICE 'trigger_ses_report_trigger_drain: drain flag disabled; skipping';
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

-- Recent pg_cron run details for the drain job, newest first. Dynamic SQL and a
-- to_regclass guard so a database without pg_cron (the contract runner, a
-- partial restore) returns an empty set instead of failing.
CREATE OR REPLACE FUNCTION public.ses_report_drain_cron_runs(p_limit integer DEFAULT 5)
RETURNS TABLE (
  status text,
  return_message text,
  start_time timestamptz,
  end_time timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF to_regclass('cron.job') IS NULL OR to_regclass('cron.job_run_details') IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE
    'SELECT d.status::text, d.return_message::text, d.start_time::timestamptz, d.end_time::timestamptz
       FROM cron.job_run_details d
       JOIN cron.job j ON j.jobid = d.jobid
      WHERE j.jobname = $1
      ORDER BY d.start_time DESC NULLS LAST
      LIMIT $2'
    USING 'ses-report-trigger-drain', greatest(1, least(coalesce(p_limit, 5), 20));
END;
$$;

REVOKE ALL ON FUNCTION public.ses_report_drain_enabled() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trigger_ses_report_trigger_drain() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ses_report_drain_cron_runs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ses_report_drain_enabled() TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.trigger_ses_report_trigger_drain() TO service_role, postgres;
GRANT EXECUTE ON FUNCTION public.ses_report_drain_cron_runs(integer) TO service_role, postgres;
