-- Undo 20261118999908 (placeholder version): drop the approver's door, the record trigger if
-- the director installed it, and its install and remove functions. The record itself
-- (work_order_cap_start_changes, append-only) is kept: who set the cap's start date is held
-- nowhere else. A re-apply finds it and keeps writing to it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP FUNCTION IF EXISTS public.set_work_order_cap_start(uuid, text, date, date, text);
DO $down$ BEGIN
  IF to_regclass('public.work_order_cap_settings') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS work_order_cap_settings_record ON public.work_order_cap_settings';
  END IF;
END $down$;
DROP FUNCTION IF EXISTS public.install_work_order_cap_start_record();
DROP FUNCTION IF EXISTS public.remove_work_order_cap_start_record();
DROP FUNCTION IF EXISTS public.work_order_cap_settings_record();
