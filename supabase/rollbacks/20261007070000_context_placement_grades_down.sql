-- Rollback of 20261007070000_context_placement_grades (row 3 data source).
--
-- Drops the seven read functions and the grades table. It REFUSES while any
-- grade is stored, so a graded sample is never dropped by accident: unload a
-- sample first with scripts/context-placement-grades-load-undo.sql (one sample
-- at a time, exact count), then run this file. Nothing else was created or
-- changed by the forward migration: no business row, binding, flag, cron job or
-- trigger, and no existing function was replaced, so nothing else needs
-- restoring. Rows the misfile repair, thread retire or bucket re-run scripts
-- moved are NOT put back by this file; each script has its own undo.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
 IF to_regclass('public.context_placement_grades') IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.context_placement_grades) THEN
  RAISE EXCEPTION 'context_placement_grades_rollback_refused: % graded rows are stored; unload them with scripts/context-placement-grades-load-undo.sql first',
   (SELECT count(*) FROM public.context_placement_grades);
 END IF;
END $guard$;

DROP FUNCTION IF EXISTS public.context_placement_misfile_counts(timestamptz);
DROP FUNCTION IF EXISTS public.context_placement_misfile_plan();
DROP FUNCTION IF EXISTS public.context_placement_grades_newest(timestamptz);
DROP FUNCTION IF EXISTS public.context_placement_grade_card(uuid, uuid);
DROP FUNCTION IF EXISTS public.context_placement_sample(timestamptz, integer, text, integer);
DROP FUNCTION IF EXISTS public.context_placement_population(timestamptz, integer);
DROP TABLE IF EXISTS public.context_placement_grades;
DROP FUNCTION IF EXISTS public.context_placement_stratum(text, text, text);
