-- No assertions left for what staff see; the case stays so the stack applies this migration.
-- RQ-15.g (20261111100000) extends the money signature this migration pins; unwind it first.
SELECT md5(prosrc) = '7a7798901a26351b8e910da3f1392509' AS rq15g_sig_20261031010000 FROM pg_proc WHERE oid = to_regprocedure('public.context_job_story_money_sig(uuid)') \gset
\if :rq15g_sig_20261031010000
-- 20261114040000 (ruling 17 step 5) sits on v_job_profit after 20261111100000: unwind it first when live.
SELECT strpos(pg_get_viewdef('public.v_job_profit'::regclass, true), 'budget_rev AS (') > 0 AS r17s5_live_20261031010000_contract_0 \gset
\if :r17s5_live_20261031010000_contract_0
\ir ../../../rollbacks/20261114040000_job_profit_expected_from_budget_down.sql
\endif
\ir ../../../rollbacks/20261111100000_job_profit_office_variations_down.sql
\endif
\ir ../../../migrations/20261031010000_context_story_credit_refresh.sql
\if :rq15g_sig_20261031010000
\ir ../20261111100000_job_profit_office_variations/setup.sql
\ir ../../../migrations/20261111100000_job_profit_office_variations.sql
\if :r17s5_live_20261031010000_contract_0
\ir ../../../migrations/20261114040000_job_profit_expected_from_budget.sql
\endif
\endif
