-- 20261104070000 to 20261104072000 (A6 cost rules) sit on 20261104063000 (A4 V8): unwind them first, back to the
-- A4 V8 definition, then A4 V8 below.
SELECT md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true))='366599ce55b0e0430d45ee9e6e04c315' AS test_has_a6_cost_rules \gset
\if :test_has_a6_cost_rules
\ir ../../../rollbacks/20261104072000_job_cost_credit_at_note_ex_gst_down.sql
\ir ../../../rollbacks/20261104071000_job_cost_xero_crew_bill_super_down.sql
\ir ../../../rollbacks/20261104070000_job_cost_follows_ledger_split_lines_down.sql
\endif
-- 20261104063000 (A4 V8) moved v_job_cost_events and cfo_bill_cost_outcomes_scoped on to production's
-- definitions and then its own: unwind it first, back to the stack's own definitions.
SELECT md5(pg_get_viewdef('public.v_job_cost_events'::regclass))='537d32fdd676ac53fb7625b2e6d2f286' AS test_has_bill_line_job_number \gset
\if :test_has_bill_line_job_number
\ir ../../../rollbacks/20261104063000_job_cost_bill_line_job_number_down.sql
\ir ../20261104063000_job_cost_bill_line_job_number/restore-preimage.sql
\endif
\ir ../../../rollbacks/20261031030000_cfo_bill_credit_outcomes_down.sql
