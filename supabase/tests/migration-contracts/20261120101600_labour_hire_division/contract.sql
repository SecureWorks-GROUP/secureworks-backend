-- 20261120101600: the SQL division rule answers SW - LABOUR HIRE for a job
-- typed labour_hire (whatever its number) and for an SWL number, moves no
-- other answer, and applies twice without change. The shared examples
-- (division_examples.json) are proved against this body by the
-- 20261118120115_division_rulings contract.
BEGIN;
\ir ../../../migrations/20261120101600_labour_hire_division.sql
\ir ../../../migrations/20261120101600_labour_hire_division.sql
DO $test$
DECLARE
  own_org constant uuid := '00000000-0000-0000-0000-000000000001';
  e record;
  actual text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.job_division_option(text,text,uuid)'::regprocedure)
       IS DISTINCT FROM '16a8ef5f34c6b7a98fb2fe9eca23d2be' THEN
    RAISE EXCEPTION 'labour_hire_division_body_mismatch';
  END IF;
  FOR e IN
    SELECT * FROM (VALUES
      -- Labour hire: the type decides, then the SWL number.
      ('SWL-ZZTEST01', 'labour_hire', 'SW - LABOUR HIRE'),
      ('SWM-ZZTEST02', 'labour_hire', 'SW - LABOUR HIRE'),
      (NULL, 'labour_hire', 'SW - LABOUR HIRE'),
      ('SWP-ZZTEST10', E' Labour_Hire\t', 'SW - LABOUR HIRE'),
      ('SWL-ZZTEST02', NULL, 'SW - LABOUR HIRE'),
      ('swl-zztest03', NULL, 'SW - LABOUR HIRE'),
      ('SWLZZTEST04', NULL, 'SW - LABOUR HIRE'),
      ('SWL-ZZTEST05', 'makesafe', 'SW - LABOUR HIRE'),
      -- A type rule still outranks the number, as it does for every prefix.
      ('SWL-ZZTEST06', 'repair', 'SW - MAKESAFE'),
      ('SWL-ZZTEST07', 'roofing', 'SW - PRIVATE ROOFING'),
      ('SWL-ZZTEST10', 'granny_flat', 'SecureBuild'),
      (' SWL-ZZTEST09', NULL, ''),
      ('SWM-ZZTEST03', 'labour hire', ''),
      ('SWM-ZZTEST05', NULL, ''),
      -- Controls: every earlier answer is unchanged.
      ('SWRESTO-ZZTEST01', NULL, 'SW - RESTORATION'),
      ('SWMS-ZZTEST01', NULL, 'SW - MAKESAFE'),
      ('SWR-ZZTEST01', 'repair', 'SW - MAKESAFE'),
      ('SWR-ZZTEST02', 'roofing', 'SW - PRIVATE ROOFING'),
      ('SWP-ZZTEST02', 'patio', 'SW - PATIOS'),
      ('SWF-ZZTEST01', 'fencing', 'SW - FENCING'),
      ('SWD-ZZTEST01', NULL, 'SW - DECKING'),
      ('SWI-ZZTEST01', 'insurance', 'SW - INSURANCE WORK'),
      ('SWR-ZZTEST05', NULL, ''),
      ('ZZTEST-01', NULL, ''),
      (NULL, NULL, '')
    ) AS t(job_number, job_type, expect)
  LOOP
    actual := public.job_division_option(e.job_number, e.job_type);
    IF actual IS DISTINCT FROM e.expect
       OR public.job_division_option(e.job_number, e.job_type, own_org) IS DISTINCT FROM e.expect THEN
      RAISE EXCEPTION 'labour_hire_division_mismatch: % % gave %', e.job_number, e.job_type, actual;
    END IF;
  END LOOP;
  -- The wrapper, the stock rule and the grants are untouched.
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.job_division_option(text,text)'::regprocedure)
       IS DISTINCT FROM 'c0c72acded3644ca4268f08761f777af'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.stock_division_option(text)'::regprocedure)
       IS DISTINCT FROM '861a07f6e2be7e00d10891a272c014f9' THEN
    RAISE EXCEPTION 'labour_hire_division_touched_a_sibling';
  END IF;
  IF has_function_privilege('anon', 'public.job_division_option(text,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.job_division_option(text,text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.job_division_option(text,text,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'labour_hire_division_grants_changed';
  END IF;
END $test$;
ROLLBACK;
