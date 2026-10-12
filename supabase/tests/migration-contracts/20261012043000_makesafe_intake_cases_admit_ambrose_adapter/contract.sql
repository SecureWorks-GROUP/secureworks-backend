-- The table now stores a case read by the Ambrose adapter, still stores every
-- adapter it stored before, still refuses an adapter nobody registered, and
-- still demands the deterministic shape that goes with an adapter.
BEGIN;
DO $$
DECLARE
  adapter text;
  org constant uuid := '00000000-0000-0000-0000-000000000001';
  cursor_ok constant jsonb :=
    '{"version":1,"searchedSourcePostIds":[],"sideEffectKeys":{}}'::jsonb;
BEGIN
  -- Every id the table admitted before, plus ambrose.
  FOREACH adapter IN ARRAY ARRAY[
    'mlb', 'ajs_ajbr', 'prime', 'rapid', 'builderwest', 'western',
    'chatter', 'synthetic_livefire', 'ambrose'
  ] LOOP
    BEGIN
      INSERT INTO public.makesafe_intake_cases (
        org_id, state, reason_code, adapter_id, adapter_version,
        manifest_version, source_fingerprint, recovery_cursor
      ) VALUES (
        org, 'exception', 'adapter_parse_failure', adapter, adapter || '@v1',
        'manifest@v1', 'fingerprint', cursor_ok
      );
    EXCEPTION WHEN check_violation THEN
      RAISE EXCEPTION 'adapter admission contract: % is refused', adapter;
    END;
  END LOOP;

  -- No adapter at all stays valid (the stripped persistence-failure fallback).
  INSERT INTO public.makesafe_intake_cases (org_id, state, reason_code)
  VALUES (org, 'exception', 'adapter_parse_failure');

  -- An adapter nobody registered is still refused, by this constraint.
  BEGIN
    INSERT INTO public.makesafe_intake_cases (
      org_id, state, reason_code, adapter_id, adapter_version,
      manifest_version, source_fingerprint, recovery_cursor
    ) VALUES (
      org, 'exception', 'adapter_parse_failure', 'not_an_adapter', 'x@v1',
      'manifest@v1', 'fingerprint', cursor_ok
    );
    RAISE EXCEPTION 'adapter admission contract: an unregistered adapter was stored';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- The shape that goes with an adapter is unchanged: no blank version, and
  -- the recovery cursor keeps its three keys.
  BEGIN
    INSERT INTO public.makesafe_intake_cases (
      org_id, state, reason_code, adapter_id, adapter_version,
      manifest_version, source_fingerprint, recovery_cursor
    ) VALUES (
      org, 'exception', 'adapter_parse_failure', 'ambrose', ' ',
      'manifest@v1', 'fingerprint', cursor_ok
    );
    RAISE EXCEPTION 'adapter admission contract: a blank adapter version was stored';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO public.makesafe_intake_cases (
      org_id, state, reason_code, adapter_id, adapter_version,
      manifest_version, source_fingerprint, recovery_cursor
    ) VALUES (
      org, 'exception', 'adapter_parse_failure', 'ambrose', 'ambrose@v1',
      'manifest@v1', 'fingerprint', '{"version":1}'::jsonb
    );
    RAISE EXCEPTION 'adapter admission contract: an incomplete recovery cursor was stored';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- The case stored before the migration is untouched.
  IF NOT EXISTS (
    SELECT 1 FROM public.makesafe_intake_cases
    WHERE id = 'a0000000-0000-4000-8000-000000000001'
      AND adapter_id IS NULL AND state = 'exception'
  ) THEN
    RAISE EXCEPTION 'adapter admission contract: the pre-existing case changed';
  END IF;

  -- One validated constraint of this name, not a NOT VALID stand-in.
  IF (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'public.makesafe_intake_cases'::regclass
      AND conname = 'makesafe_intake_cases_deterministic_shapes_check'
      AND convalidated
  ) <> 1 THEN
    RAISE EXCEPTION 'adapter admission contract: constraint missing or not validated';
  END IF;
END $$;
ROLLBACK;

-- Re-applying is a no-op that keeps admitting ambrose.
BEGIN;
\ir ../../../migrations/20261012043000_makesafe_intake_cases_admit_ambrose_adapter.sql
INSERT INTO public.makesafe_intake_cases (
  org_id, state, reason_code, adapter_id, adapter_version,
  manifest_version, source_fingerprint, recovery_cursor
) VALUES (
  '00000000-0000-0000-0000-000000000001', 'exception',
  'adapter_parse_failure', 'ambrose', 'ambrose@v1', 'manifest@v1',
  'fingerprint',
  '{"version":1,"searchedSourcePostIds":[],"sideEffectKeys":{}}'::jsonb
);
ROLLBACK;
