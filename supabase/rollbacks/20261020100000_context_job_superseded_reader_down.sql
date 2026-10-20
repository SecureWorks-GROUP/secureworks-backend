-- Rollback of 20261020100000_context_job_superseded_reader: the reader
-- public.context_job_superseded_during(uuid, timestamptz) and the switch row
-- feature_flags.context_job_superseded_reader_v1 are removed. Nothing else is
-- touched: no other function, flag row or business row. No consumer reads
-- either yet, so nothing depends on them. A second run changes nothing.
--
-- Refuses when the reader present is not this migration's (its comment does
-- not carry the slice name), so a later body is never dropped by this file.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
DECLARE cmt text;
BEGIN
 IF to_regprocedure('public.context_job_superseded_during(uuid,timestamp with time zone)') IS NOT NULL THEN
  cmt := coalesce(obj_description(to_regprocedure('public.context_job_superseded_during(uuid,timestamp with time zone)'), 'pg_proc'), '');
  IF cmt NOT LIKE 'Job superseded reader (20261020100000)%' THEN
   RAISE EXCEPTION 'context_job_superseded_reader_down_refused: the reader present is not this migration''s';
  END IF;
 END IF;
END $guard$;

DROP FUNCTION IF EXISTS public.context_job_superseded_during(uuid, timestamptz);

DO $flag$
BEGIN
 IF to_regclass('public.feature_flags') IS NOT NULL THEN
  DELETE FROM public.feature_flags WHERE flag_name = 'context_job_superseded_reader_v1';
 END IF;
END $flag$;
