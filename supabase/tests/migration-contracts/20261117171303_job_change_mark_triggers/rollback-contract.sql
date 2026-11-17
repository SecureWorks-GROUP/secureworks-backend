DO $c$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'job_mark_changed_%')
  OR to_regprocedure('public.job_mark_changed_trg()') IS NOT NULL
  OR to_regprocedure('public.job_change_mark_triggers_install()') IS NOT NULL
  OR to_regprocedure('public.job_change_mark_triggers_remove()') IS NOT NULL THEN
  RAISE EXCEPTION 'job mark triggers rollback: trigger or function remains';
 END IF;
 IF to_regclass('public.job_change_marks') IS NULL THEN
  RAISE EXCEPTION 'job mark triggers rollback: marks table must remain';
 END IF;
END $c$;
