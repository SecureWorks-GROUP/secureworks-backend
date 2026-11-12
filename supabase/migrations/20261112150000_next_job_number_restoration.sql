-- Restoration jobs are numbered SWRESTO- (owner, 12 Nov 2026: restoration work
-- is not a make-safe and should not read as one).
--
-- Adds one branch to next_job_number: 'restoration' -> 'SWRESTO-'. It draws from
-- the same yearly counter as every other prefix, so numbers never collide across
-- prefixes. jobs.type is NOT widened: a restoration card stays jobs.type
-- 'makesafe' (family 'restoration'), so every board, money fence and view that
-- reads the type keeps finding it. Only ops-api createMakesafeJob asks for this
-- prefix, and only for a restoration-family card; with this migration absent the
-- RPC answers SW- and ops-api numbers the card SWMS- as before.
--
-- Every other branch is copied unchanged from the live body (read 12 Nov 2026).

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
