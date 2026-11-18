DO $$ BEGIN
  IF to_regprocedure('public.confirm_job_work_order_labour(uuid,uuid,numeric,uuid,uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'ZZTEST confirm write was not removed';
  END IF;
  IF to_regclass('public.job_work_order_labour_confirmations') IS NULL THEN
    RAISE EXCEPTION 'ZZTEST confirmation records must be kept';
  END IF;
  IF COALESCE((SELECT enabled FROM public.feature_flags
               WHERE flag_name = 'job_work_order_labour_confirm_v1'), false) THEN
    RAISE EXCEPTION 'ZZTEST switch must be off after rollback';
  END IF;
END $$;
