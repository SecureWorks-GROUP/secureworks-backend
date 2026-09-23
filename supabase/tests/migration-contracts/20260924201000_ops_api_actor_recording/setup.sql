-- F-ACT setup. Earlier registered fixtures already supply every object this
-- migration reads or replaces: F1's context_core_status() and the tables it
-- reads, and F1b's composer. No extra tables or columns.
--
-- Prove the fixtures leave exactly the pre-image the migration's guard pins:
-- F1's core body (production md5 3df30c5c...), F1b's composer, and none of the
-- new objects.
DO $$
BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_core_status()')) IS DISTINCT FROM '3df30c5ccf6db32c4782ba7859591b86'
 THEN RAISE EXCEPTION 'f-act setup: context_core_status() is not the production pre-image'; END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.context_pipeline_status()')) IS DISTINCT FROM '9183a756c0d4b3881507656751c0d422'
 THEN RAISE EXCEPTION 'f-act setup: context_pipeline_status() is not the production (F1b) composer'; END IF;
 IF to_regclass('public.ops_api_actor_calls') IS NOT NULL
  OR to_regprocedure('public.record_ops_api_actor_call(text,text,text)') IS NOT NULL
  OR to_regprocedure('public.context_actor_missing_status()') IS NOT NULL
 THEN RAISE EXCEPTION 'f-act setup: a new object already exists'; END IF;
END $$;
