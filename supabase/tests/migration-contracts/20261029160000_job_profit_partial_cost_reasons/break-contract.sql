-- 20261104080000 (expected cost missing) first: its down, then the stack's own v_job_profit back (this break runs in
-- a disposable copy, so nothing is applied again).
SELECT to_regprocedure('public.job_profit_expected_cost_missing(uuid)') IS NOT NULL AS a6x_break_20261029160000 \gset
\if :a6x_break_20261029160000
\ir ../../../rollbacks/20261104080000_job_profit_expected_cost_missing_down.sql
\ir ../20261104080000_job_profit_expected_cost_missing/restore-preimage.sql
\endif
SELECT to_regprocedure('public.context_job_story_credit_sig(uuid)') IS NOT NULL AS break_has_credit \gset
\if :break_has_credit
\ir ../../../rollbacks/20261031010000_context_story_credit_refresh_down.sql
\endif
-- Remove the known later signature extension before exercising TP-13's rollback.
SELECT md5(prosrc)='b2f762db966bf9f3417e759827705be2' AS tp13_break_has_oncost FROM pg_proc WHERE oid='public.context_job_story_money_sig(uuid)'::regprocedure \gset
\if :tp13_break_has_oncost
\ir ../../../rollbacks/20261030190230_context_story_oncost_refresh_down.sql
\endif
-- Break: put back the engine without the TP-13 rules (20261020181800's body)
-- and the story book as 20261028190000 wrote it, through this migration's own
-- down file, then put the policy back as shipped, so only the rules are
-- missing. The blind sample must then fail: TP13-11 is missing a materials
-- bill and would publish a margin. (Each rule's own break is in the contract.)
\ir ../../../rollbacks/20261029160000_job_profit_partial_cost_reasons_down.sql
CREATE OR REPLACE FUNCTION public.job_profit_partial_cost_policy()
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_build_object('version', 'tp13-v1', 'po_no_bill_days', 30, 'work_done_no_labour_days', 14,
                            'materials_below_quote_share', 0.7, 'variation_cover_tolerance_ex', 1.00,
                            'holds_margin', jsonb_build_object('materials_below_quote', true, 'ordered_not_billed_over_30_days', false, 'po_no_bill_overdue', false,
                                                               'variation_not_costed', false, 'variation_not_invoiced', true))
$$;
REVOKE ALL ON FUNCTION public.job_profit_partial_cost_policy() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.job_profit_partial_cost_policy() TO service_role;
