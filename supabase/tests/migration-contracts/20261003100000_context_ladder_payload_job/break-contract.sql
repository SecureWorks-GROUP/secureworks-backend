-- Ship the ladder without step 1b (P4's bodies, as before this migration):
-- a contact rule places a row on another job than the one its payload names,
-- and the revision store then refuses it. The contract must catch it. A
-- registered successor (L1c 20261004200000) is rolled back first, as L1b's down requires.
SELECT coalesce(obj_description(to_regprocedure('public.context_ladder_p1a(public.business_events,boolean)'),'pg_proc'),'') LIKE 'L1c:%' AS l1c_live \gset
\if :l1c_live
\ir ../../../rollbacks/20261004200000_context_ladder_non_customer_text_down.sql
\endif
\ir ../../../rollbacks/20261003100000_context_ladder_payload_job_down.sql
