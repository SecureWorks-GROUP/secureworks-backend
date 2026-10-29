-- Break: put back the engine without the TP-13 rules (20261020181800's body)
-- and the story book as 20261028190000 wrote it, through this migration's own
-- down file, then put the policy back as shipped, so only the rules are
-- missing. The blind sample must then fail: TP13-11 is missing a materials
-- bill and would publish a margin. (Each rule's own break is in the contract.)
\ir ../../../rollbacks/20261029160000_job_profit_partial_cost_reasons_down.sql
CREATE OR REPLACE FUNCTION public.job_profit_partial_cost_policy()
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_build_object('version', 'tp13-v1', 'po_no_bill_days', 30, 'work_done_no_labour_days', 14,
                            'materials_below_quote_share', 0.6, 'variation_cover_tolerance_ex', 1.00,
                            'holds_margin', jsonb_build_object('materials_below_quote', true, 'ordered_not_billed_over_30_days', false, 'po_no_bill_overdue', false,
                                                               'variation_not_costed', false, 'variation_not_invoiced', true))
$$;
REVOKE ALL ON FUNCTION public.job_profit_partial_cost_policy() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_partial_cost_policy() TO service_role;
