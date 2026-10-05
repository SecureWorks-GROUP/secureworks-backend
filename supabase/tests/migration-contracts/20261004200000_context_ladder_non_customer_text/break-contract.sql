-- Ship the ladder without the two rules (L1b's bodies, as before this
-- migration): a crew assignment text is placed on the customer's job by its
-- job number. The contract must catch it.
-- Registered successors (L1f 20261005235000, L1e 20261005170000, then L1d 20261005090000) are rolled back first, as L1c's down requires.
SELECT coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'),'pg_proc'),'') LIKE 'L1f:%' AS l1f_live \gset
\if :l1f_live
\ir ../../../rollbacks/20261005235000_context_ladder_held_placement_down.sql
\endif
SELECT coalesce(obj_description(to_regprocedure('public.context_ladder_p1a(public.business_events,boolean)'),'pg_proc'),'') LIKE 'L1e:%' AS l1e_live \gset
\if :l1e_live
\ir ../../../rollbacks/20261005170000_context_ladder_writer_job_down.sql
\endif
SELECT coalesce(obj_description(to_regprocedure('public.context_ladder_p1a(public.business_events,boolean)'),'pg_proc'),'') LIKE 'L1d:%' AS l1d_live \gset
\if :l1d_live
\ir ../../../rollbacks/20261005090000_context_ladder_internal_text_down.sql
\endif
\ir ../../../rollbacks/20261004200000_context_ladder_non_customer_text_down.sql
