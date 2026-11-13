-- 20261104070000 to 20261104072000 (A6 cost rules) sit on 20261104063000 (A4 V8): unwind them first, back to the
-- A4 V8 definition, then A4 V8 below.
-- 20261104090000 and 20261104091000 (A3 division) sit on the A6 cost rules: unwind them first.
-- 20261104123000 (C3 one-job speed-up) sits on the A3 division definitions: unwind it first.
SELECT md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true))='b48997c55913ce3c90e3a3c947533fd3' AS test_has_c3_fast \gset
\if :test_has_c3_fast
\ir ../../../rollbacks/20261104123000_job_cost_events_faster_same_rows_down.sql
\endif
SELECT md5(pg_get_viewdef('public.v_job_cost_events'::regclass, true))='abdc05a69d139d79aebbb8a3cebfae03' AS test_has_a3_division \gset
\if :test_has_a3_division
-- 20261111100000 (RQ-15.g office variations) sits on v_job_profit and v_job_revenue_events: when the stack has it,
-- its down runs first.
SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.v_job_profit'::regclass AND attname = 'office_variations_ex' AND NOT attisdropped) AS rq15g_unwind_20261031020000 \gset
\if :rq15g_unwind_20261031020000
-- 20261114040000 (ruling 17 step 5) sits on v_job_profit after 20261111100000: unwind it first when live.
SELECT strpos(pg_get_viewdef('public.v_job_profit'::regclass, true), 'budget_rev AS (') > 0 AS r17s5_live_20261031020000_break_contract_0 \gset
\if :r17s5_live_20261031020000_break_contract_0
\ir ../../../rollbacks/20261114040000_job_profit_expected_from_budget_down.sql
\endif
\ir ../../../rollbacks/20261111100000_job_profit_office_variations_down.sql
\endif
\ir ../../../rollbacks/20261104091000_job_revenue_credit_division_down.sql
\ir ../../../rollbacks/20261104090000_job_cost_crew_and_placement_division_down.sql
\endif
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
\ir ../../../rollbacks/20261031020000_job_credit_labour_composition_down.sql
