SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

DO $guard$ BEGIN
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public.job_division_option(text,text)', ARRAY['3f7f48236215e19085a7ef632a7f47b8', 'c0c72acded3644ca4268f08761f777af'], false),
      ('public.stock_division_option(text)', ARRAY['60fa26bb67c188cd08e3d1f493ef5801', '861a07f6e2be7e00d10891a272c014f9'], false),
      ('public.job_division_option(text,text,uuid)', ARRAY['58669cd21b26a952aa57f2ead2189494'], true)
    ) AS expected(signature, allowed, may_be_absent)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(expected.signature)
    WHERE (p.oid IS NULL AND NOT expected.may_be_absent)
       OR (p.oid IS NOT NULL AND md5(p.prosrc) <> ALL(expected.allowed))
  ) THEN RAISE EXCEPTION 'division_option_body_changed'; END IF;
END $guard$;

-- Read as the caller. The two-argument tie-out uses the job's own organisation.
CREATE OR REPLACE FUNCTION public.job_division_option(p_job_number text, p_job_type text, p_org_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY INVOKER AS $rule$
DECLARE
  job_type text := lower(btrim(p_job_type, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') COLLATE "und-x-icu");
  job_number_upper text := upper(p_job_number COLLATE "und-x-icu");
  option_org uuid := p_org_id; BEGIN
  IF job_type IN ('misc', 'miscellaneous', 'general') THEN
    -- A tie-out has a persisted job number. A draft can already know its org before mint.
    IF option_org IS NULL AND p_job_number IS NOT NULL THEN
      SELECT j.org_id INTO STRICT option_org FROM public.jobs j WHERE j.job_number = p_job_number;
    END IF;
    IF option_org IS NULL THEN RETURN ''; END IF;
    RETURN CASE WHEN EXISTS (
      SELECT 1 FROM public.xero_tracking_options o
      WHERE o.org_id = option_org AND o.status = 'ACTIVE' AND o.option_name = 'Private Renovations'
    ) THEN 'Private Renovations' ELSE '' END;
  END IF;
  RETURN CASE
    WHEN job_type = 'granny_flat' THEN 'SecureBuild'
    WHEN job_type = 'repair' THEN 'SW - MAKESAFE'
    WHEN job_type IN ('roofing', 'renovation') THEN 'SW - PRIVATE ROOFING'
    WHEN job_number_upper LIKE 'SWRESTO-%' THEN 'SW - RESTORATION'
    WHEN job_number_upper LIKE ANY (ARRAY['SWMS-%', 'AJBR%', 'MS1%', 'BWCWA%', 'WB6%']) THEN 'SW - MAKESAFE'
    WHEN job_number_upper LIKE 'SWP%' THEN 'SW - PATIOS'
    WHEN job_number_upper LIKE 'SWF%' THEN 'SW - FENCING'
    WHEN job_number_upper LIKE 'SWD%' THEN 'SW - DECKING'
    WHEN job_number_upper LIKE 'SWI%' THEN 'SW - INSURANCE WORK'
    ELSE ''
  END;
EXCEPTION
  WHEN no_data_found OR too_many_rows OR insufficient_privilege THEN RETURN '';
END
$rule$;

CREATE OR REPLACE FUNCTION public.job_division_option(p_job_number text, p_job_type text)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER AS $job$
  SELECT public.job_division_option(p_job_number, p_job_type, NULL::uuid)
$job$;

CREATE OR REPLACE FUNCTION public.stock_division_option(p_division text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER AS $stock$
  SELECT CASE p_division
    WHEN 'patios' THEN 'SW - PATIOS'
    WHEN 'fencing' THEN 'SW - FENCING'
    WHEN 'insurance' THEN 'SW - INSURANCE WORK'
    ELSE CASE WHEN lower(btrim(p_division, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') COLLATE "und-x-icu")
                        IN ('fuel', 'parking', 'meals') THEN 'SW Group' ELSE '' END
  END
$stock$;

REVOKE ALL ON FUNCTION public.job_division_option(text,text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_division_option(text,text,uuid) TO authenticated, service_role;
