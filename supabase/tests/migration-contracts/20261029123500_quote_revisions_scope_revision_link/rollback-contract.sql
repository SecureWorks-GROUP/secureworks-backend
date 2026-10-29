-- The runner has just run the down migration: the column and its foreign key
-- are gone, quote_revisions and scope_revisions are still there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.quote_revisions'::regclass
               AND attname = 'scope_revision_id' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'scope revision link rollback contract: scope_revision_id is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_revisions_scope_revision_id_fkey') THEN
    RAISE EXCEPTION 'scope revision link rollback contract: the foreign key is still there';
  END IF;
  IF to_regclass('public.quote_revisions') IS NULL OR to_regclass('public.scope_revisions') IS NULL THEN
    RAISE EXCEPTION 'scope revision link rollback contract: a table was dropped';
  END IF;
  PERFORM id, job_id, version FROM public.quote_revisions LIMIT 1;
END $$;
