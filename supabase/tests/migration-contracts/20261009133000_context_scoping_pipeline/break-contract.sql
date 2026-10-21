-- Deliberately put the earlier bodies back (this migration's own rollback: the lead rule, the judge,
-- the record loops and the assembler as 20261007010000 left them, the due list as 20261006013000 left
-- it, and the window function dropped). contract.sql must then fail on its first check, the rule as
-- of Wed 7 Oct 2026 10:00 Perth, which reads only a function that exists before this migration: a
-- draft is never monitored by the earlier rule's live set and every lead has 28 days.
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
SELECT coalesce(obj_description(to_regprocedure('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'), 'pg_proc'), '')
       LIKE '%(story settled notes, 20261011120000)%' AS story_settled_notes_live \gset
\if :story_settled_notes_live
\ir ../../../rollbacks/20261011120000_context_story_settled_notes_down.sql
\endif
-- (The story lead rank, 20261011100000, replaced the assembler since: its rollback goes first, as the
-- scoping pipeline's refuses while a later assembler body is live.)
SELECT coalesce(obj_description(to_regprocedure('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'), 'pg_proc'), '')
       LIKE '%(story lead rank, 20261011100000)%' AS story_lead_rank_live \gset
\if :story_lead_rank_live
\ir ../../../rollbacks/20261011100000_context_story_lead_rank_down.sql
\endif
-- (the finished wake, 20261012093500, replaced the lead rule, the judge and the due list since: its
-- down goes first, as the scoping pipeline's refuses while a later body is live)
-- (the rebuild order, 20261012164500, replaced the due list since: its down goes first, as the
-- finished wake's refuses while a later body is live)
SELECT coalesce(obj_description(to_regprocedure('public.context_ledger_due(integer)'), 'pg_proc'), '') LIKE '%(rebuild order, 20261012164500)%' AS rebuild_order_live \gset
\if :rebuild_order_live
\ir ../../../rollbacks/20261012164500_context_rebuild_order_down.sql
\endif
-- (the rebuild request, 20261013153000, replaced the judge since: its down goes first, as the
-- finished wake's refuses while a later body is live)
SELECT to_regprocedure('public.context_ledger_request_rebuild(uuid,text,text)') IS NOT NULL AS rebuild_request_live \gset
\if :rebuild_request_live
-- (held notes, 20261015100000) replaced the judge, the item check, the story's ledger read, the packet and
-- the story since: its down goes first, inside this transaction only.
SELECT to_regprocedure('public.context_ledger_held_cite(uuid,jsonb)') IS NOT NULL AS held_notes_live \gset
\if :held_notes_live
\ir ../../../rollbacks/20261015100000_context_held_notes_down.sql
\endif
\ir ../../../rollbacks/20261013153000_context_rebuild_request_down.sql
\endif
SELECT to_regprocedure('public.context_finished_wake_hours()') IS NOT NULL AS finished_wake_live \gset
\if :finished_wake_live
\ir ../../../rollbacks/20261012093500_context_finished_wake_down.sql
\endif
\ir ../../../rollbacks/20261009133000_context_scoping_pipeline_down.sql
