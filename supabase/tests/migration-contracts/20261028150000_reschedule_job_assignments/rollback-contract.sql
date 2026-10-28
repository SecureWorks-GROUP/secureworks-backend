-- After the down migration, neither function is left behind.
DO $$
BEGIN
  IF to_regprocedure('public.reschedule_job_assignments_v1(uuid, jsonb, jsonb, jsonb, uuid[], text[], text)') IS NOT NULL
     OR to_regprocedure('public.reschedule_job_assignments_refuse(text, text, jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'reschedule rollback: a function is still present';
  END IF;
END $$;
