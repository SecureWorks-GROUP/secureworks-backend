-- Deliberately put the earlier bodies back (this migration's own rollback: 20261011100000's
-- assembler, open notes only, oldest first; 20261007010000's story read). contract.sql must then
-- fail on its first check: SWF-261469's shape has no settled list.
\ir ../../../rollbacks/20261011120000_context_story_settled_notes_down.sql
