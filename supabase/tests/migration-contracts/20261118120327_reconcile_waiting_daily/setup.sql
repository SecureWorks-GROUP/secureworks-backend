-- CI: the registered stack already holds P2-03.1 and P2-03.2, so this is a
-- no-op. Isolated local proof: build P2-03.1 and P2-03.2 first from their own
-- case files. No function stand-ins.
SELECT to_regclass('public.reconcile_items') IS NULL AS isolated_waiting_setup \gset
\if :isolated_waiting_setup
\ir ../20261118060051_reconcile_tables/setup.sql
\ir ../../../migrations/20261118060051_reconcile_tables.sql
\endif
SELECT to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)') IS NULL AS isolated_waiting_raise \gset
\if :isolated_waiting_raise
\ir ../20261118073218_reconcile_item_raise/setup.sql
\ir ../../../migrations/20261118073218_reconcile_item_raise.sql
\endif
