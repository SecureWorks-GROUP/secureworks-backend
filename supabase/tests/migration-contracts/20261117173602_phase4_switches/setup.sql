-- Earlier registered contracts supply the feature_flags table.
DO $$ BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'phase4 switches setup: feature_flags missing';
  END IF;
END $$;
