-- Restore the legacy step 1 (any invoice number, holding job included). A later
-- registered ladder slice (L1g, then L1f, then L1e, then L1d, then L1c, then L1b, then P4, then P1a) is rolled back first, as its down requires.
-- TP-04 (20261029190000) and unplaced stage 1 (20261014170000) come off first.
\ir ../20261029190000_context_ladder_holding_flag/roll_back_successors.sql
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
SELECT coalesce(obj_description(to_regprocedure('public.context_ladder_p1a(public.business_events,boolean)'),'pg_proc'),'') LIKE 'L1d:%' AS l1d_live \gset
\if :l1d_live
\ir ../../../rollbacks/20261005090000_context_ladder_internal_text_down.sql
\endif
SELECT coalesce(obj_description(to_regprocedure('public.context_ladder_p1a(public.business_events,boolean)'),'pg_proc'),'') LIKE 'L1c:%' AS l1c_live \gset
\if :l1c_live
\ir ../../../rollbacks/20261004200000_context_ladder_non_customer_text_down.sql
\endif
SELECT coalesce(obj_description(to_regprocedure('public.context_ladder_p1a(public.business_events,boolean)'),'pg_proc'),'') LIKE 'L1b:%' AS l1b_live \gset
\if :l1b_live
\ir ../../../rollbacks/20261003100000_context_ladder_payload_job_down.sql
\endif
SELECT to_regprocedure('public.context_ladder_p1a(public.business_events,boolean)') IS NOT NULL AS p4_live \gset
\if :p4_live
\ir ../../../rollbacks/20261002110000_context_unlinked_rules_down.sql
\endif
SELECT to_regprocedure('public.context_contact_jobs_at(text,timestamptz)') IS NOT NULL AS p1a_live \gset
\if :p1a_live
-- Roll back the later daily recheck before the body this proof needs.
SELECT (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_core_status()')) = 'bf6a84ad3b2fdcc0f9f1ba2f253b72a2' AS rc_later_live \gset
\if :rc_later_live
\ir ../../../rollbacks/20261014034549_context_recheck_messages_first_down.sql
\endif
\ir ../../../rollbacks/20260924140000_context_placement_at_time_down.sql
\endif
\ir ../../../rollbacks/20260923230000_context_ladder_step1_own_references_live_down.sql
