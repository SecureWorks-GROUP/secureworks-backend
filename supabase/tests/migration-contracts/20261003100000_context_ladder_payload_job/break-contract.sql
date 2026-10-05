-- Ship the ladder without step 1b (P4's bodies, as before this migration):
-- a contact rule places a row on another job than the one its payload names,
-- and the revision store then refuses it. The contract must catch it. A
-- registered successors (L1f 20261006003000, L1e 20261005170000, L1d 20261005090000, then L1c 20261004200000) are rolled back first, as L1b's down requires.
SELECT coalesce(obj_description(to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)'),'pg_proc'),'') LIKE 'L1f:%' AS l1f_live \gset
\if :l1f_live
\ir ../../../rollbacks/20261006003000_context_ladder_held_placement_down.sql
\endif
SELECT coalesce(obj_description(to_regprocedure('public.context_ladder_p1a(public.business_events,boolean)'),'pg_proc'),'') LIKE 'L1e:%' AS l1e_live \gset
\if :l1e_live
\ir ../../../rollbacks/20261005170000_context_ladder_writer_job_down.sql
\endif
SELECT coalesce(obj_description(to_regprocedure('public.context_ladder_p1a(public.business_events,boolean)'),'pg_proc'),'') LIKE 'L1d:%' AS l1d_live \gset
\if :l1d_live
\ir ../../../rollbacks/20261005090000_context_ladder_internal_text_down.sql
\endif
SELECT coalesce(obj_description(to_regprocedure('public.context_ladder_p1a(public.business_events,boolean)'),'pg_proc'),'') LIKE 'L1c:%' AS l1c_live \gset
\if :l1c_live
\ir ../../../rollbacks/20261004200000_context_ladder_non_customer_text_down.sql
\endif
\ir ../../../rollbacks/20261003100000_context_ladder_payload_job_down.sql
