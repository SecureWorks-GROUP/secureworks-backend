-- Non-production rollback for SES Reporting U2 board reconciliation surfaces.
-- Operational jobs, substatuses, assignments, invoices and communications are
-- never touched.

DROP FUNCTION IF EXISTS public.apply_makesafe_board_reconciliation(
  text, text, text, jsonb
);
DROP VIEW IF EXISTS public.makesafe_board_attention_current;
DROP TRIGGER IF EXISTS trg_makesafe_board_reconciliation_runs_append_only
  ON public.makesafe_board_reconciliation_runs;
DROP TABLE IF EXISTS public.makesafe_board_reconciliation_runs;
DROP TRIGGER IF EXISTS trg_makesafe_board_attention_marks_append_only
  ON public.makesafe_board_attention_marks;
DROP TRIGGER IF EXISTS trg_makesafe_board_attention_marks_insert_guard
  ON public.makesafe_board_attention_marks;
DROP TABLE IF EXISTS public.makesafe_board_attention_marks;
DROP FUNCTION IF EXISTS public.reject_makesafe_board_attention_mark_mutation();
DROP FUNCTION IF EXISTS public.guard_makesafe_board_attention_mark_insert();
