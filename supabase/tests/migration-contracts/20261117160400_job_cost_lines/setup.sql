-- The registered stack already supplies these prerequisites. No live reads.
DO $$
DECLARE prerequisite text;
BEGIN
  FOREACH prerequisite IN ARRAY ARRAY['public.jobs', 'public.feature_flags'] LOOP
    IF to_regclass(prerequisite) IS NULL THEN
      RAISE EXCEPTION 'cost lines setup: missing %', prerequisite;
    END IF;
  END LOOP;
  FOREACH prerequisite IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = prerequisite) THEN
      RAISE EXCEPTION 'cost lines setup: missing role %', prerequisite;
    END IF;
  END LOOP;
END;
$$;
