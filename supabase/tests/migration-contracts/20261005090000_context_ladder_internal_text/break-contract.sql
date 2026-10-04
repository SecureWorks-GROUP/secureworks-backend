-- Ship the ladder with L1c's rules (L1c's bodies, as before this migration):
-- a crew assignment text by job number stays unplaced, off the job it is
-- about. The contract must catch it.
-- A registered successor (L1e 20261005110000) is rolled back first, as L1d's down requires.
SELECT coalesce(obj_description(to_regprocedure('public.context_ladder_p1a(public.business_events,boolean)'),'pg_proc'),'') LIKE 'L1e:%' AS l1e_live \gset
\if :l1e_live
\ir ../../../rollbacks/20261005110000_context_ladder_writer_job_down.sql
\endif
\ir ../../../rollbacks/20261005090000_context_ladder_internal_text_down.sql
