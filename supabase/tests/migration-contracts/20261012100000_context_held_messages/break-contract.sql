-- Deliberately put the earlier bodies back (this migration's own rollback: 20261007150000's packet
-- and 20261011120000's story read, the two helpers dropped). contract.sql must then fail on its
-- first check: the helpers are gone.
\ir ../../../rollbacks/20261012100000_context_held_messages_down.sql
