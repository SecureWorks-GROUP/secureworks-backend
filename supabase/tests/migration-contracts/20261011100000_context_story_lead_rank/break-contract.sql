-- Deliberately put the earlier body back (this migration's own rollback: 20261009133000's assembler,
-- open loops ranked oldest first). contract.sql must then fail on its first check: on SWF-261469's
-- shape the 5 Oct install ask leads again over the newer completion complaint.
-- (held messages, 20261012100000, replaced the story read and the packet since: its down goes first,
-- as the story settled notes' refuses while a later story read is live)
SELECT to_regprocedure('public.context_ledger_held_rows(uuid[],timestamptz)') IS NOT NULL AS held_messages_live \gset
\if :held_messages_live
-- The later story-card read changes are reversed only inside this contract's transaction.
SELECT to_regprocedure('public.context_job_story_payment_terms(jsonb)') IS NOT NULL AS story_card_causes_live \gset
\if :story_card_causes_live
-- (held notes, 20261015100000) replaced the judge, the item check, the story's ledger read, the packet and
-- the story since: its down goes first, inside this transaction only.
SELECT to_regprocedure('public.context_ledger_held_cite(uuid,jsonb)') IS NOT NULL AS held_notes_live \gset
\if :held_notes_live
\ir ../../../rollbacks/20261015100000_context_held_notes_down.sql
\endif
\ir ../../../rollbacks/20261014120000_context_story_card_causes_down.sql
\endif
\ir ../../../rollbacks/20261012100000_context_held_messages_down.sql
\endif
-- (the story settled notes, 20261011120000, replaced the assembler and the story read since: its down
-- goes first, as the story lead rank's refuses while a later assembler body is live)
-- (card events, 20261021150000, replaced the record messages, the story meta and the assembler since:
-- its down goes first, as the story settled notes' refuses while a later assembler body is live)
SELECT to_regprocedure('public.context_job_card_events(uuid[])') IS NOT NULL AS card_events_live \gset
\if :card_events_live
\ir ../../../rollbacks/20261021150000_context_job_card_events_down.sql
\endif
SELECT coalesce(obj_description(to_regprocedure('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'), 'pg_proc'), '')
       LIKE '%(story settled notes, 20261011120000)%' AS story_settled_notes_live \gset
\if :story_settled_notes_live
\ir ../../../rollbacks/20261011120000_context_story_settled_notes_down.sql
\endif
\ir ../../../rollbacks/20261011100000_context_story_lead_rank_down.sql
