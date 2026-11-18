SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

DO $guard$ BEGIN
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public.job_division_option(text,text)', ARRAY['c0c72acded3644ca4268f08761f777af'], false),
      ('public.stock_division_option(text)', ARRAY['861a07f6e2be7e00d10891a272c014f9'], false),
      ('public.job_division_option(text,text,uuid)', ARRAY['58669cd21b26a952aa57f2ead2189494'], false)
    ) AS expected(signature, allowed, may_be_absent)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(expected.signature)
    WHERE (p.oid IS NULL AND NOT expected.may_be_absent)
       OR (p.oid IS NOT NULL AND md5(p.prosrc) <> ALL(expected.allowed))
  ) THEN RAISE EXCEPTION 'division_option_body_changed'; END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.job_division_option(p_job_number text, p_job_type text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER AS $job$
  SELECT CASE
    WHEN job_type = 'granny_flat' THEN ''
    WHEN job_type = 'repair' THEN 'SW - MAKESAFE'
    WHEN job_type IN ('roofing', 'renovation') THEN 'SW - PRIVATE ROOFING'
    WHEN job_number LIKE 'SWRESTO-%' THEN 'SW - RESTORATION'
    WHEN job_number LIKE ANY (ARRAY['SWMS-%', 'AJBR%', 'MS1%', 'BWCWA%', 'WB6%']) THEN 'SW - MAKESAFE'
    WHEN job_number LIKE 'SWP%' THEN 'SW - PATIOS'
    WHEN job_number LIKE 'SWF%' THEN 'SW - FENCING'
    WHEN job_number LIKE 'SWD%' THEN 'SW - DECKING'
    WHEN job_number LIKE 'SWI%' THEN 'SW - INSURANCE WORK'
    ELSE ''
  END
  FROM (
    -- JavaScript trims the type with the ECMAScript whitespace set. The number is never trimmed.
    SELECT lower(btrim(p_job_type, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') COLLATE "und-x-icu") AS job_type,
           upper(p_job_number COLLATE "und-x-icu") AS job_number
  ) AS normalized
$job$;

-- Division stock is stored under one of these three keys in job_cost_line_parts.
CREATE OR REPLACE FUNCTION public.stock_division_option(p_division text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER AS $stock$
  SELECT CASE p_division
    WHEN 'patios' THEN 'SW - PATIOS'
    WHEN 'fencing' THEN 'SW - FENCING'
    WHEN 'insurance' THEN 'SW - INSURANCE WORK'
    ELSE ''
  END
$stock$;

DROP FUNCTION public.job_division_option(text, text, uuid);
