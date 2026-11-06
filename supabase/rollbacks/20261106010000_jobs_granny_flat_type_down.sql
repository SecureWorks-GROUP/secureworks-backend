-- Restore the reviewed eleven-type check. Never coerce/reclassify a job.
-- Undo the separately commissioned exact job operation first, if it ran.
DO $granny_flat_down$
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
  IF v_definition = v_legacy THEN
    RETURN;
  END IF;
  IF v_definition IS DISTINCT FROM v_next THEN
    RAISE EXCEPTION 'jobs_type_check differs from the reviewed granny-flat definition';
  END IF;
  IF EXISTS (SELECT 1 FROM public.jobs WHERE type = 'granny_flat') THEN
    RAISE EXCEPTION 'granny_flat jobs exist; undo the exact job operation before schema rollback';
  END IF;
  ALTER TABLE public.jobs DROP CONSTRAINT jobs_type_check;
  ALTER TABLE public.jobs ADD CONSTRAINT jobs_type_check
    CHECK (type IN ('fencing', 'patio', 'combo', 'decking', 'renovation',
      'insurance', 'roofing', 'miscellaneous', 'general', 'makesafe', 'repair'));
  EXECUTE format('COMMENT ON CONSTRAINT jobs_type_check ON public.jobs IS %L', v_comment);
END;
$granny_flat_down$;
