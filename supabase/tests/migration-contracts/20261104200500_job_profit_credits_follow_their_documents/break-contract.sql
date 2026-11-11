-- 20261111100000 (RQ-15.g office variations) sits on v_job_profit and v_job_revenue_events: when the stack has it,
-- its down runs first.
SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.v_job_profit'::regclass AND attname = 'office_variations_ex' AND NOT attisdropped) AS rq15g_unwind_20261104200500 \gset
\if :rq15g_unwind_20261104200500
\ir ../../../rollbacks/20261111100000_job_profit_office_variations_down.sql
\endif
-- Deliberately put back the earlier definitions (this migration's down); the contract must then fail.
\ir ../../../rollbacks/20261104200500_job_profit_credits_follow_their_documents_down.sql
