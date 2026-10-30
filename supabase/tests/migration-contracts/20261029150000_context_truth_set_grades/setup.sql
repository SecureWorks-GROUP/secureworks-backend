-- Prerequisites for 20261029150000_context_truth_set_grades (v2): nothing new. It reads no table and calls no
-- function of another migration (the truth-set loader reads jobs, xero_invoices, business_events and
-- context_job_story_texts; the migration does not). The three roles it grants to are created by earlier registered
-- cases. This check fails early, and by name, if one is missing, and proves the migration's names are free.
DO $$
DECLARE r text;
BEGIN
 IF to_regclass('public.jobs') IS NULL THEN RAISE EXCEPTION 'truth set setup: public.jobs is missing from the registered stack'; END IF;
 FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN RAISE EXCEPTION 'truth set setup: role % is missing', r; END IF;
 END LOOP;
 IF to_regclass('public.context_truth_set_grades') IS NOT NULL OR to_regclass('public.context_truth_set_sets') IS NOT NULL
  OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname LIKE 'context\_truth\_set\_%') THEN
  RAISE EXCEPTION 'truth set setup: a context_truth_set_ name exists before the migration';
 END IF;
END $$;
-- Supabase's default privileges grant EXECUTE on every new public function to anon and authenticated directly (not
-- only through PUBLIC), and ALL on every new table. Give this database the same defaults, so the contract's
-- privilege checks prove the migration's REVOKEs, not the harness's defaults. Default privileges belong to this
-- database, which every phase recreates.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
