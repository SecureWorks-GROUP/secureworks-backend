-- Labour hire is its own job type (owner, 20 Nov 2026: "they should be labour
-- hire jobs basically. may be a new job classification but do that please").
-- Labour hire = our workers on another builder's site, charged by the hour.
--
-- Two changes, nothing else:
--   1. jobs_type_check admits 'labour_hire' beside the twelve reviewed types.
--   2. next_job_number numbers it SWL-, from the same yearly counter as every
--      other prefix, so numbers never collide across prefixes.
--
-- No job is written, retyped or renumbered here. The four existing labour hire
-- jobs (SWM-261677 to SWM-261680) keep type 'miscellaneous' until the separate
-- reviewed retype in scripts/labour-hire-retype-four-jobs.sql is run by hand.
-- Every other branch of next_job_number is copied unchanged from the live body
-- (read 20 Nov 2026, md5 54e49abe7bd3225fb96e016094504d89).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $labour_hire$
DECLARE
  v_definition text;
  v_comment text;
  v_legacy constant text := 'CHECK ((type = ANY (ARRAY[''fencing''::text, ''patio''::text, ''combo''::text, ''decking''::text, ''renovation''::text, ''insurance''::text, ''roofing''::text, ''miscellaneous''::text, ''general''::text, ''makesafe''::text, ''repair''::text, ''granny_flat''::text])))';
  v_next constant text := 'CHECK ((type = ANY (ARRAY[''fencing''::text, ''patio''::text, ''combo''::text, ''decking''::text, ''renovation''::text, ''insurance''::text, ''roofing''::text, ''miscellaneous''::text, ''general''::text, ''makesafe''::text, ''repair''::text, ''granny_flat''::text, ''labour_hire''::text])))';
  v_number_md5 text;
BEGIN
  -- The numbering function must be the reviewed restoration body or this one.
  SELECT md5(p.prosrc) INTO v_number_md5
  FROM pg_catalog.pg_proc p
  WHERE p.oid = to_regprocedure('public.next_job_number(text)');
  IF v_number_md5 IS NULL
     OR v_number_md5 NOT IN ('54e49abe7bd3225fb96e016094504d89', 'f9cc68391bd169891f8f456dee2bd7ea') THEN
    RAISE EXCEPTION 'next_job_number differs from the reviewed restoration body';
  END IF;

  LOCK TABLE public.jobs IN ACCESS EXCLUSIVE MODE;
  SELECT pg_get_constraintdef(oid), obj_description(oid, 'pg_constraint') INTO v_definition, v_comment
  FROM pg_constraint
  WHERE conrelid = 'public.jobs'::regclass AND conname = 'jobs_type_check'
    AND contype = 'c' AND convalidated;
  IF v_definition = v_next THEN
    RETURN; -- Re-apply is a no-op.
  END IF;
  IF v_definition IS DISTINCT FROM v_legacy THEN
    RAISE EXCEPTION 'jobs_type_check differs from the reviewed twelve-type baseline';
  END IF;
  ALTER TABLE public.jobs DROP CONSTRAINT jobs_type_check;
  ALTER TABLE public.jobs ADD CONSTRAINT jobs_type_check
    CHECK (type IN ('fencing', 'patio', 'combo', 'decking', 'renovation',
      'insurance', 'roofing', 'miscellaneous', 'general', 'makesafe', 'repair', 'granny_flat',
      'labour_hire'));
  EXECUTE format('COMMENT ON CONSTRAINT jobs_type_check ON public.jobs IS %L', v_comment);
END;
$labour_hire$;

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
    WHEN 'labour_hire'    THEN 'SWL-'
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
