-- Reapply the actual file, not a copied definition.
\ir ../../../migrations/20261117172201_sweep_gate.sql
BEGIN;
DO $contract$
DECLARE token text := repeat('a', 32); changed text := repeat('b', 32); n int; fn regprocedure; BEGIN
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'sweep_gate_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'gate must be seeded off';
  END IF;
  FOR n IN 1..3 LOOP
    IF NOT public.sweep_gate_should_post('ZZTEST-gate', token, interval '6 hours') THEN
      RAISE EXCEPTION 'disabled gate suppressed a run';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.sweep_gate_state WHERE name = 'ZZTEST-gate') THEN
    RAISE EXCEPTION 'disabled gate wrote state';
  END IF;
  UPDATE public.feature_flags SET enabled = true WHERE flag_name = 'sweep_gate_v1';
  IF NOT public.sweep_gate_should_post('ZZTEST-gate', token, interval '6 hours') THEN
    RAISE EXCEPTION 'first run must post';
  END IF;
  -- Until a good run confirms, the same token must retry.
  IF NOT public.sweep_gate_should_post('ZZTEST-gate', token, interval '6 hours') THEN
    RAISE EXCEPTION 'unconfirmed run must retry';
  END IF;
  PERFORM public.sweep_gate_confirm('ZZTEST-gate', token);
  IF public.sweep_gate_should_post('ZZTEST-gate', token, interval '6 hours') THEN
    RAISE EXCEPTION 'unchanged confirmed run must skip';
  END IF;
  IF NOT public.sweep_gate_should_post('ZZTEST-gate', changed, interval '6 hours') THEN
    RAISE EXCEPTION 'changed token must post';
  END IF;
  UPDATE public.sweep_gate_state SET confirmed_at = now() - interval '7 hours' WHERE name = 'ZZTEST-gate';
  IF NOT public.sweep_gate_should_post('ZZTEST-gate', token, interval '6 hours') THEN
    RAISE EXCEPTION 'heartbeat must post';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sweep_gate_state'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.sweep_gate_state'::regclass) THEN
    RAISE EXCEPTION 'gate state must have RLS and no policies';
  END IF;
  FOREACH fn IN ARRAY ARRAY[
    'public.sweep_gate_tables_token(text[])'::regprocedure,
    'public.sweep_gate_should_post(text,text,interval)'::regprocedure,
    'public.sweep_gate_confirm(text,text)'::regprocedure,
    'public.materials_ingest_change_parts(uuid)'::regprocedure,
    'public.materials_ingest_change_token(uuid)'::regprocedure,
    'public.bill_prematch_change_token(uuid)'::regprocedure,
    'public.trigger_xero_sync_action_gated(text,text,text,interval)'::regprocedure
  ] LOOP
    IF has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE')
       OR NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'gate function grants are wrong: %', fn;
    END IF;
  END LOOP;
END $contract$;
ROLLBACK;

-- Statistics are visible after commit and a forced flush, not within a transaction.
CREATE TABLE public.sweep_gate_contract_probe (id integer);
SELECT pg_stat_force_next_flush();
CREATE TEMP TABLE sweep_gate_probe_before AS
  SELECT public.sweep_gate_tables_token(ARRAY['sweep_gate_contract_probe']) AS token;
DO $contract$ BEGIN
  IF (SELECT token FROM sweep_gate_probe_before) IS DISTINCT FROM
     public.sweep_gate_tables_token(ARRAY['sweep_gate_contract_probe']) THEN
    RAISE EXCEPTION 'unchanged table changed token';
  END IF;
END $contract$;
INSERT INTO public.sweep_gate_contract_probe VALUES (1);
SELECT pg_stat_force_next_flush();
SELECT pg_stat_clear_snapshot();
DO $contract$ BEGIN
  IF (SELECT token FROM sweep_gate_probe_before) IS NOT DISTINCT FROM
     public.sweep_gate_tables_token(ARRAY['sweep_gate_contract_probe']) THEN
    RAISE EXCEPTION 'committed insert did not change token';
  END IF;
END $contract$;
DROP TABLE public.sweep_gate_contract_probe;
