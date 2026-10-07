-- Ship the ladder without L1f (L1e's body, as before this migration): a
-- public-key scope record the reviewed relink put on its job goes to the
-- bucket with the rules on. The contract must catch it.
-- A registered successor (L1g 20261006035000) is rolled back first, as L1f's down requires.
SELECT coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'),'pg_proc'),'') LIKE 'L1g:%' AS l1g_live \gset
\if :l1g_live
\ir ../../../rollbacks/20261006035000_context_ladder_held_live_job_down.sql
\endif
\ir ../../../rollbacks/20261006020000_context_ladder_held_placement_down.sql
