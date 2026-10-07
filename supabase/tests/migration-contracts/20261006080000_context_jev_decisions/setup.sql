-- Prerequisites for 20261006080000_context_jev_decisions: nothing new. The one
-- table it reads besides its own (feature_flags) and the three roles it grants
-- to are created by earlier registered cases. This check fails early, and by
-- name, if one is missing, and proves the flag row is not there yet.
DO $$
DECLARE r text;
BEGIN
 IF to_regclass('public.feature_flags') IS NULL THEN
  RAISE EXCEPTION 'jev setup: public.feature_flags is missing from the registered stack';
 END IF;
 FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN RAISE EXCEPTION 'jev setup: role % is missing', r; END IF;
 END LOOP;
 IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'context_jev_shadow_v1') THEN
  RAISE EXCEPTION 'jev setup: the flag row exists before the migration';
 END IF;
END $$;
