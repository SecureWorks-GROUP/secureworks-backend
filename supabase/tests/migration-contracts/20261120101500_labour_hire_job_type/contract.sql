-- 20261120101500: labour hire is a job type numbered SWLH-. The twelve earlier
-- types and every earlier prefix behave exactly as before, all prefixes share
-- one counter, a retyped job keeps its number, and a re-apply changes nothing.
BEGIN;
\ir ../../../migrations/20261120101500_labour_hire_job_type.sql

DO $$
DECLARE
  v_definition text;
  v_expression text;
  v_comment text;
  v_type text;
  v_accepted boolean;
BEGIN
  SELECT pg_get_constraintdef(oid), pg_get_expr(conbin, conrelid), obj_description(oid, 'pg_constraint')
    INTO v_definition, v_expression, v_comment
  FROM pg_constraint WHERE conrelid = 'public.jobs'::regclass
    AND conname = 'jobs_type_check' AND contype = 'c' AND convalidated;
  IF v_definition IS DISTINCT FROM 'CHECK ((type = ANY (ARRAY[''fencing''::text, ''patio''::text, ''combo''::text, ''decking''::text, ''renovation''::text, ''insurance''::text, ''roofing''::text, ''miscellaneous''::text, ''general''::text, ''makesafe''::text, ''repair''::text, ''granny_flat''::text, ''labour_hire''::text])))' THEN
    RAISE EXCEPTION 'unexpected job type vocabulary: %', v_definition;
  END IF;
  FOREACH v_type IN ARRAY ARRAY['fencing', 'patio', 'combo', 'decking', 'renovation',
    'insurance', 'roofing', 'miscellaneous', 'general', 'makesafe', 'repair', 'granny_flat', 'labour_hire']
  LOOP
    EXECUTE 'SELECT ' || v_expression || ' FROM (SELECT $1::text AS type) j'
      INTO v_accepted USING v_type;
    IF v_accepted IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'job type refused: %', v_type;
    END IF;
  END LOOP;
  FOREACH v_type IN ARRAY ARRAY['unrecognised_type', 'labour hire', 'Labour_Hire', 'labourhire']
  LOOP
    EXECUTE 'SELECT ' || v_expression || ' FROM (SELECT $1::text AS type) j'
      INTO v_accepted USING v_type;
    IF v_accepted IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'unsupported type was admitted: %', v_type;
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  yr text := ((EXTRACT(YEAR FROM now())::int % 100))::text;
  a text; b text; c text;
  expectation record;
BEGIN
  a := public.next_job_number('labour_hire');
  IF a NOT LIKE 'SWLH-' || yr || '%' THEN
    RAISE EXCEPTION 'labour_hire must mint SWLH-<yy>..., got %', a;
  END IF;
  b := public.next_job_number('miscellaneous');
  IF b NOT LIKE 'SWM-' || yr || '%' THEN
    RAISE EXCEPTION 'miscellaneous must still mint SWM-, got %', b;
  END IF;
  IF substr(b, length('SWM-' || yr) + 1)::int <> substr(a, length('SWLH-' || yr) + 1)::int + 1 THEN
    RAISE EXCEPTION 'labour hire must draw from the shared yearly counter: % then %', a, b;
  END IF;
  c := public.next_job_number('Labour_Hire');
  IF c NOT LIKE 'SWLH-%' THEN
    RAISE EXCEPTION 'the type is read case-insensitively, got %', c;
  END IF;
  FOR expectation IN
    SELECT * FROM (VALUES
      ('patio', 'SWP-'), ('fencing', 'SWF-'), ('decking', 'SWD-'), ('renovation', 'SWR-'),
      ('insurance', 'SWI-'), ('roofing', 'SWR-'), ('miscellaneous', 'SWM-'), ('general', 'SWG-'),
      ('makesafe', 'SWMS-'), ('repair', 'SWR-'), ('restoration', 'SWRESTO-'),
      ('labour hire', 'SW-'), ('granny_flat', 'SW-'), ('not_a_job_type', 'SW-')
    ) AS t(job_type, prefix)
  LOOP
    a := public.next_job_number(expectation.job_type);
    IF a NOT LIKE expectation.prefix || yr || '%' THEN
      RAISE EXCEPTION 'next_job_number(%) minted % but must start with %',
        expectation.job_type, a, expectation.prefix;
    END IF;
  END LOOP;
END $$;

-- A new labour hire job is numbered by the insert trigger, and an older job
-- retyped to labour hire keeps the number it has.
DO $$
DECLARE
  org constant uuid := '00000000-0000-0000-0000-0000000000aa';
  new_job constant uuid := 'aaaaaaaa-0000-4000-8000-0000000000b1';
  old_job constant uuid := 'aaaaaaaa-0000-4000-8000-0000000000b2';
  minted text;
BEGIN
  INSERT INTO public.jobs (id, org_id, status, type)
  VALUES (new_job, org, 'invoiced', 'labour_hire');
  SELECT job_number INTO minted FROM public.jobs WHERE id = new_job;
  IF minted NOT LIKE 'SWLH-%' THEN
    RAISE EXCEPTION 'a labour hire job auto-numbered % instead of SWLH-', minted;
  END IF;

  INSERT INTO public.jobs (id, org_id, status, type, job_number)
  VALUES (old_job, org, 'invoiced', 'miscellaneous', 'SWM-ZZTEST77');
  UPDATE public.jobs SET type = 'labour_hire'
  WHERE id = old_job AND type = 'miscellaneous' AND status = 'invoiced';
  SELECT job_number INTO minted FROM public.jobs WHERE id = old_job AND type = 'labour_hire';
  IF minted IS DISTINCT FROM 'SWM-ZZTEST77' THEN
    RAISE EXCEPTION 'a retyped job must keep its number, got %', minted;
  END IF;
END $$;
ROLLBACK;
