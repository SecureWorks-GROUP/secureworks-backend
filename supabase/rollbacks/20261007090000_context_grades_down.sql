-- Rollback of 20261007090000_context_grades (the grades table, its reads and
-- the published catalogue of ledger item kinds).
--
-- Refuses while any graded row is stored: a grade is the record that rows 7,
-- 8 and 9 were measured, and it is never dropped by accident. To roll back
-- with grades stored, first remove each loaded sample with
-- scripts/context-grades-load-undo.sql (the owner's go), then run this.
-- With the table empty it drops the two reads, the table, the pass rule, the
-- verdict check and the catalogue. Nothing else was created or changed by the
-- forward migration: no flag, cron job, trigger, grant on another object or
-- business row. One statement, so a refusal leaves everything as it was.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $down$
DECLARE n bigint;
BEGIN
 IF to_regclass('public.context_grades') IS NOT NULL THEN
  EXECUTE 'SELECT count(*) FROM public.context_grades' INTO n;
  IF n > 0 THEN
   RAISE EXCEPTION 'context_grades_rollback_refused: % graded rows are stored; remove each sample with scripts/context-grades-load-undo.sql first', n;
  END IF;
 END IF;
 DROP FUNCTION IF EXISTS public.context_grades_newest(timestamptz);
 DROP FUNCTION IF EXISTS public.context_grade_samples(timestamptz);
 DROP TABLE IF EXISTS public.context_grades;
 DROP FUNCTION IF EXISTS public.context_grade_passed(text, text, jsonb);
 DROP FUNCTION IF EXISTS public.context_grade_verdicts_problem(text, text, jsonb);
 DROP FUNCTION IF EXISTS public.context_item_kinds();
END $down$;
