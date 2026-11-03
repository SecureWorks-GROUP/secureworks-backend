-- Ship the ladder without TP-04 (the bodies as they were before it, with the
-- old case-sensitive spelling NOT IN ('true','1')): a job flagged 1 is no
-- candidate and one flagged "TRUE" is. The contract must catch it.
-- C14 (20261103203000) replaces the two timelines after TP-04: it comes off first.
SELECT coalesce((SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_contact_job_timeline(text,timestamptz,text,text)')),'')
 ='454ced32a1213e2c28d7d41d37263df5' AS c14_live \gset
\if :c14_live
\ir ../../../rollbacks/20261103203000_context_send_party_link_down.sql
\endif
\ir ../../../rollbacks/20261029190000_context_ladder_holding_flag_down.sql
