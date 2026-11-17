-- Earlier registered cases own feature_flags and the Supabase roles.
DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'match tables setup: feature_flags is missing from the registered stack';
  END IF;
END $$;
