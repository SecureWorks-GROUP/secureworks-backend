-- 20261112150000: restoration mints SWRESTO-, every other prefix is unchanged,
-- and all prefixes share one counter.
BEGIN;
DO $$
DECLARE
  yr text := ((EXTRACT(YEAR FROM now())::int % 100))::text;
  a text; b text; c text; r text;
BEGIN
  a := public.next_job_number('restoration');
  IF a NOT LIKE 'SWRESTO-' || yr || '%' THEN
    RAISE EXCEPTION 'restoration must mint SWRESTO-<yy>..., got %', a;
  END IF;
  b := public.next_job_number('makesafe');
  IF b NOT LIKE 'SWMS-' || yr || '%' THEN
    RAISE EXCEPTION 'makesafe must still mint SWMS-, got %', b;
  END IF;
  r := public.next_job_number('repair');
  IF r NOT LIKE 'SWR-' || yr || '%' THEN
    RAISE EXCEPTION 'repair must still mint SWR-, got %', r;
  END IF;
  c := public.next_job_number('Restoration');
  IF c NOT LIKE 'SWRESTO-%' THEN
    RAISE EXCEPTION 'the type is read case-insensitively, got %', c;
  END IF;
  IF substr(b, length('SWMS-' || yr) + 1)::int <> substr(a, length('SWRESTO-' || yr) + 1)::int + 1 THEN
    RAISE EXCEPTION 'restoration must draw from the shared yearly counter: % then %', a, b;
  END IF;
  IF public.next_job_number('unknown_type') NOT LIKE 'SW-%' THEN
    RAISE EXCEPTION 'unknown types must still fall back to SW-';
  END IF;
END $$;
ROLLBACK;
