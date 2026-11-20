-- After the down migration the twelve-type check is back, labour hire is
-- refused again, and a labour hire request falls back to SW-.
BEGIN;
DO $$
DECLARE
  v_definition text;
  v_expression text;
  v_accepted boolean;
BEGIN
  SELECT pg_get_constraintdef(oid), pg_get_expr(conbin, conrelid)
    INTO v_definition, v_expression
  FROM pg_constraint WHERE conrelid = 'public.jobs'::regclass
    AND conname = 'jobs_type_check' AND contype = 'c' AND convalidated;
  IF v_definition IS DISTINCT FROM 'CHECK ((type = ANY (ARRAY[''fencing''::text, ''patio''::text, ''combo''::text, ''decking''::text, ''renovation''::text, ''insurance''::text, ''roofing''::text, ''miscellaneous''::text, ''general''::text, ''makesafe''::text, ''repair''::text, ''granny_flat''::text])))' THEN
    RAISE EXCEPTION 'rollback must restore the twelve-type vocabulary: %', v_definition;
  END IF;
  EXECUTE 'SELECT ' || v_expression || ' FROM (SELECT $1::text AS type) j'
    INTO v_accepted USING 'labour_hire';
  IF v_accepted IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'rollback must refuse labour_hire again';
  END IF;
  EXECUTE 'SELECT ' || v_expression || ' FROM (SELECT $1::text AS type) j'
    INTO v_accepted USING 'granny_flat';
  IF v_accepted IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'rollback must keep granny_flat';
  END IF;
  IF public.next_job_number('labour_hire') NOT LIKE 'SW-%' THEN
    RAISE EXCEPTION 'rollback must remove the labour hire branch';
  END IF;
  IF public.next_job_number('restoration') NOT LIKE 'SWRESTO-%' THEN
    RAISE EXCEPTION 'rollback must keep restoration SWRESTO-';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.next_job_number(text)'::regprocedure)
       IS DISTINCT FROM '54e49abe7bd3225fb96e016094504d89' THEN
    RAISE EXCEPTION 'rollback must restore the restoration numbering body';
  END IF;
END $$;
ROLLBACK;
