-- Captain-gated rollback for 20260724005540_makesafe_board_truth_cutover.sql.
-- Removes only the display overlay and its audit. Operational job state was
-- never changed by the migration or RPC.

DROP FUNCTION IF EXISTS public.apply_makesafe_board_status(text, text, text, jsonb);
DROP VIEW IF EXISTS public.makesafe_board_status_current;
DROP TRIGGER IF EXISTS trg_makesafe_board_status_applications_insert_guard
  ON public.makesafe_board_status_applications;
DROP FUNCTION IF EXISTS public.guard_makesafe_board_status_application_insert();
DROP TRIGGER IF EXISTS trg_makesafe_board_status_applications_append_only
  ON public.makesafe_board_status_applications;
DROP FUNCTION IF EXISTS public.reject_makesafe_board_status_application_mutation();
DROP TABLE IF EXISTS public.makesafe_board_status_applications;
