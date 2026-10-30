-- Deliberately put the earlier bodies back (this migration's own rollback: 20261011100000's
-- assembler, open notes only, oldest first; 20261007010000's story read). contract.sql must then
-- fail on its first check: SWF-261469's shape has no settled list.
-- (held messages, 20261012100000, replaced the story read and the packet since: its down goes first,
-- as the story settled notes' refuses while a later story read is live)
SELECT to_regprocedure('public.context_ledger_held_rows(uuid[],timestamptz)') IS NOT NULL AS held_messages_live \gset
\if :held_messages_live
-- The later story-card read changes are reversed only inside this contract's transaction.
SELECT to_regprocedure('public.context_job_story_payment_terms(jsonb)') IS NOT NULL AS story_card_causes_live \gset
\if :story_card_causes_live
-- (held notes, 20261015100000) replaced the judge, the item check, the story's ledger read, the packet and
-- the story since: its down goes first, inside this transaction only.
SELECT to_regprocedure('public.context_ledger_placement_state(uuid)') IS NOT NULL AS placement_freshness_live \gset
\if :placement_freshness_live
-- Unwind the current metadata/review successor before testing an earlier body.
SELECT to_regprocedure('public.context_ledger_event_locations(public.business_events)') IS NOT NULL AS has_offjob_placement_successor \gset
\if :has_offjob_placement_successor
\ir ../../../rollbacks/20261030165500_context_offjob_person_placement_down.sql
\endif
\ir ../../../rollbacks/20261030161813_context_placement_freshness_down.sql
\endif
SELECT to_regprocedure('public.context_ledger_held_cite(uuid,jsonb)') IS NOT NULL AS held_notes_live \gset
\if :held_notes_live
\ir ../../../rollbacks/20261015100000_context_held_notes_down.sql
\endif
-- Reverse the later reader projection before the historical reader bodies, within this test's transaction.
SELECT to_regprocedure('public.context_ledger_reader_events(uuid[])') IS NOT NULL AS reader_person_placement_live \gset
\if :reader_person_placement_live
SELECT coalesce(obj_description('public.context_job_record_messages(uuid[],timestamptz)'::regprocedure,'pg_proc'),'') LIKE '%staff placement identity (20261030170545)%' AS has_staff_identity_successor \gset
\if :has_staff_identity_successor
\ir ../../../rollbacks/20261030170545_context_staff_placement_identity_down.sql
\endif
\ir ../../../rollbacks/20261030154917_context_ledger_person_placement_down.sql
\endif
\ir ../../../rollbacks/20261014120000_context_story_card_causes_down.sql
\endif
\ir ../../../rollbacks/20261012100000_context_held_messages_down.sql
\endif
-- (card events, 20261021150000, replaced the record messages, the story meta and the assembler since:
-- its down goes first, inside this transaction only)
SELECT to_regprocedure('public.context_job_card_events(uuid[])') IS NOT NULL AS card_events_live \gset
\if :card_events_live
-- Unwind the current metadata/review successor before testing an earlier body.
SELECT to_regprocedure('public.context_ledger_event_locations(public.business_events)') IS NOT NULL AS has_offjob_placement_successor \gset
\if :has_offjob_placement_successor
\ir ../../../rollbacks/20261030165500_context_offjob_person_placement_down.sql
\endif
\ir ../../../rollbacks/20261027140000_context_cost_check_person_splits_down.sql
SELECT coalesce(obj_description('public.context_job_record_messages(uuid[],timestamptz)'::regprocedure,'pg_proc'),'') LIKE '%staff placement identity (20261030170545)%' AS has_staff_identity_successor \gset
\if :has_staff_identity_successor
\ir ../../../rollbacks/20261030170545_context_staff_placement_identity_down.sql
\endif
-- Unwind the later invoice-matter grouping before exercising this historical assembler.
SELECT md5(prosrc)='ddab6cd2bf43ecf5c88fcf03b7ba0374' AS has_invoice_matter_successor FROM pg_proc WHERE oid='public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'::regprocedure \gset
\if :has_invoice_matter_successor
\ir ../../../rollbacks/20261030182500_context_invoice_matter_identity_down.sql
\endif
\ir ../../../rollbacks/20261021150000_context_job_card_events_down.sql
\endif
\ir ../../../rollbacks/20261011120000_context_story_settled_notes_down.sql
