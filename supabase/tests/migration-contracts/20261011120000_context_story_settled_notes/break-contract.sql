-- Deliberately put the earlier bodies back (this migration's own rollback: 20261011100000's
-- assembler, open notes only, oldest first; 20261007010000's story read). contract.sql must then
-- fail on its first check: SWF-261469's shape has no settled list.
-- (person review, 20261018120000) replaced the item check, the write, the assembler and the
-- story's ledger read since: its down goes first, inside this transaction only, while those
-- bodies are still its own (a later down of the item check would no longer match its guard).
SELECT coalesce(obj_description(to_regprocedure('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'), 'pg_proc'), '')
       LIKE '%(person review, 20261018120000)%' AS person_review_live \gset
\if :person_review_live
\ir ../../../rollbacks/20261019120000_context_ledger_person_review_down.sql
\endif
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
\ir ../../../rollbacks/20261011120000_context_story_settled_notes_down.sql
