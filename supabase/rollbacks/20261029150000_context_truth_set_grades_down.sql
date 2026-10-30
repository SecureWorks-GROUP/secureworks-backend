-- Rollback of 20261029150000_context_truth_set_grades (TP-19 truth sets, v2).
--
-- Drops the seven functions and the two tables. It REFUSES while any set or grade is stored, so a graded set is
-- never dropped by accident: unload each set first with scripts/context-truth-set-grades-load-undo.sql (one set at
-- a time, exact count), then run this file. Nothing else was created or changed by the forward migration: no
-- business row, flag, cron job or trigger, and no existing function was replaced, so nothing else needs restoring.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $guard$
BEGIN
 IF (to_regclass('public.context_truth_set_grades') IS NOT NULL AND EXISTS (SELECT 1 FROM public.context_truth_set_grades))
    OR (to_regclass('public.context_truth_set_sets') IS NOT NULL AND EXISTS (SELECT 1 FROM public.context_truth_set_sets)) THEN
  RAISE EXCEPTION 'context_truth_set_grades_rollback_refused: sets or graded rows are stored; unload them with scripts/context-truth-set-grades-load-undo.sql first';
 END IF;
END $guard$;

DROP FUNCTION IF EXISTS public.context_truth_set_results(timestamptz);
DROP FUNCTION IF EXISTS public.context_truth_set_ratio(jsonb, bigint, bigint);
DROP FUNCTION IF EXISTS public.context_truth_set_draw_digest(jsonb);
DROP TABLE IF EXISTS public.context_truth_set_grades;
DROP TABLE IF EXISTS public.context_truth_set_sets;
DROP FUNCTION IF EXISTS public.context_truth_set_strata_ok(text, jsonb, integer, integer);
DROP FUNCTION IF EXISTS public.context_truth_set_ex_sum(numeric[]);
DROP FUNCTION IF EXISTS public.context_truth_set_ex_ok(numeric[], integer);
DROP FUNCTION IF EXISTS public.context_truth_set_ids_ok(uuid[]);
