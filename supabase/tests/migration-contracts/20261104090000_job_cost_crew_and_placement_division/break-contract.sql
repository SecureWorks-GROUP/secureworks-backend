-- Break: the cost view goes back to holding no division on crew lines and placements (this migration's down, after
-- the later revenue credit rule's down, which reads this migration's function). The contract must catch it.
-- 20261104123000 (C3 one-job speed-up) sits on the A3 division definitions: unwind it first.
\ir ../../../rollbacks/20261104123000_job_cost_events_faster_same_rows_down.sql
-- 20261111100000 (RQ-15.g office variations) sits on v_job_profit and v_job_revenue_events: when the stack has it,
-- its down runs first.
SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.v_job_profit'::regclass AND attname = 'office_variations_ex' AND NOT attisdropped) AS rq15g_unwind_20261104090000 \gset
\if :rq15g_unwind_20261104090000
-- 20261114040000 (ruling 17 step 5) sits on v_job_profit after 20261111100000: unwind it first when live.
SELECT strpos(pg_get_viewdef('public.v_job_profit'::regclass, true), 'budget_rev AS (') > 0 AS r17s5_live_20261104090000_break_contract_0 \gset
\if :r17s5_live_20261104090000_break_contract_0
\ir ../../../rollbacks/20261114040000_job_profit_expected_from_budget_down.sql
\endif
\ir ../../../rollbacks/20261111100000_job_profit_office_variations_down.sql
\endif
\ir ../../../rollbacks/20261104091000_job_revenue_credit_division_down.sql
\ir ../../../rollbacks/20261104090000_job_cost_crew_and_placement_division_down.sql
