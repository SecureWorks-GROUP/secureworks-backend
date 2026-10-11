-- Deliberately put the earlier body back (this migration's own rollback: 20261009133000's assembler,
-- open loops ranked oldest first). contract.sql must then fail on its first check: on SWF-261469's
-- shape the 5 Oct install ask leads again over the newer completion complaint.
-- (the story settled notes, 20261011120000, replaced the assembler and the story read since: its down
-- goes first, as the story lead rank's refuses while a later assembler body is live)
SELECT coalesce(obj_description(to_regprocedure('public.context_job_story_assemble(jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz)'), 'pg_proc'), '')
       LIKE '%(story settled notes, 20261011120000)%' AS story_settled_notes_live \gset
\if :story_settled_notes_live
\ir ../../../rollbacks/20261011120000_context_story_settled_notes_down.sql
\endif
\ir ../../../rollbacks/20261011100000_context_story_lead_rank_down.sql
