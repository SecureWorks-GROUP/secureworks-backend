-- Earlier registered cases provide public.feature_flags.
DO $$ BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'commission switch setup: feature_flags missing';
  END IF;
END $$;
