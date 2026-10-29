-- After the down: materials_ai_candidate_jobs is 20261028173000's body byte for
-- byte with no comment, the job picture is gone, and the restored candidates
-- still answer.
\set ON_ERROR_STOP on
DO $$
DECLARE live text;
BEGIN
  SELECT md5(p.prosrc) INTO live FROM pg_proc p WHERE p.oid = to_regprocedure('public.materials_ai_candidate_jobs(date,date)');
  IF live IS DISTINCT FROM '191fff3225a1ac8c03f6e631cea025d2' THEN
    RAISE EXCEPTION 'rollback: materials_ai_candidate_jobs md5 %', live;
  END IF;
  IF obj_description('public.materials_ai_candidate_jobs(date,date)'::regprocedure, 'pg_proc') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: candidate comment remains';
  END IF;
  IF to_regprocedure('public.context_job_picture(uuid[],text[],text[])') IS NOT NULL THEN
    RAISE EXCEPTION 'rollback: context_job_picture remains';
  END IF;
  IF has_function_privilege('anon', 'public.materials_ai_candidate_jobs(date,date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.materials_ai_candidate_jobs(date,date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rollback: candidate grants';
  END IF;
  IF jsonb_typeof(public.materials_ai_candidate_jobs('2026-08-21', '2026-08-23')) <> 'array' THEN
    RAISE EXCEPTION 'rollback: candidates do not answer';
  END IF;
END $$;
