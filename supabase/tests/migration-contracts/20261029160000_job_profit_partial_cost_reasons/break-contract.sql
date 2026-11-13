-- 20261104080000 (expected cost missing) first: its down, then the stack's own v_job_profit back (this break runs in
-- a disposable copy, so nothing is applied again).
-- 20261104110000 (patio bound revision) sits on top of it: when the stack has it, its down runs first.
-- 20261104200500 (A2 credits follow their documents) sits on top of 20261104110000: when the stack has it, its down
-- runs first.
SELECT md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure))='b9114d87ccc74b6171bbb51d92be69b4' AS a2c_break_20261029160000 \gset
\if :a2c_break_20261029160000
-- 20261111100000 (RQ-15.g office variations) sits on v_job_profit and v_job_revenue_events: when the stack has it,
-- its down runs first.
SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.v_job_profit'::regclass AND attname = 'office_variations_ex' AND NOT attisdropped) AS rq15g_unwind_20261029160000 \gset
\if :rq15g_unwind_20261029160000
-- 20261114040000 (ruling 17 step 5) sits on v_job_profit after 20261111100000: unwind it first when live.
SELECT strpos(pg_get_viewdef('public.v_job_profit'::regclass, true), 'budget_rev AS (') > 0 AS r17s5_live_20261029160000_break_contract_0 \gset
\if :r17s5_live_20261029160000_break_contract_0
\ir ../../../rollbacks/20261114040000_job_profit_expected_from_budget_down.sql
\endif
\ir ../../../rollbacks/20261111100000_job_profit_office_variations_down.sql
\endif
\ir ../../../rollbacks/20261104200500_job_profit_credits_follow_their_documents_down.sql
\endif
SELECT to_regclass('public.v_job_profit_patio_scope_binding') IS NOT NULL AS a6p_break_20261029160000 \gset
\if :a6p_break_20261029160000
\ir ../../../rollbacks/20261104110000_job_profit_patio_bound_revision_down.sql
\endif
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
