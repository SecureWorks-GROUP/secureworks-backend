DO $rollback$ BEGIN
  LOCK TABLE public.work_orders IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT FROM public.work_orders WHERE standard_max_hours IS NOT NULL) THEN
    RAISE EXCEPTION 'standard_maximum_work_orders_in_use' USING ERRCODE = '23514';
  END IF;
  ALTER TABLE public.work_orders DROP COLUMN standard_max_hours;
  DROP FUNCTION public.set_standard_hourly_maximum(uuid, text, numeric, numeric, uuid);
  DROP TABLE public.standard_hourly_maximums, public.standard_hourly_maximum_changes;
  DROP FUNCTION public.standard_hourly_maximum_changes_append_only();
END $rollback$;
