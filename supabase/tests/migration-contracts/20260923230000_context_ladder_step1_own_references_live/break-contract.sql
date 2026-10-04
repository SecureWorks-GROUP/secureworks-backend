-- Restore the legacy step 1 (any invoice number, holding job included). A later
-- registered ladder slice (L1e, then L1d, then L1c, then L1b, then P4, then P1a) is rolled back first, as its down requires.
SELECT coalesce(obj_description(to_regprocedure('public.context_ladder_p1a(public.business_events,boolean)'),'pg_proc'),'') LIKE 'L1e:%' AS l1e_live \gset
\if :l1e_live
\ir ../../../rollbacks/20261005100000_context_ladder_writer_job_down.sql
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
\ir ../../../rollbacks/20260924140000_context_placement_at_time_down.sql
\endif
\ir ../../../rollbacks/20260923230000_context_ladder_step1_own_references_live_down.sql
