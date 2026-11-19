-- Earlier registered cases provide public.feature_flags and the service role.
DO $$ BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'xero doc attach switches setup: feature_flags missing';
  END IF;
END $$;
