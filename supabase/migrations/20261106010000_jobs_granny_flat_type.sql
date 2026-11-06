-- Admit one existing-job classification: granny_flat (Granny flat build).
-- No job, numbering, work-order, accounting, permissions or financial-link writes.
-- The selected existing-job operation is separate and must preserve its identity.
DO $granny_flat$
DECLARE
  v_definition text;
  v_comment text;
  v_legacy constant text := 'CHECK ((type = ANY (ARRAY[''fencing''::text, ''patio''::text, ''combo''::text, ''decking''::text, ''renovation''::text, ''insurance''::text, ''roofing''::text, ''miscellaneous''::text, ''general''::text, ''makesafe''::text, ''repair''::text])))';
  v_next constant text := 'CHECK ((type = ANY (ARRAY[''fencing''::text, ''patio''::text, ''combo''::text, ''decking''::text, ''renovation''::text, ''insurance''::text, ''roofing''::text, ''miscellaneous''::text, ''general''::text, ''makesafe''::text, ''repair''::text, ''granny_flat''::text])))';
BEGIN
  LOCK TABLE public.jobs IN ACCESS EXCLUSIVE MODE;
  SELECT pg_get_constraintdef(oid), obj_description(oid, 'pg_constraint') INTO v_definition, v_comment
  FROM pg_constraint
  WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_type_check'
    AND contype = 'c' AND convalidated;
  IF v_definition = v_next THEN
    RETURN; -- Re-apply is a no-op.
  END IF;
  IF v_definition IS DISTINCT FROM v_legacy THEN
    RAISE EXCEPTION 'jobs_type_check differs from the reviewed eleven-type baseline';
  END IF;
  ALTER TABLE public.jobs DROP CONSTRAINT jobs_type_check;
  ALTER TABLE public.jobs ADD CONSTRAINT jobs_type_check
    CHECK (type IN ('fencing', 'patio', 'combo', 'decking', 'renovation',
      'insurance', 'roofing', 'miscellaneous', 'general', 'makesafe', 'repair', 'granny_flat'));
  EXECUTE format('COMMENT ON CONSTRAINT jobs_type_check ON public.jobs IS %L', v_comment);
END;
$granny_flat$;
