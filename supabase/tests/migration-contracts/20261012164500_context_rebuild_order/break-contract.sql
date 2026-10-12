-- Deliberately put the earlier body back (this migration's own rollback: the due list as
-- 20261012093500 left it). contract.sql must then fail on its first check of the list itself, the
-- order of section 1: the earlier body lists the reader-change rebuilds by the longest wait for a
-- row not read and then newest evidence first, whatever their customers wrote.
\ir ../../../rollbacks/20261012164500_context_rebuild_order_down.sql
