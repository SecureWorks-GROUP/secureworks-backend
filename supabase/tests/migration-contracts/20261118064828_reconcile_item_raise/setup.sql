-- CI: the registered stack already holds P2-03.1's list and log, so this is a
-- no-op. Isolated local proof: build P2-03.1 first from its own case files.
-- No function stand-ins.
SELECT to_regclass('public.reconcile_items') IS NULL AS isolated_raise_setup \gset
\if :isolated_raise_setup
\ir ../20261118060051_reconcile_tables/setup.sql
\ir ../../../migrations/20261118060051_reconcile_tables.sql
\endif
-- CI stack walk: P1-13.9's setup (20261118062307) leaves a positional
-- reconcile_item_raise stand-in that writes to its own temp table when the real
-- one is absent. Remove only that stand-in, by its body, so this migration's
-- install guard meets an empty name, as it does on live.
DO $standin$
/* block */ BEGIN
 IF (SELECT prosrc FROM pg_proc
     WHERE oid = to_regprocedure('public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text)'))
    LIKE '%pg_temp.zztest_claim_items%' THEN
  DROP FUNCTION public.reconcile_item_raise(text,text,text,uuid[],jsonb,jsonb,text);
 END IF;
END $standin$;
