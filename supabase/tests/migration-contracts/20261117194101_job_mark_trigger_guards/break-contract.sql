-- Remove only the new guard; the contract must catch entry into the unchanged-row compare.
DO $$ BEGIN
 EXECUTE replace(pg_get_functiondef('public.job_change_mark_triggers_install()'::regprocedure),
  'WHEN (OLD.* IS DISTINCT FROM NEW.*)', '');
END $$;
