-- CI: the registered stack already holds P2-03.1's list and log, so this is a
-- no-op. Isolated local proof: build P2-03.1 first from its own case files.
-- No function stand-ins.
SELECT to_regclass('public.reconcile_items') IS NULL AS isolated_raise_setup \gset
\if :isolated_raise_setup
\ir ../20261118060051_reconcile_tables/setup.sql
\ir ../../../migrations/20261118060051_reconcile_tables.sql
\endif
