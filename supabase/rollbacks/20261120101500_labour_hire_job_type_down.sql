-- Rollback for 20261120101500_labour_hire_job_type: restores the reviewed
-- twelve-type check and removes the 'labour_hire' numbering branch, so a labour
-- hire request answers SW- again. Never coerces or reclassifies a job: it
-- refuses while any labour_hire job exists (undo the retype of those jobs
-- first). Numbers already minted SWLH- are left as they are.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $labour_hire_down$
DECLARE
  v_definition text;
  v_comment text;
  v_legacy constant text := 'CHECK ((type = ANY (ARRAY[''fencing''::text, ''patio''::text, ''combo''::text, ''decking''::text, ''renovation''::text, ''insurance''::text, ''roofing''::text, ''miscellaneous''::text, ''general''::text, ''makesafe''::text, ''repair''::text, ''granny_flat''::text])))';
  v_next constant text := 'CHECK ((type = ANY (ARRAY[''fencing''::text, ''patio''::text, ''combo''::text, ''decking''::text, ''renovation''::text, ''insurance''::text, ''roofing''::text, ''miscellaneous''::text, ''general''::text, ''makesafe''::text, ''repair''::text, ''granny_flat''::text, ''labour_hire''::text])))';
  v_number_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_number_md5
  FROM pg_catalog.pg_proc p
  WHERE p.oid = to_regprocedure('public.next_job_number(text)');
  IF v_number_md5 IS NULL
     OR v_number_md5 NOT IN ('54e49abe7bd3225fb96e016094504d89', '3fc8ff31501aec696bf6cf15d6e757d8') THEN
    RAISE EXCEPTION 'next_job_number differs from the reviewed labour hire body';
  END IF;

  LOCK TABLE public.jobs IN ACCESS EXCLUSIVE MODE;
  SELECT pg_get_constraintdef(oid), obj_description(oid, 'pg_constraint') INTO v_definition, v_comment
  FROM pg_constraint
  WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_type_check'
    AND contype = 'c' AND convalidated;
  IF v_definition = v_legacy THEN
    RETURN;
  END IF;
  IF v_definition IS DISTINCT FROM v_next THEN
    RAISE EXCEPTION 'jobs_type_check differs from the reviewed labour hire definition';
  END IF;
  IF EXISTS (SELECT 1 FROM public.jobs WHERE type = 'labour_hire') THEN
    RAISE EXCEPTION 'labour_hire jobs exist; retype them back before schema rollback';
  END IF;
  ALTER TABLE public.jobs DROP CONSTRAINT jobs_type_check;
  ALTER TABLE public.jobs ADD CONSTRAINT jobs_type_check
    CHECK (type IN ('fencing', 'patio', 'combo', 'decking', 'renovation',
      'insurance', 'roofing', 'miscellaneous', 'general', 'makesafe', 'repair', 'granny_flat'));
  EXECUTE format('COMMENT ON CONSTRAINT jobs_type_check ON public.jobs IS %L', v_comment);
END;
$labour_hire_down$;

CREATE OR REPLACE FUNCTION public.next_job_number(job_type text DEFAULT 'patio'::text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
  prefix text;
  yr smallint;
  seq int;
BEGIN
  prefix := CASE lower(job_type)
    WHEN 'patio'          THEN 'SWP-'
    WHEN 'fencing'        THEN 'SWF-'
    WHEN 'decking'        THEN 'SWD-'
    WHEN 'renovation'     THEN 'SWR-'
    WHEN 'insurance'      THEN 'SWI-'
    WHEN 'roofing'        THEN 'SWR-'
    WHEN 'miscellaneous'  THEN 'SWM-'
    WHEN 'general'        THEN 'SWG-'
    WHEN 'makesafe'       THEN 'SWMS-'
    WHEN 'repair'        THEN 'SWR-'
    WHEN 'restoration'    THEN 'SWRESTO-'
    ELSE 'SW-'
  END;
  yr := (EXTRACT(YEAR FROM now()) % 100)::smallint;
  INSERT INTO public.job_number_counters (year, last_seq)
  VALUES (yr, 1)
  ON CONFLICT (year) DO UPDATE SET last_seq = public.job_number_counters.last_seq + 1
  RETURNING last_seq INTO seq;
  -- Minimum width 3, but never truncate a longer (>=1000) sequence.
  RETURN prefix || yr::text || lpad(seq::text, greatest(3, length(seq::text)), '0');
END;
$function$;
