-- 20261104063000 (A4 V8) moved v_job_cost_events and cfo_bill_cost_outcomes_scoped on to production's
-- definitions and then its own: unwind it first, back to the stack's own definitions.
SELECT md5(pg_get_viewdef('public.v_job_cost_events'::regclass))='537d32fdd676ac53fb7625b2e6d2f286' AS test_has_bill_line_job_number \gset
\if :test_has_bill_line_job_number
\ir ../../../rollbacks/20261104063000_job_cost_bill_line_job_number_down.sql
\ir ../20261104063000_job_cost_bill_line_job_number/restore-preimage.sql
\endif
\ir ../../../rollbacks/20261031030000_cfo_bill_credit_outcomes_down.sql
