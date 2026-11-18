DO $contract$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag_name = 'reconcile_decide_v1') THEN
    RAISE EXCEPTION 'rollback must remove the reconcile_decide_v1 switch';
  END IF;
END;
$contract$;
