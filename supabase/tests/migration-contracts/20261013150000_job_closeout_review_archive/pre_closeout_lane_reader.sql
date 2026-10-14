-- automation_lane_enabled() as 20260911170000 wrote it (md5(prosrc)
-- 818a13be854748e2d272bdd648c88b59): capture, attribution, extraction. The paid
-- close-out (20261013150000) adds closeout to its closed list. Earlier migrations whose
-- re-apply guards pin this body (20261002100000, 20261002120000, 20261005210000,
-- 20261006001000) stand it back up with this file inside their rolled-back re-apply
-- blocks, so each re-apply is tested against the pre-image it was written for.
CREATE OR REPLACE FUNCTION public.automation_lane_enabled(lane text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_all_stop boolean;
  v_lane     boolean;
BEGIN
  IF lane IS NULL THEN
    RETURN false;
  END IF;
  IF lane NOT IN ('capture', 'attribution', 'extraction') THEN
    RETURN false;
  END IF;
  IF to_regclass('public.automation_switches') IS NULL THEN
    RETURN false;
  END IF;

  EXECUTE format(
    'SELECT s.all_stop, s.%I FROM public.automation_switches s WHERE s.id = 1',
    lane
  ) INTO v_all_stop, v_lane;

  -- No row at all: both come back null, which is off.
  IF v_all_stop IS NULL OR v_lane IS NULL THEN
    RETURN false;
  END IF;
  IF v_all_stop THEN
    RETURN false;
  END IF;
  RETURN v_lane;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$fn$;
