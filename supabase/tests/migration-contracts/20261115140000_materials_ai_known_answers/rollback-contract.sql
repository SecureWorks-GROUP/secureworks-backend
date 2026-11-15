-- After the down: both functions are gone, the tables they read are untouched, a second run of the down is a no-op,
-- and the migration applies again on top of it.
DO $$
BEGIN
  IF to_regprocedure('public.materials_ai_known_answers()') IS NOT NULL
     OR to_regprocedure('public.materials_ai_accuracy_by_supplier()') IS NOT NULL THEN
    RAISE EXCEPTION 'materials ai known answers rollback: a function is still there';
  END IF;
  IF to_regclass('public.materials_ai_placements') IS NULL OR to_regclass('public.v_bookkeeping_line_evidence_current') IS NULL THEN
    RAISE EXCEPTION 'materials ai known answers rollback: the down removed something it does not own';
  END IF;
END $$;
\ir ../../../rollbacks/20261115140000_materials_ai_known_answers_down.sql
\ir ../../../migrations/20261115140000_materials_ai_known_answers.sql
DO $$
BEGIN
  IF to_regprocedure('public.materials_ai_known_answers()') IS NULL OR to_regprocedure('public.materials_ai_accuracy_by_supplier()') IS NULL THEN
    RAISE EXCEPTION 'materials ai known answers rollback: the migration did not apply again after the down';
  END IF;
END $$;
