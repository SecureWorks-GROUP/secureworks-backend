-- Constraint compatibility only; no live job or feature writes.
BEGIN;
DO $$
DECLARE
  v_definition text;
  v_expression text;
  v_type text;
  v_accepted boolean;
BEGIN
  SELECT pg_get_constraintdef(oid), pg_get_expr(conbin, conrelid)
    INTO v_definition, v_expression
  FROM pg_constraint WHERE conrelid = 'public.jobs'::regclass
    AND conname = 'jobs_type_check' AND contype = 'c' AND convalidated;
  IF v_definition IS DISTINCT FROM 'CHECK ((type = ANY (ARRAY[''fencing''::text, ''patio''::text, ''combo''::text, ''decking''::text, ''renovation''::text, ''insurance''::text, ''roofing''::text, ''miscellaneous''::text, ''general''::text, ''makesafe''::text, ''repair''::text])))' THEN
    RAISE EXCEPTION 'unexpected job type vocabulary';
  END IF;
  FOREACH v_type IN ARRAY ARRAY['fencing', 'patio', 'combo', 'decking', 'renovation',
    'insurance', 'roofing', 'miscellaneous', 'general', 'makesafe', 'repair']
  LOOP
    EXECUTE 'SELECT ' || v_expression || ' FROM (SELECT $1::text AS type) j'
      INTO v_accepted USING v_type;
    IF v_accepted IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'existing job type refused: %', v_type;
    END IF;
  END LOOP;
  EXECUTE 'SELECT ' || v_expression || ' FROM (SELECT $1::text AS type) j'
    INTO v_accepted USING 'granny_flat';
  IF v_accepted IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'unsupported type was admitted';
  END IF;
END $$;
ROLLBACK;
