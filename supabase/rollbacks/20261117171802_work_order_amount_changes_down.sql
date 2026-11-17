DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.work_order_amount_changes) THEN RAISE EXCEPTION 'work_order_amount_changes_exist'; END IF;
END $$;
DROP FUNCTION IF EXISTS public.change_work_order_amount(uuid,numeric,text,uuid,uuid);
DROP FUNCTION IF EXISTS public.work_order_amount_change_total(uuid);
DROP TABLE IF EXISTS public.work_order_amount_changes;
DROP FUNCTION IF EXISTS public.work_order_amount_changes_immutable();
DELETE FROM public.feature_flags WHERE flag_name='work_order_amount_change_v1';
