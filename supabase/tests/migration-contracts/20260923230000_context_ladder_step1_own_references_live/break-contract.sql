-- Restore the legacy step 1 (any invoice number, holding job included). A later
-- registered ladder slice (P1a) is rolled back first, as its down requires.
SELECT to_regprocedure('public.context_contact_jobs_at(text,timestamptz)') IS NOT NULL AS p1a_live \gset
\if :p1a_live
\ir ../../../rollbacks/20260924140000_context_placement_at_time_down.sql
\endif
\ir ../../../rollbacks/20260923230000_context_ladder_step1_own_references_live_down.sql
