-- Undo 20261104010000_dispatch_order_bill_links: the two Dispatch order views and their two functions go.
-- That migration replaced no view or function (every object was new), so there is no older definition to put
-- back: before it, none of these four objects existed. Nothing else is touched. Each object is dropped only when
-- its comment carries "B4 20261104010000", so an object of the same name that is not that migration's is kept
-- and the rollback refuses.
SET LOCAL lock_timeout = '5s';

DO $down$
DECLARE
  o record;
BEGIN
  FOR o IN
    SELECT 'public.v_dispatch_order_bills' AS name, to_regclass('public.v_dispatch_order_bills')::oid AS oid, 'pg_class' AS cat
    UNION ALL SELECT 'public.v_dispatch_orders', to_regclass('public.v_dispatch_orders')::oid, 'pg_class'
    UNION ALL SELECT 'public.dispatch_supplier_name_key(text)', to_regprocedure('public.dispatch_supplier_name_key(text)')::oid, 'pg_proc'
    UNION ALL SELECT 'public.dispatch_job_number_pattern(text)', to_regprocedure('public.dispatch_job_number_pattern(text)')::oid, 'pg_proc'
  LOOP
    IF o.oid IS NOT NULL AND coalesce(obj_description(o.oid, o.cat), '') NOT LIKE '%B4 20261104010000%' THEN
      RAISE EXCEPTION '% is not the 20261104010000 object; refusing to drop it', o.name;
    END IF;
  END LOOP;
END $down$;

DROP VIEW IF EXISTS public.v_dispatch_order_bills;
DROP VIEW IF EXISTS public.v_dispatch_orders;
DROP FUNCTION IF EXISTS public.dispatch_job_number_pattern(text);
DROP FUNCTION IF EXISTS public.dispatch_supplier_name_key(text);
