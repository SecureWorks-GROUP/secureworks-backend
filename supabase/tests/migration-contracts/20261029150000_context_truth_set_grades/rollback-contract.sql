-- After the truth-set grades rollback: the table and its three functions are gone, and what they sat beside is
-- untouched.
DO $$
BEGIN
 IF to_regclass('public.context_truth_set_grades') IS NOT NULL THEN RAISE EXCEPTION 'truth set rollback: the table was left behind'; END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname LIKE 'context_truth_set_%') THEN
  RAISE EXCEPTION 'truth set rollback: a context_truth_set_ function was left behind';
 END IF;
 IF to_regclass('public.jobs') IS NULL THEN RAISE EXCEPTION 'truth set rollback: public.jobs was lost'; END IF;
 IF to_regclass('public.context_placement_grades') IS NOT NULL AND to_regclass('public.context_grades') IS NULL THEN
  RAISE EXCEPTION 'truth set rollback: public.context_grades was lost';
 END IF;
END $$;
