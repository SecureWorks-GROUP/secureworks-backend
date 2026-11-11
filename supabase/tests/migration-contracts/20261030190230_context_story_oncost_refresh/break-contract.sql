-- 20261111100000 (RQ-15.g office variations) also extends context_job_story_money_sig: when the stack has it, it
-- is taken off first so the money signature downs below find the body they pin, and put back at the end.
SELECT md5(prosrc) = '7a7798901a26351b8e910da3f1392509' AS rq15g_sig_break_20261030190230 FROM pg_proc WHERE oid = to_regprocedure('public.context_job_story_money_sig(uuid)') \gset
\if :rq15g_sig_break_20261030190230
\ir ../../../rollbacks/20261111100000_job_profit_office_variations_down.sql
\endif
SELECT to_regprocedure('public.context_job_story_credit_sig(uuid)') IS NOT NULL AS break_has_credit \gset
\if :break_has_credit
\ir ../../../rollbacks/20261031010000_context_story_credit_refresh_down.sql
\endif
\ir ../../../rollbacks/20261030190230_context_story_oncost_refresh_down.sql
