-- Ship the ladder without L1e (L1d's bodies, as before this migration): a
-- payment record whose writer named its job but no match_method lands on no
-- job. The contract must catch it.
-- Registered successors (L1g 20261006035000, then L1f 20261006020000) are rolled back first, as L1e's down requires.
SELECT coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'),'pg_proc'),'') LIKE 'L1g:%' AS l1g_live \gset
\if :l1g_live
\ir ../../../rollbacks/20261006035000_context_ladder_held_live_job_down.sql
\endif
SELECT coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'),'pg_proc'),'') LIKE 'L1f:%' AS l1f_live \gset
\if :l1f_live
\ir ../../../rollbacks/20261006020000_context_ladder_held_placement_down.sql
\endif
\ir ../../../rollbacks/20261005170000_context_ladder_writer_job_down.sql
