DO $c$
BEGIN
  IF to_regprocedure('public.context_worker_state()') IS NOT NULL
    OR to_regprocedure('public.context_attribution_due(text,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'worker state rollback: additive reads remain';
  END IF;
  IF to_regprocedure('public.context_attribution_due(integer)') IS NULL
    OR to_regclass('public.job_change_marks') IS NULL THEN
    RAISE EXCEPTION 'worker state rollback: existing context surface removed';
  END IF;
END $c$;
SELECT 'PASS: worker state rollback preserves existing context reads and marks' AS result;
