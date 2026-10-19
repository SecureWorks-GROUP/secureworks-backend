-- Deliberately put the earlier bodies back (this migration's own rollback: the record loops, the
-- story read, the assembler and the judge as 20261006040000 and 20261006014000 left them, and the
-- rule dropped). contract.sql must then fail on its first check, R7 of a lead 29 days after its
-- quote, which reads only a body that exists before this migration: the contract fails first on
-- the earlier bodies.
-- (The scoping pipeline, 20261009133000, replaced four of these bodies since: its rollback goes
-- first, as this one refuses while a later body is live.)
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
SELECT to_regprocedure('public.context_lead_window_hours(text)') IS NOT NULL AS scoping_pipeline_live \gset
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
\if :scoping_pipeline_live
\ir ../../../rollbacks/20261009133000_context_scoping_pipeline_down.sql
\endif
SELECT to_regprocedure('public.context_ledger_row_unread(timestamptz,boolean,timestamptz)') IS NOT NULL AS notes_freshness_live \gset
\if :notes_freshness_live
\ir ../../../rollbacks/20261009132000_context_notes_freshness_down.sql
\endif
\ir ../../../rollbacks/20261007010000_context_lead_cutoff_down.sql
