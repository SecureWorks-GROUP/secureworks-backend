-- Rollback for 20261118999902: drop the named wrapper only. The two
-- reconcile_item_raise overloads are untouched by the forward migration and
-- stay as they are. Callers then fail with PGRST202 again (best effort, logged).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DROP FUNCTION IF EXISTS public.reconcile_item_raise_named(text,text,text,uuid[],jsonb,jsonb,text,uuid);
