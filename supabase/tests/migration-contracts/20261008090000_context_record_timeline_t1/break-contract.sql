-- Deliberately put back the story safety (20261006040000) timeline through this migration's own
-- down: a scope save reads as a site visit again. contract.sql must fail on it.
\ir ../../../rollbacks/20261008090000_context_record_timeline_t1_down.sql
