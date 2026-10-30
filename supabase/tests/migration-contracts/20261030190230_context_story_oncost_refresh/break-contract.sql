SELECT to_regprocedure('public.context_job_story_credit_sig(uuid)') IS NOT NULL AS break_has_credit \gset
\if :break_has_credit
\ir ../../../rollbacks/20261031010000_context_story_credit_refresh_down.sql
\endif
\ir ../../../rollbacks/20261030190230_context_story_oncost_refresh_down.sql
