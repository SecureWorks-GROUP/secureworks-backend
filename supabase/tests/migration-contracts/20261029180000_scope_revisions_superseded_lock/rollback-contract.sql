-- After the down: the 20260504090757 body is back byte for byte and the
-- INSERT guard is gone.
DO $$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.scope_revisions_controlled_immutable()'::regprocedure)
     <> 'e2bcfa102c4db84b414f334eb4f7dadf' THEN
    RAISE EXCEPTION 'superseded lock rollback: the 20260504090757 body was not restored';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.scope_revisions'::regclass
              AND tgname = 'trg_scope_revisions_insert_lifecycle')
     OR to_regprocedure('public.scope_revisions_insert_lifecycle()') IS NOT NULL THEN
    RAISE EXCEPTION 'superseded lock rollback: the INSERT guard is still there';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.scope_revisions'::regclass
                  AND tgname = 'trg_scope_revisions_controlled_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'superseded lock rollback: the update guard trigger is gone';
  END IF;
END $$;
