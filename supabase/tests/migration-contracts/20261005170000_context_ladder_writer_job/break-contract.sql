-- Ship the ladder without L1e (L1d's bodies, as before this migration): a
-- payment record whose writer named its job but no match_method lands on no
-- job. The contract must catch it.
-- A registered successor (L1f 20261006003000) is rolled back first, as L1e's down requires.
SELECT coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'),'pg_proc'),'') LIKE 'L1f:%' AS l1f_live \gset
\if :l1f_live
\ir ../../../rollbacks/20261006003000_context_ladder_held_placement_down.sql
\endif
\ir ../../../rollbacks/20261005170000_context_ladder_writer_job_down.sql
