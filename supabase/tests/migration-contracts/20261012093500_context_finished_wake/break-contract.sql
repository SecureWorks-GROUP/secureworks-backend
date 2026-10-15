-- Deliberately put the earlier bodies back (this migration's own rollback: the lead rule, the judge
-- and the due list as 20261009133000 left them, and the wake function dropped). contract.sql must
-- then fail on its first check, the rule as of Mon 12 Oct 2026 10:00 Perth, which reads only a
-- function that exists before this migration: the earlier rule calls every finished job not_quoted,
-- whatever its customer wrote.
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
\ir ../../../rollbacks/20261012093500_context_finished_wake_down.sql
