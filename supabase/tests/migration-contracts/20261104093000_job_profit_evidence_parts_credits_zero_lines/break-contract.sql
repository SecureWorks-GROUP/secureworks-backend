-- Deliberately put back the earlier definitions (the rule before 20261104093000); the contract must then fail.
-- 20261104200500 (A2 credits follow their documents) sits on these functions: unwind it first.
SELECT md5(pg_get_functiondef('public.job_profit_line_evidence_many(uuid[])'::regprocedure))='b9114d87ccc74b6171bbb51d92be69b4' AS test_has_a2_credits \gset
\if :test_has_a2_credits
\ir ../../../rollbacks/20261104200500_job_profit_credits_follow_their_documents_down.sql
\endif
\ir ../../../rollbacks/20261104093000_job_profit_evidence_parts_credits_zero_lines_down.sql
