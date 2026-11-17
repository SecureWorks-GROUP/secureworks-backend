-- P2-01.7 successor: restore this proof's original definition before it
-- inspects or rewrites that definition. Existing assertions stay unchanged.
SELECT to_regclass('public.v_job_cost_events_legacy') IS NOT NULL AS p2017_unwind \gset
\if :p2017_unwind
\ir ../../../rollbacks/20261117210402_job_cost_events_from_cost_lines_down.sql
\endif
-- Put the two views back as they were (no company super, group share in
-- other, the advance as labour): the contract must catch it.
\ir ../../../rollbacks/20261030170000_job_labour_employer_oncost_down.sql
