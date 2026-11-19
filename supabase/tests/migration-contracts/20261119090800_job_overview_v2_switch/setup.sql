-- Earlier registered cases provide public.feature_flags.
DO $$ BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'job overview v2 switch setup: feature_flags missing';
  END IF;
END $$;
