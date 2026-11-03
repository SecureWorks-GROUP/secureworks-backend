-- Ship the ladder without TP-04 (the bodies as they were before it, with the
-- old case-sensitive spelling NOT IN ('true','1')): a job flagged 1 is no
-- candidate and one flagged "TRUE" is. The contract must catch it.
-- A registered successor (C2 known contacts, 20261104095000) comes off first.
SELECT coalesce((SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.resolve_context_attribution(public.business_events,boolean,boolean)')),'')
 ='f9cd8d311bf00a92f7b708ff2d2dc8a7' AS c2k_successor_live \gset
\if :c2k_successor_live
\ir ../../../rollbacks/20261104095000_context_known_contact_placement_down.sql
\endif
\ir ../../../rollbacks/20261029190000_context_ladder_holding_flag_down.sql
