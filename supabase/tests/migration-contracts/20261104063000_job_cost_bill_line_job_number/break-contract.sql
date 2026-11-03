-- Break: the cost engine goes back to placing a holding-job or no-job bill line only on Bookkeeping's evidence
-- (this migration's down). The contract must catch the line left off its job.
-- 20261104070000 to 20261104072000 (A6 cost rules) sit on this migration: unwind them first, back to its definition.
SELECT md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true))='366599ce55b0e0430d45ee9e6e04c315' AS test_has_a6_cost_rules \gset
\if :test_has_a6_cost_rules
\ir ../../../rollbacks/20261104072000_job_cost_credit_at_note_ex_gst_down.sql
\ir ../../../rollbacks/20261104071000_job_cost_xero_crew_bill_super_down.sql
\ir ../../../rollbacks/20261104070000_job_cost_follows_ledger_split_lines_down.sql
\endif
\ir ../../../rollbacks/20261104063000_job_cost_bill_line_job_number_down.sql
CREATE OR REPLACE FUNCTION public.job_cost_bill_line_job_id(p_text text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
INSERT INTO public.feature_flags (flag_name, enabled) VALUES ('job_cost_installer_line_job_number_v1', false);
