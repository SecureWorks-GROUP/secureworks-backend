-- The runner has just run the down migration: the column and its foreign key
-- are gone, dispatch_v2_scope_fills and scope_revisions are still there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.dispatch_v2_scope_fills'::regclass
               AND attname = 'scope_revision_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'scope fill revision rollback contract: scope_revision_id is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_v2_scope_fills_scope_revision_id_fkey') THEN
    RAISE EXCEPTION 'scope fill revision rollback contract: the foreign key is still there';
  END IF;
  IF to_regclass('public.dispatch_v2_scope_fills') IS NULL OR to_regclass('public.scope_revisions') IS NULL THEN
    RAISE EXCEPTION 'scope fill revision rollback contract: a table was dropped';
  END IF;
  PERFORM job_id, org_id, auto, lines_added, supplier_id, scope_supplier FROM public.dispatch_v2_scope_fills LIMIT 1;
END $$;
