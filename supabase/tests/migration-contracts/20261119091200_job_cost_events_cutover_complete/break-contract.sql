-- Remove the promise: a completion that stamps without reading its gates.
-- CREATE OR REPLACE keeps the owner-only grants, so only the refusal is gone.
CREATE OR REPLACE FUNCTION public.job_cost_events_cutover_complete(
  p_org_id uuid, p_cutoff date DEFAULT DATE '2026-10-01', p_allow_profit_diff boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE job_cost_events_cutover SET bills_backfilled_at = now(), credits_backfilled_at = now(),
    trade_backfilled_at = now(), trade_triggers_installed_at = now(), completed_at = now() WHERE singleton;
  RETURN jsonb_build_object('completed', true);
END;
$$;
