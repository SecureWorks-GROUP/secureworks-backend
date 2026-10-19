-- Rollback contract: 20261018140000_dispatch_scope_order_lines. The down drops
-- the scope order lines table and nothing else: jobs remain.
\set ON_ERROR_STOP on
DO $$
BEGIN
 IF to_regclass('public.dispatch_scope_order_lines') IS NOT NULL THEN
  RAISE EXCEPTION 'scope order lines rollback contract: the table still exists';
 END IF;
 IF to_regclass('public.jobs') IS NULL THEN
  RAISE EXCEPTION 'scope order lines rollback contract: the down removed jobs';
 END IF;
END $$;
