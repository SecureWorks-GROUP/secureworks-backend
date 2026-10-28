-- Contract for 20261028160000_context_jev_off.sql. Fixture writes roll back.

-- 1. After the forward stack every Jev switch is off, and the rows are still there.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
             WHERE (flag_name IN ('context_jev_shadow_v1','context_jev_gate_decides_v1') OR flag_name LIKE 'context\_jev\_point\_%')
               AND enabled IS DISTINCT FROM false) THEN
    RAISE EXCEPTION 'jev off contract: a Jev switch is still on';
  END IF;
  IF (SELECT count(*) FROM public.feature_flags WHERE flag_name IN ('context_jev_shadow_v1','context_jev_gate_decides_v1')) <> 2 THEN
    RAISE EXCEPTION 'jev off contract: a Jev flag row is missing';
  END IF;
END $$;

-- 2. Switches that were on are turned off; other flags are left alone; the reserve is untouched.
BEGIN;
UPDATE public.feature_flags SET enabled = true
WHERE flag_name IN ('context_jev_shadow_v1','context_jev_gate_decides_v1') OR flag_name LIKE 'context\_jev\_point\_%';
INSERT INTO public.feature_flags (flag_name, enabled, description) VALUES ('context_jevish_other_v1', true, 'fixture');
UPDATE public.context_cadence_settings SET live_reserve_calls_day = 100, live_reserve_calls_morning = 100 WHERE id;
\ir ../../../migrations/20261028160000_context_jev_off.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
             WHERE (flag_name IN ('context_jev_shadow_v1','context_jev_gate_decides_v1') OR flag_name LIKE 'context\_jev\_point\_%')
               AND enabled) THEN
    RAISE EXCEPTION 'jev off contract: a switched-on Jev flag was not turned off';
  END IF;
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'context_jevish_other_v1') IS NOT TRUE THEN
    RAISE EXCEPTION 'jev off contract: an unrelated flag was changed';
  END IF;
  IF (SELECT (live_reserve_calls_day, live_reserve_calls_morning) FROM public.context_cadence_settings WHERE id) IS DISTINCT FROM (100, 100) THEN
    RAISE EXCEPTION 'jev off contract: the live reserve was changed';
  END IF;
END $$;
ROLLBACK;
