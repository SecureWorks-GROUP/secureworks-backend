-- The SQL division rule learns labour hire (owner, 20 Nov 2026: labour hire is
-- its own job type and its own Xero Business Unit, "SW - LABOUR HIRE").
--
-- This is the SQL twin of divisionTrackingOption in
-- supabase/functions/_shared/xero_draft_standard.ts; both read the examples in
-- supabase/functions/_shared/division_examples.json. Two branches are added to
-- the body 20261118120115_division_rulings installed, and nothing else moves:
--   - a job typed 'labour_hire' is SW - LABOUR HIRE whatever its number (this is
--     what covers the four older labour hire jobs that keep their SWM- numbers);
--   - an SWLH- number is SW - LABOUR HIRE unless an explicit type rule above it
--     already answered.
-- The two-argument wrapper and stock_division_option are untouched. Grants are
-- kept by CREATE OR REPLACE. It names an option; it never creates one in Xero.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

DO $guard$ BEGIN
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public.job_division_option(text,text)', ARRAY['c0c72acded3644ca4268f08761f777af']),
      ('public.job_division_option(text,text,uuid)', ARRAY['58669cd21b26a952aa57f2ead2189494', '387e0eb966d0e8bb02fe7546e6bbeba2'])
    ) AS expected(signature, allowed)
    LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(expected.signature)
    WHERE p.oid IS NULL OR md5(p.prosrc) <> ALL(expected.allowed)
  ) THEN RAISE EXCEPTION 'division_option_body_changed'; END IF;
END $guard$;

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
    WHEN job_type = 'labour_hire' THEN 'SW - LABOUR HIRE'
    WHEN job_type = 'repair' THEN 'SW - MAKESAFE'
    WHEN job_type IN ('roofing', 'renovation') THEN 'SW - PRIVATE ROOFING'
    WHEN job_number_upper LIKE 'SWRESTO-%' THEN 'SW - RESTORATION'
    WHEN job_number_upper LIKE 'SWLH-%' THEN 'SW - LABOUR HIRE'
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
