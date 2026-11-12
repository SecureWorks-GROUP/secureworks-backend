-- Rollback for 20261112150000_next_job_number_restoration: removes the
-- 'restoration' branch, so a restoration request answers SW- again (ops-api then
-- numbers the card SWMS-). Numbers already minted SWRESTO- are left as they are.

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
