-- Ship the ladder with L1c's rules (L1c's bodies, as before this migration):
-- a crew assignment text by job number stays unplaced, off the job it is
-- about. The contract must catch it.
-- Registered successors (L1g 20261006035000, L1f 20261006020000, then L1e 20261005170000) are rolled back first, as L1d's down requires.
SELECT coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'),'pg_proc'),'') LIKE 'L1g:%' AS l1g_live \gset
\if :l1g_live
\ir ../../../rollbacks/20261006035000_context_ladder_held_live_job_down.sql
\endif
SELECT coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'),'pg_proc'),'') LIKE 'L1f:%' AS l1f_live \gset
\if :l1f_live
\ir ../../../rollbacks/20261006020000_context_ladder_held_placement_down.sql
\endif
SELECT coalesce(obj_description(to_regprocedure('public.context_ladder_p1a(public.business_events,boolean)'),'pg_proc'),'') LIKE 'L1e:%' AS l1e_live \gset
\if :l1e_live
\ir ../../../rollbacks/20261005170000_context_ladder_writer_job_down.sql
\endif
\ir ../../../rollbacks/20261005090000_context_ladder_internal_text_down.sql
