-- P2-01.7 successor: restore this proof's original definition before it
-- inspects or rewrites that definition. Existing assertions stay unchanged.
SELECT to_regclass('public.v_job_cost_events_legacy') IS NOT NULL AS p2017_unwind \gset
\if :p2017_unwind
\ir ../../../rollbacks/20261117210402_job_cost_events_from_cost_lines_down.sql
\endif
-- Break: the cost view and the allocations go back to scanning the crew list and the credit list per line (this
-- migration's down). The contract must catch it.
\ir ../../../rollbacks/20261104123000_job_cost_events_faster_same_rows_down.sql
