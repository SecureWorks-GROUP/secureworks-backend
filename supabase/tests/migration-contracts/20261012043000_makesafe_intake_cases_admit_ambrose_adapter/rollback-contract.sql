-- After the down migration a new Ambrose case is refused again, a stored one
-- survives, and the other adapters are unaffected.
BEGIN;
DO $$
DECLARE
  org constant uuid := '00000000-0000-0000-0000-000000000001';
  cursor_ok constant jsonb :=
    '{"version":1,"searchedSourcePostIds":[],"sideEffectKeys":{}}'::jsonb;
BEGIN
  BEGIN
    INSERT INTO public.makesafe_intake_cases (
      org_id, state, reason_code, adapter_id, adapter_version,
      manifest_version, source_fingerprint, recovery_cursor
    ) VALUES (
      org, 'exception', 'adapter_parse_failure', 'ambrose', 'ambrose@v1',
      'manifest@v1', 'fingerprint', cursor_ok
    );
    RAISE EXCEPTION 'adapter admission rollback: ambrose is still admitted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  INSERT INTO public.makesafe_intake_cases (
    org_id, state, reason_code, adapter_id, adapter_version,
    manifest_version, source_fingerprint, recovery_cursor
  ) VALUES (
    org, 'exception', 'adapter_parse_failure', 'mlb', 'mlb@v1',
    'manifest@v1', 'fingerprint', cursor_ok
  );
  IF NOT EXISTS (
    SELECT 1 FROM public.makesafe_intake_cases
    WHERE id = 'a0000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'adapter admission rollback: the pre-existing case is gone';
  END IF;
  -- NOT VALID is what lets the down migration run while Ambrose cases exist.
  IF (
    SELECT convalidated FROM pg_constraint
    WHERE conrelid = 'public.makesafe_intake_cases'::regclass
      AND conname = 'makesafe_intake_cases_deterministic_shapes_check'
  ) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'adapter admission rollback: constraint was re-validated';
  END IF;
END $$;
ROLLBACK;
