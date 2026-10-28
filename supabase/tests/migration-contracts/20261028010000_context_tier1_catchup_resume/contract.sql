-- Contract for 20261028010000_context_tier1_catchup_resume.sql. Fixture writes roll back.

-- 1. After the forward stack: the tier 1 switch exists (on here, off once 20261028160000 has switched
--    Jev off); the reserve is at or under 100.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_jev_gate_decides_v1') THEN
    RAISE EXCEPTION 'tier1 contract: context_jev_gate_decides_v1 is missing';
  END IF;
  IF (SELECT live_reserve_calls_day FROM public.context_cadence_settings WHERE id) > 100
     OR (SELECT live_reserve_calls_morning FROM public.context_cadence_settings WHERE id) > 100 THEN
    RAISE EXCEPTION 'tier1 contract: the live reserve is still over 100';
  END IF;
END $$;

-- 2. A paused reserve (the whole cap kept back) is lowered to 100 and 100, with the old values in the note;
--    the per-job reserve is untouched.
BEGIN;
UPDATE public.context_cadence_settings SET live_reserve_calls_day = 1000, live_reserve_calls_morning = 750, live_reserve_reads_per_job = 3 WHERE id;
\ir ../../../migrations/20261028010000_context_tier1_catchup_resume.sql
DO $$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM public.context_cadence_settings WHERE id;
  IF s.live_reserve_calls_day <> 100 OR s.live_reserve_calls_morning <> 100 OR s.live_reserve_reads_per_job <> 3 THEN
    RAISE EXCEPTION 'tier1 contract: paused reserve became % / % / %', s.live_reserve_calls_day, s.live_reserve_calls_morning, s.live_reserve_reads_per_job;
  END IF;
  IF s.note NOT LIKE '%was day 1000, morning 750.' THEN
    RAISE EXCEPTION 'tier1 contract: the note does not keep the old reserve: %', s.note;
  END IF;
END $$;
ROLLBACK;

-- 3. Lowering only: a reserve already under 100 is left as it is, note included.
BEGIN;
UPDATE public.context_cadence_settings SET live_reserve_calls_day = 50, live_reserve_calls_morning = 80, note = 'desk' WHERE id;
\ir ../../../migrations/20261028010000_context_tier1_catchup_resume.sql
DO $$
BEGIN
  IF (SELECT (live_reserve_calls_day, live_reserve_calls_morning, note) FROM public.context_cadence_settings WHERE id) IS DISTINCT FROM (50, 80, 'desk'::text) THEN
    RAISE EXCEPTION 'tier1 contract: a reserve under 100 was changed';
  END IF;
END $$;
ROLLBACK;

-- 4. Re-applying never switches tier 1 back on once someone has turned it off, and keeps one row.
BEGIN;
UPDATE public.feature_flags SET enabled = false WHERE flag_name = 'context_jev_gate_decides_v1';
\ir ../../../migrations/20261028010000_context_tier1_catchup_resume.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM public.feature_flags WHERE flag_name = 'context_jev_gate_decides_v1') <> 1
     OR (SELECT enabled FROM public.feature_flags WHERE flag_name = 'context_jev_gate_decides_v1') IS NOT FALSE THEN
    RAISE EXCEPTION 'tier1 contract: re-applying switched tier 1 back on or duplicated the flag';
  END IF;
END $$;
ROLLBACK;

-- 5. A missing settings row is created at the defaults, which are already the resumed values.
BEGIN;
DELETE FROM public.context_cadence_settings;
\ir ../../../migrations/20261028010000_context_tier1_catchup_resume.sql
DO $$
BEGIN
  IF (SELECT (live_reserve_calls_day, live_reserve_calls_morning) FROM public.context_cadence_settings WHERE id) IS DISTINCT FROM (100, 100) THEN
    RAISE EXCEPTION 'tier1 contract: a missing settings row was not created at 100 / 100';
  END IF;
END $$;
ROLLBACK;
