-- Deliberately put the earlier bodies back (this migration's own rollback: the lead rule, the judge,
-- the record loops and the assembler as 20261007010000 left them, the due list as 20261006013000 left
-- it, and the window function dropped). contract.sql must then fail on its first check, the rule as
-- of Wed 7 Oct 2026 10:00 Perth, which reads only a function that exists before this migration: a
-- draft is never monitored by the earlier rule's live set and every lead has 28 days.
\ir ../../../rollbacks/20261009130000_context_scoping_pipeline_down.sql
