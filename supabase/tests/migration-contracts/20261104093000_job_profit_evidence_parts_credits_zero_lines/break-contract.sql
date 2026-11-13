-- Deliberately put back the earlier definitions (the rule before 20261104093000); the contract must then fail.
-- 20261104200500 (A2 credits follow their documents) sits on these functions: unwind it first.
SELECT md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure))='b9114d87ccc74b6171bbb51d92be69b4' AS test_has_a2_credits \gset
\if :test_has_a2_credits
-- 20261111100000 (RQ-15.g office variations) sits on v_job_profit and v_job_revenue_events: when the stack has it,
-- its down runs first.
SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.v_job_profit'::regclass AND attname = 'office_variations_ex' AND NOT attisdropped) AS rq15g_unwind_20261104093000 \gset
\if :rq15g_unwind_20261104093000
-- 20261114040000 (ruling 17 step 5) sits on v_job_profit after 20261111100000: unwind it first when live.
SELECT strpos(pg_get_viewdef('public.v_job_profit'::regclass, true), 'budget_rev AS (') > 0 AS r17s5_live_20261104093000_break_contract_0 \gset
\if :r17s5_live_20261104093000_break_contract_0
\ir ../../../rollbacks/20261114040000_job_profit_expected_from_budget_down.sql
\endif
\ir ../../../rollbacks/20261111100000_job_profit_office_variations_down.sql
\endif
\ir ../../../rollbacks/20261104200500_job_profit_credits_follow_their_documents_down.sql
\endif
\ir ../../../rollbacks/20261104093000_job_profit_evidence_parts_credits_zero_lines_down.sql
