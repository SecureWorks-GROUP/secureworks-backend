DO $$ BEGIN
  IF to_regclass('public.context_ai_job_models') IS NOT NULL
     OR to_regclass('public.context_ai_harness_runs') IS NOT NULL
     OR to_regprocedure('public.context_ai_harness_save(jsonb)') IS NOT NULL
     OR to_regprocedure('public.context_ai_harness_trim(timestamptz,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'ai models rollback: model or harness objects remain';
  END IF;
  IF to_regclass('public.context_ai_calls') IS NULL THEN
    RAISE EXCEPTION 'ai models rollback: existing call log was removed';
  END IF;
END $$;
SELECT 'PASS: P4-06.1 rollback removes only model and harness objects' AS result;
