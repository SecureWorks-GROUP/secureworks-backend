-- Rollback contract: 20261020120000_job_work_order_fill_revision. The down
-- removes the column, guard, check and index and leaves work_orders and
-- scope_revisions alone.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
            AND table_name = 'work_orders' AND column_name = 'quote_filled_scope_revision_id') THEN
  RAISE EXCEPTION 'fill revision rollback contract: the column survived the down';
 END IF;
 IF to_regprocedure('public.work_orders_fill_revision_guard()') IS NOT NULL THEN
  RAISE EXCEPTION 'fill revision rollback contract: the guard survived the down';
 END IF;
 IF to_regclass('public.work_orders') IS NULL OR to_regclass('public.scope_revisions') IS NULL THEN
  RAISE EXCEPTION 'fill revision rollback contract: the down removed a table it does not own';
 END IF;
END $$;
