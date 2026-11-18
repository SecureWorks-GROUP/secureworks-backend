-- Rollback of the reconcile_decide_v1 switch row.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DELETE FROM public.feature_flags WHERE flag_name = 'reconcile_decide_v1';
