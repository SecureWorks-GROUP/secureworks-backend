-- Reapply the real migration, then read back its only row.
\ir ../../../migrations/20261118194800_reconcile_decide_switch.sql
DO $contract$
BEGIN
  IF (SELECT count(*) FROM public.feature_flags WHERE flag_name = 'reconcile_decide_v1') <> 1 THEN
    RAISE EXCEPTION 'reconcile_decide_v1 must exist exactly once after reapply';
  END IF;
  IF (SELECT enabled FROM public.feature_flags WHERE flag_name = 'reconcile_decide_v1') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'reconcile_decide_v1 must ship off';
  END IF;
END;
$contract$;
