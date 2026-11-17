DO $c$
BEGIN
 IF to_regclass('public.job_change_mark_events') IS NOT NULL
  OR to_regclass('public.job_notes_marks_seen') IS NOT NULL
  OR to_regclass('public.job_change_marks_base') IS NOT NULL
  OR (SELECT relkind FROM pg_class WHERE oid='public.job_change_marks'::regclass)<>'r' THEN
  RAISE EXCEPTION 'queue safety rollback: legacy marks table not restored';
 END IF;
END $c$;
