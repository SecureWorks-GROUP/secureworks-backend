DO $$ BEGIN
  IF to_regprocedure('public.approve_additional_work_order(uuid, uuid, text, timestamptz, uuid)') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='work_orders' AND column_name IN ('title','main_work_order_id','amount_change_id'))
     OR position('additional' IN pg_get_functiondef('public.job_cost_close(uuid[], date)'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'additional work orders rollback incomplete';
  END IF;
END $$;
