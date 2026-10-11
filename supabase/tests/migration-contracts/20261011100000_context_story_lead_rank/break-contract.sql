-- Deliberately put the earlier body back (this migration's own rollback: 20261009133000's assembler,
-- open loops ranked oldest first). contract.sql must then fail on its first check: on SWF-261469's
-- shape the 5 Oct install ask leads again over the newer completion complaint.
\ir ../../../rollbacks/20261011100000_context_story_lead_rank_down.sql
