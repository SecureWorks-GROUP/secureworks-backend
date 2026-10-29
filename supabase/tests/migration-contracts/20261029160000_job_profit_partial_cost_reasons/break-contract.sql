-- Break: put back the engine without the TP-13 rules (20261020181800's body,
-- through this migration's own down file) and keep the policy function, so
-- only the rules are missing. The blind sample must then fail: TP13-11 is
-- missing a materials bill and would publish a margin.
\ir ../../../rollbacks/20261029160000_job_profit_partial_cost_reasons_down.sql
CREATE OR REPLACE FUNCTION public.job_profit_partial_cost_policy()
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_build_object('version', 'tp13-v1', 'po_no_bill_days', 30, 'work_done_no_labour_days', 14,
                            'materials_below_quote_share', 0.6, 'variation_cover_tolerance_ex', 1.00)
$$;
GRANT EXECUTE ON FUNCTION public.job_profit_partial_cost_policy() TO service_role;
REVOKE ALL ON FUNCTION public.job_profit_partial_cost_policy() FROM PUBLIC, anon, authenticated;
