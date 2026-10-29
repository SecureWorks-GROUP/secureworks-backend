-- Prerequisites for 20261029150000_context_truth_set_grades: nothing new. It reads no table and calls no function
-- of another migration (the truth-set loader reads jobs, xero_invoices and business_events; the migration does not).
-- The three roles it grants to are created by earlier registered cases. This check fails early, and by name, if one
-- is missing, and proves the migration's names are free.
DO $$
DECLARE r text;
BEGIN
 IF to_regclass('public.jobs') IS NULL THEN RAISE EXCEPTION 'truth set setup: public.jobs is missing from the registered stack'; END IF;
 FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN RAISE EXCEPTION 'truth set setup: role % is missing', r; END IF;
 END LOOP;
 IF to_regclass('public.context_truth_set_grades') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname LIKE 'context_truth_set_%') THEN
  RAISE EXCEPTION 'truth set setup: a context_truth_set_ name exists before the migration';
 END IF;
END $$;
